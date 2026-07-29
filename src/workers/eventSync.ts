/**
 * Warm-path worker — port of backend/app/workers/event_sync.py.
 *
 * Every 120s: syncs event metadata (discovering ongoing events for the hot
 * poller), team lists + OPRs, playoff alliances, EPA (Statbotics), FRC Events
 * team data, avatars, and the regional advancement pool — all into Supabase.
 *
 * Deferred to M3 (needs summary_service): `_warm_event_connections` (step 4 of
 * the Python loop). Everything else is ported 1:1.
 */
import { getTbaClient } from '../services/tbaClient.js';
import { getFrcClient } from '../services/frcClient.js';
import { getEpaMap } from '../services/statboticsClient.js';
import { getAvatars } from '../services/avatarCache.js';
import {
  getSupabase,
  mergeEventTeams,
  upsertRows,
  type MergeRow,
} from '../services/supabase.js';
import { CircuitOpenError } from '../lib/circuitBreaker.js';
import { TBAEvent, TBATeam, validateList } from './schemas.js';
import { setActiveEvents, setEventTypes } from './pollerState.js';
import { getEventConnections } from '../services/connectionsService.js';
import * as payloadCache from '../lib/payloadCache.js';

const SYNC_INTERVAL_MS = 120_000; // between full sweeps (event_sync.py:26)
const EPA_STAGGER_MS = 5_000; // between per-event EPA calls (event_sync.py:27)

const DAY_MS = 86_400_000;

function stripNulls(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Invalidate disk-cached summary + awards payloads so they rebuild (event_sync.py:35). */
function invalidateSnapshot(eventKey: string): void {
  void payloadCache.invalidate('summary', eventKey).catch(() => undefined);
  void payloadCache.invalidate('awards', eventKey).catch(() => undefined);
}

/** Parse a YYYY-MM-DD date to a local-midnight epoch, or NaN. */
function parseDate(s: string | null | undefined): number {
  if (!s) return NaN;
  const t = Date.parse(`${s}T00:00:00`);
  return t;
}

/** 'upcoming' | 'ongoing' | 'completed' | 'unknown' (event_sync.py:51). */
function eventStatus(startDate: string | null | undefined, endDate: string | null | undefined): string {
  const sd = parseDate(startDate);
  const ed = parseDate(endDate);
  if (Number.isNaN(sd) || Number.isNaN(ed)) return 'unknown';
  const today = parseDate(new Date().toISOString().slice(0, 10));
  if (today > ed + DAY_MS) return 'completed';
  if (today >= sd) return 'ongoing';
  return 'upcoming';
}

// ── 1) Event metadata + ongoing discovery ───────────────────
async function syncEventMetadata(year: number): Promise<Set<string>> {
  const tba = getTbaClient();
  let rawEvents: unknown;
  try {
    rawEvents = await tba.getEventsByYear(year);
  } catch (err) {
    if (err instanceof CircuitOpenError) return new Set();
    console.warn(`Event metadata fetch failed: ${String(err)}`);
    return new Set();
  }

  const validEvents = validateList(TBAEvent, rawEvents, 'tba_events');
  if (validEvents.length === 0) return new Set();

  const ongoing = new Set<string>();
  const eventTypes: Record<string, number> = {};
  const rows: Record<string, unknown>[] = [];

  for (const ev of validEvents) {
    const etype = ev.event_type ?? -1;
    if (etype === -1 || etype === 100) continue; // junk types

    eventTypes[ev.key] = etype;
    const start = ev.start_date ?? '';
    const end = ev.end_date ?? '';
    const status = eventStatus(start, end);
    if (status === 'ongoing') ongoing.add(ev.key);

    const raw = ev as Record<string, unknown>;
    rows.push({
      event_key: ev.key,
      name: ev.name || 'Unknown Event',
      start_date: start || null,
      end_date: end || null,
      competition_type: 'frc',
      raw_data: {
        city: raw['city'] ?? '',
        state_prov: raw['state_prov'] ?? '',
        country: raw['country'] ?? '',
        event_type: etype,
        event_type_string: raw['event_type_string'] ?? '',
        district: raw['district'] ?? null,
        week: raw['week'] ?? null,
        short_name: raw['short_name'] ?? '',
        status,
      },
    });
  }

  if (rows.length) {
    try {
      await upsertRows('events', rows);
    } catch (err) {
      console.warn(`Supabase events upsert failed: ${String(err)}`);
    }
  }

  setEventTypes(eventTypes);
  return ongoing;
}

// ── 2) Teams + OPRs ─────────────────────────────────────────
interface OprsPayload {
  oprs?: Record<string, number>;
  dprs?: Record<string, number>;
  ccwms?: Record<string, number>;
}

async function syncTeamsAndOprs(eventKey: string): Promise<void> {
  const tba = getTbaClient();
  const [teamsRes, oprsRes] = await Promise.allSettled([
    tba.getEventTeamsFull<unknown>(eventKey),
    tba.getEventOprs<OprsPayload>(eventKey),
  ]);

  const teamsRaw = teamsRes.status === 'fulfilled' ? teamsRes.value : null;
  const validTeams = Array.isArray(teamsRaw)
    ? validateList(TBATeam, teamsRaw, `tba_teams:${eventKey}`)
    : [];

  if (validTeams.length) {
    const teamRows = validTeams.map((t) => {
      const raw = t as Record<string, unknown>;
      return {
        team_key: t.key,
        team_number: t.team_number ?? 0,
        nickname: t.nickname ?? '',
        competition_type: 'frc',
        raw_tims_data: {
          city: raw['city'] ?? '',
          state_prov: raw['state_prov'] ?? '',
          country: raw['country'] ?? '',
          school_name: raw['school_name'] ?? '',
          rookie_year: raw['rookie_year'] ?? null,
        },
      };
    });
    try {
      await upsertRows('teams', teamRows);
    } catch (err) {
      console.warn(`Supabase teams upsert failed for ${eventKey}: ${String(err)}`);
    }
  }

  // OPR lookup.
  const oprLookup: Record<string, Record<string, unknown>> = {};
  const oprs = oprsRes.status === 'fulfilled' ? oprsRes.value : null;
  if (oprs && typeof oprs === 'object') {
    const o = oprs.oprs ?? {};
    const d = oprs.dprs ?? {};
    const c = oprs.ccwms ?? {};
    for (const tkey of Object.keys(o)) {
      oprLookup[tkey] = { opr: o[tkey], dpr: d[tkey], ccwm: c[tkey] };
    }
  }

  if (validTeams.length) {
    // Seed event_teams rows so the merge has a row to merge into.
    const etSeed = validTeams.map((t) => ({
      event_key: eventKey,
      team_key: t.key,
      raw_data: {},
    }));
    try {
      await upsertRows('event_teams', etSeed);
    } catch {
      /* ignore */
    }

    const mergeRows: MergeRow[] = validTeams
      .filter((t) => oprLookup[t.key])
      .map((t) => ({
        event_key: eventKey,
        team_key: t.key,
        data: stripNulls(oprLookup[t.key]!),
      }));
    if (mergeRows.length) {
      try {
        await mergeEventTeams(mergeRows);
        invalidateSnapshot(eventKey);
      } catch (err) {
        console.warn(`event_teams OPR merge failed for ${eventKey}: ${String(err)}`);
      }
    }
  }
}

// ── 3) Playoff alliances → events.raw_data ──────────────────
async function syncAlliances(eventKey: string): Promise<void> {
  const tba = getTbaClient();
  let alliances: unknown;
  try {
    alliances = await tba.getEventAlliances(eventKey);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`Alliance fetch failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (!alliances || (Array.isArray(alliances) && alliances.length === 0)) return;

  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('events')
      .select('raw_data')
      .eq('event_key', eventKey);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return; // event row not created yet

    let currentRaw = data[0]!.raw_data ?? {};
    if (typeof currentRaw === 'string') currentRaw = JSON.parse(currentRaw);
    currentRaw.alliances = alliances;

    const { error: updErr } = await sb
      .from('events')
      .update({ raw_data: currentRaw })
      .eq('event_key', eventKey);
    if (updErr) throw new Error(updErr.message);
    invalidateSnapshot(eventKey);
  } catch (err) {
    console.warn(`Alliance upsert failed for ${eventKey}: ${String(err)}`);
  }
}

// ── 4) EPA (Statbotics) → event_teams.raw_data ──────────────
async function syncEpa(eventKey: string): Promise<void> {
  let epaMap: Record<string, Record<string, number>>;
  try {
    epaMap = await getEpaMap(eventKey);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`EPA fetch failed for ${eventKey}: ${String(err)}`);
    return;
  }
  const entries = Object.entries(epaMap).filter(([, epa]) => epa != null);
  if (entries.length === 0) return;

  const mergeRows: MergeRow[] = entries.map(([tk, epa]) => ({
    event_key: eventKey,
    team_key: tk,
    data: { epa: stripNulls(epa) },
  }));
  try {
    await mergeEventTeams(mergeRows);
    invalidateSnapshot(eventKey);
  } catch (err) {
    console.warn(`EPA merge failed for ${eventKey}: ${String(err)}`);
  }
}

// ── 5) FRC Events API team data → teams.frc_data ────────────
async function syncFrcTeamData(eventKey: string): Promise<void> {
  const frc = getFrcClient();
  const year = Number(eventKey.slice(0, 4));
  const eventCode = eventKey.slice(4);

  let frcTeams: Record<string, unknown>[];
  try {
    frcTeams = await frc.getEventTeams(year, eventCode);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`FRC team data fetch failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (frcTeams.length === 0) return;

  const rows: Record<string, unknown>[] = [];
  for (const ft of frcTeams) {
    const num = ft['teamNumber'] as number | undefined;
    if (!num) continue;
    rows.push({
      team_key: `frc${num}`,
      team_number: num,
      nickname: ft['nameShort'] ?? '',
      competition_type: 'frc',
      frc_data: {
        schoolName: ft['schoolName'] ?? '',
        nameShort: ft['nameShort'] ?? '',
        nameFull: ft['nameFull'] ?? '',
        city: ft['city'] ?? '',
        stateProv: ft['stateProv'] ?? '',
        country: ft['country'] ?? '',
        rookieYear: ft['rookieYear'] ?? null,
        website: ft['website'] ?? '',
      },
    });
  }

  if (rows.length) {
    try {
      await upsertRows('teams', rows);
    } catch (err) {
      console.warn(`FRC team data upsert failed for ${eventKey}: ${String(err)}`);
    }
  }
}

// ── 6) Avatars → team_avatars ───────────────────────────────
async function syncAvatars(eventKey: string): Promise<void> {
  const year = /^\d{4}/.test(eventKey) ? Number(eventKey.slice(0, 4)) : 2026;
  try {
    const sb = getSupabase();
    const { data: etRows } = await sb
      .from('event_teams')
      .select('team_key')
      .eq('event_key', eventKey);
    const teamKeys = (etRows ?? []).map((r) => r.team_key as string);
    if (teamKeys.length === 0) return;

    const { data: existingRows } = await sb
      .from('team_avatars')
      .select('team_key')
      .in('team_key', teamKeys)
      .eq('year', year);
    const existing = new Set((existingRows ?? []).map((r) => r.team_key as string));
    const missing = teamKeys.filter((tk) => !existing.has(tk));
    if (missing.length === 0) return;

    const avatarMap = await getAvatars(missing, year);
    const rows = Object.entries(avatarMap).map(([tk, b64]) => ({
      team_key: tk,
      year,
      avatar_base64: b64,
    }));
    if (rows.length) await upsertRows('team_avatars', rows);
  } catch (err) {
    console.warn(`Avatar sync failed for ${eventKey}: ${String(err)}`);
  }
}

// ── 7) Regional advancement pool (v3.2) ─────────────────────
async function syncRegionalPool(year: number, ongoing: Set<string>): Promise<void> {
  const frc = getFrcClient();
  const sb = getSupabase();

  try {
    const globalTeams = await frc.getRegionalPool(year);
    if (globalTeams.length) {
      await sb
        .from('regional_pool')
        .upsert(
          { year, event_key: null, payload: globalTeams },
          { onConflict: 'year,event_key' },
        );
    }
  } catch (err) {
    if (!(err instanceof CircuitOpenError)) {
      console.warn(`Global regional pool sync failed: ${String(err)}`);
    }
  }

  for (const ek of ongoing) {
    const eventCode = ek.slice(4);
    try {
      const detail = await frc.getRegionalPoolEvent(year, eventCode);
      if (detail && Object.keys(detail).length) {
        await sb
          .from('regional_pool')
          .upsert(
            { year, event_key: ek, payload: detail },
            { onConflict: 'year,event_key' },
          );
      }
    } catch (err) {
      if (!(err instanceof CircuitOpenError)) {
        console.warn(`Regional pool sync failed for ${ek}: ${String(err)}`);
      }
    }
  }
}

// ── Connections cache warming (event_sync.py:499) ───────────
const CONN_TTL = 3600; // seconds

/**
 * Ensure past-3yr (and, transitively, all-time) connections are cached.
 * Skips if the disk cache is already warm. getEventConnections handles the
 * Supabase → build-from-scratch fallback and kicks off the all-time
 * background warm itself.
 */
async function warmEventConnections(eventKey: string): Promise<void> {
  const cached = await payloadCache.readPayload('connections', eventKey, CONN_TTL);
  if (cached) return;
  try {
    await getEventConnections(eventKey, false);
  } catch (err) {
    console.debug(`Connections warm failed for ${eventKey}: ${String(err)}`);
  }
}

// ── Main loop ───────────────────────────────────────────────
let _running = false;
let _wakeup: (() => void) | null = null;

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _wakeup = null;
      resolve();
    }, ms);
    _wakeup = () => {
      clearTimeout(timer);
      _wakeup = null;
      resolve();
    };
  });
}

async function loop(year: number): Promise<void> {
  console.info(`Event sync started (year=${year}, interval=${SYNC_INTERVAL_MS / 1000}s)`);

  while (_running) {
    try {
      // 1) Metadata + ongoing discovery.
      const ongoing = await syncEventMetadata(year);
      setActiveEvents(ongoing);
      if (ongoing.size) console.info(`Active events: ${[...ongoing].sort().join(', ')}`);

      // 2) Per-event seed sync, staggered across a 30s window.
      if (ongoing.size) {
        const eventList = [...ongoing];
        const n = eventList.length;
        const stagger = n > 1 ? 30_000 / n : 0;
        await Promise.allSettled(
          eventList.map(async (ek, i) => {
            if (stagger) await sleep(i * stagger);
            if (!_running) return; // bail promptly on shutdown
            await Promise.allSettled([
              syncTeamsAndOprs(ek),
              syncAlliances(ek),
              syncFrcTeamData(ek),
              syncAvatars(ek),
            ]);
          }),
        );
      }

      // EPA — one event at a time with a stagger so 6 events don't burst Statbotics.
      let i = 0;
      for (const ek of ongoing) {
        if (!_running) break; // bail promptly on shutdown
        if (i > 0) await sleep(EPA_STAGGER_MS);
        i += 1;
        try {
          await syncEpa(ek);
        } catch (err) {
          console.warn(`EPA sync failed for ${ek}: ${String(err)}`);
        }
      }

      // 3) Regional pool — once per sweep.
      if (_running) await syncRegionalPool(year, ongoing);

      // 4) Warm connections cache for ongoing events (non-blocking background tasks).
      for (const ek of ongoing) void warmEventConnections(ek);
    } catch (err) {
      console.error(`Event sync sweep error: ${String(err)}`);
    }

    if (_running) await interruptibleSleep(SYNC_INTERVAL_MS);
  }
  console.info('Event sync stopped');
}

/** Start the event-sync worker. Returns a stop function (cancel + drain). */
export function startEventSync(year?: number): () => Promise<void> {
  if (_running) return stopEventSync;
  _running = true;
  const done = loop(year ?? new Date().getFullYear());
  return async () => {
    await stopEventSync();
    await done;
  };
}

async function stopEventSync(): Promise<void> {
  _running = false;
  if (_wakeup) _wakeup();
}

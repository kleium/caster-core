/**
 * FTC event-sync task functions — port of the `_sync_ftc_*` helpers in
 * backend/app/workers/ftc_event_sync.py. Split out from ftcEventSync.ts (the
 * main loop) to keep each file focused and short.
 */
import { getFtcClient } from '../services/ftcClient.js';
import { getFtcscoutClient } from '../services/ftcscoutClient.js';
import { getSupabase, mergeEventTeams, upsertRows, type MergeRow } from '../services/supabase.js';
import { CircuitOpenError } from '../lib/circuitBreaker.js';
import { parseFtcKey } from '../lib/ftcKey.js';
import * as payloadCache from '../lib/payloadCache.js';
import { FTCEvent, FTCTeam, FTCRanking, validateList } from './schemas.js';

type Obj = Record<string, any>;

function stripNulls(d: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** Clear disk caches so they rebuild on next read (ftc_event_sync.py:37). */
export function invalidateFtcSnapshot(eventKey: string): void {
  void payloadCache.invalidate('summary', eventKey).catch(() => undefined);
  void payloadCache.invalidate('connections', eventKey).catch(() => undefined);
  void payloadCache.invalidate('connections', `${eventKey}_all`).catch(() => undefined);
}

/** 'upcoming' | 'ongoing' | 'completed' | 'unknown' (ftc_event_sync.py:48). */
function eventStatus(startStr: string | null | undefined, endStr: string | null | undefined): string {
  const today = new Date().toISOString().slice(0, 10);
  const sd = startStr ? startStr.slice(0, 10) : today;
  const ed = endStr ? endStr.slice(0, 10) : today;
  const sdMs = Date.parse(`${sd}T00:00:00`);
  const edMs = Date.parse(`${ed}T00:00:00`);
  if (Number.isNaN(sdMs) || Number.isNaN(edMs)) return 'unknown';
  const todayMs = Date.parse(`${today}T00:00:00`);
  if (todayMs > edMs + 86_400_000) return 'completed';
  if (todayMs >= sdMs) return 'ongoing';
  return 'upcoming';
}

// ── 1) Event metadata → discover ongoing/recently-completed ─
export interface MetadataResult {
  ongoing: Set<string>;
  recentlyCompleted: Set<string>;
}

/**
 * Fetch all FTC events for `season`, upsert into `events`. Returns
 * (ongoing, recentlyCompleted) — the latter ended within the last 7 days, so
 * team identity gets one more re-sync pass (FTC teams often finish profile
 * setup after their event). ftc_event_sync.py:66.
 */
export async function syncFtcEventMetadata(
  season: number,
  currentActive: Set<string>,
): Promise<MetadataResult> {
  const client = getFtcClient();
  let rawEvents: Obj[];
  try {
    rawEvents = await client.getEvents(season);
  } catch (err) {
    if (err instanceof CircuitOpenError) return { ongoing: currentActive, recentlyCompleted: new Set() };
    console.warn(`FTC event metadata fetch failed: ${String(err)}`);
    return { ongoing: currentActive, recentlyCompleted: new Set() };
  }

  const validEvents = validateList(FTCEvent, rawEvents, 'ftc_events');
  if (validEvents.length === 0) {
    console.warn('All FTC events failed validation — skipping');
    return { ongoing: currentActive, recentlyCompleted: new Set() };
  }

  const ongoing = new Set<string>();
  const recentlyCompleted = new Set<string>();
  const rows: Obj[] = [];
  const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00`);

  for (const ev of validEvents) {
    const code = ev.code ?? '';
    if (!code) continue;
    const eventKey = `${season}ftc${code}`.toLowerCase();
    const start = ev.dateStart ?? '';
    const end = ev.dateEnd ?? '';
    const status = eventStatus(start, end);

    if (status === 'ongoing') {
      ongoing.add(eventKey);
    } else if (status === 'completed' && end) {
      const edMs = Date.parse(`${end.slice(0, 10)}T00:00:00`);
      if (!Number.isNaN(edMs) && (todayMs - edMs) / 86_400_000 <= 7) {
        recentlyCompleted.add(eventKey);
      }
    }

    const raw = ev as Obj;
    rows.push({
      event_key: eventKey,
      name: ev.name ?? code,
      start_date: start ? start.slice(0, 10) : null,
      end_date: end ? end.slice(0, 10) : null,
      competition_type: 'ftc',
      raw_data: stripNulls({
        code,
        type: raw.type ?? null,
        typeName: raw.typeName ?? null,
        regionCode: raw.regionCode ?? null,
        leagueCode: raw.leagueCode ?? null,
        divisionCode: raw.divisionCode ?? null,
        city: raw.city ?? null,
        stateprov: raw.stateprov ?? null,
        country: raw.country ?? null,
        venue: raw.venue ?? null,
        address: raw.address ?? null,
        website: raw.website ?? null,
        status,
      }),
    });
  }

  if (rows.length) {
    try {
      await upsertRows('events', rows);
    } catch (err) {
      console.warn(`FTC event metadata upsert failed: ${String(err)}`);
    }
  }

  return { ongoing, recentlyCompleted };
}

// ── 2) Teams → teams + event_teams ───────────────────────────
export async function syncFtcTeams(eventKey: string): Promise<void> {
  const client = getFtcClient();
  const [year, eventCode] = parseFtcKey(eventKey);

  let rawTeams: Obj[];
  try {
    rawTeams = await client.getEventTeams(year, eventCode);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`FTC team fetch failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (rawTeams.length === 0) return;

  const validTeams = validateList(FTCTeam, rawTeams, `ftc_teams:${eventKey}`);
  if (validTeams.length === 0) return;

  const teamRows: Obj[] = [];
  const etRows: Obj[] = [];
  for (const t of validTeams) {
    const num = t.teamNumber;
    if (!num) continue;
    const teamKey = `ftc${num}`;
    const raw = t as Obj;

    teamRows.push({
      team_key: teamKey,
      team_number: num,
      nickname: t.nameShort || t.nameFull || '',
      competition_type: 'ftc',
      raw_tims_data: stripNulls({
        full_name: t.nameFull ?? null,
        city: raw.city ?? null,
        state_prov: raw.stateprov ?? raw.stateProv ?? null,
        country: raw.country ?? null,
        school_name: raw.schoolName ?? null,
        rookie_year: raw.rookieYear ?? null,
      }),
    });
    etRows.push({ event_key: eventKey, team_key: teamKey });
  }

  if (teamRows.length) {
    try {
      await upsertRows('teams', teamRows);
    } catch (err) {
      console.warn(`FTC teams upsert failed for ${eventKey}: ${String(err)}`);
    }
  }
  if (etRows.length) {
    try {
      await upsertRows('event_teams', etRows);
    } catch (err) {
      console.warn(`FTC event_teams upsert failed for ${eventKey}: ${String(err)}`);
    }
  }
}

// ── 3) FTC Scout stats → event_teams.raw_data ────────────────
export async function syncFtcStats(eventKey: string): Promise<void> {
  const [year, eventCode] = parseFtcKey(eventKey);
  const scout = getFtcscoutClient();

  let stats: Obj[];
  try {
    stats = await scout.getEventTeamStats(year, eventCode);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`FTC Scout stats fetch failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (stats.length === 0) return;

  const rows: MergeRow[] = [];
  const stubTeamRows: Obj[] = [];
  for (const s of stats) {
    const num = s.team_number;
    if (!num) continue;
    const teamKey = `ftc${num}`;
    // FTC Scout may return teams not in the FTC Events API roster — stub them
    // so the event_teams FK constraint is satisfied. Omit nickname so this
    // upsert never overwrites the real one set by syncFtcTeams.
    stubTeamRows.push({ team_key: teamKey, team_number: num, competition_type: 'ftc' });
    rows.push({
      event_key: eventKey,
      team_key: teamKey,
      data: stripNulls({
        opr_total: s.opr_total,
        opr_auto: s.opr_auto,
        opr_dc: s.opr_dc,
        opr_np: s.opr_np,
        avg_total: s.avg_total,
        avg_auto: s.avg_auto,
        avg_dc: s.avg_dc,
        avg_np: s.avg_np,
        max_total: s.max_total,
        max_auto: s.max_auto,
        max_dc: s.max_dc,
        min_total: s.min_total,
        dev_total: s.dev_total,
        quick_stats: s.quick_stats,
        rp: s.rp,
        tb1: s.tb1,
        wins: s.wins,
        losses: s.losses,
        ties: s.ties,
        qual_matches_played: s.qual_matches_played,
      }),
    });
  }

  if (stubTeamRows.length) {
    try {
      await upsertRows('teams', stubTeamRows);
    } catch (err) {
      console.warn(`FTC Scout stub teams upsert failed for ${eventKey}: ${String(err)}`);
    }
  }
  if (rows.length) {
    try {
      await mergeEventTeams(rows);
    } catch (err) {
      console.warn(`FTC Scout stats merge failed for ${eventKey}: ${String(err)}`);
    }
  }
}

// ── 4) Rankings → event_teams.raw_data ───────────────────────
export async function syncFtcRankings(eventKey: string): Promise<void> {
  const client = getFtcClient();
  const [year, eventCode] = parseFtcKey(eventKey);

  let rankings: Obj[];
  try {
    rankings = await client.getRankings(year, eventCode);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`FTC rankings fetch failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (rankings.length === 0) return;

  const valid = validateList(FTCRanking, rankings, `ftc_rankings:${eventKey}`);
  if (valid.length === 0) return;

  const rows: MergeRow[] = [];
  for (const r of valid) {
    const num = r.teamNumber;
    if (!num) continue;
    rows.push({
      event_key: eventKey,
      team_key: `ftc${num}`,
      data: stripNulls({
        rank: r.rank,
        wins: r.wins ?? 0,
        losses: r.losses ?? 0,
        ties: r.ties ?? 0,
        qual_average: r.qualAverage,
        sort_orders: r.sortOrders,
        matches_played: r.matchesPlayed ?? 0,
        dq: r.dq ?? 0,
      }),
    });
  }

  if (rows.length) {
    try {
      await mergeEventTeams(rows);
      invalidateFtcSnapshot(eventKey);
    } catch (err) {
      console.warn(`FTC rankings merge failed for ${eventKey}: ${String(err)}`);
    }
  }
}

// ── 5) Playoff alliances → events.raw_data ───────────────────
export async function syncFtcAlliances(eventKey: string): Promise<void> {
  const client = getFtcClient();
  const [year, eventCode] = parseFtcKey(eventKey);

  let alliances: Obj[];
  try {
    alliances = await client.getAlliances(year, eventCode);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`FTC alliances fetch failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (alliances.length === 0) return;

  try {
    const sb = getSupabase();
    const { data, error } = await sb.from('events').select('raw_data').eq('event_key', eventKey);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return; // event row not created yet

    let currentRaw = data[0]!.raw_data ?? {};
    if (typeof currentRaw === 'string') currentRaw = JSON.parse(currentRaw);
    currentRaw.alliances = alliances;

    const { error: updErr } = await sb.from('events').update({ raw_data: currentRaw }).eq('event_key', eventKey);
    if (updErr) throw new Error(updErr.message);
  } catch (err) {
    console.warn(`FTC alliances upsert failed for ${eventKey}: ${String(err)}`);
  }
}

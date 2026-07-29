/**
 * Ingestion Engine — on-demand event ingestion into Supabase, port of the
 * FRC portion of backend/app/services/ingestion_service.py.
 *
 * When a user loads an event for the first time (no snapshot cache hit), the
 * server calls `ingestEvent(eventKey)`, which fetches metadata/teams/rankings/
 * OPRs/EPA/matches/alliances from TBA/FRC/Statbotics and normalizes them into
 * Supabase, then registers the event for live polling if ongoing.
 *
 * Note: several JSONB fields here are written as JSON-encoded STRINGS
 * (`JSON.stringify(...)`), matching ingestion_service.py's own convention for
 * this file specifically — downstream readers already handle both string- and
 * object-encoded forms (see `asObject()` in eventService.ts et al.).
 */
import { getTbaClient } from './tbaClient.js';
import { getFrcClient } from './frcClient.js';
import { getEpaMap } from './statboticsClient.js';
import { getSupabase, upsertRows } from './supabase.js';
import { prefetchAvatars } from './avatarCache.js';
import { getEventSummary } from './summaryService.js';
import { addWatchedEvent, setEventTypes } from '../workers/pollerState.js';
import { CircuitOpenError } from '../lib/circuitBreaker.js';

type Obj = Record<string, any>;

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CircuitOpenError) return null;
    return null;
  }
}

// Track which events have been ingested this process's lifetime.
const ingestedEvents = new Set<string>();

function eventStatus(startStr: string | null | undefined, endStr: string | null | undefined): string {
  const sd = Date.parse(`${startStr ?? ''}T00:00:00`);
  const ed = Date.parse(`${endStr ?? ''}T00:00:00`);
  if (Number.isNaN(sd) || Number.isNaN(ed)) return 'unknown';
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00`);
  if (today > ed + 86_400_000) return 'completed';
  if (today >= sd) return 'ongoing';
  return 'upcoming';
}

// ── is_ingested (ingestion_service.py:59) ─────────────────────
export async function isIngested(eventKey: string): Promise<boolean> {
  if (ingestedEvents.has(eventKey)) return true;
  try {
    const sb = getSupabase();
    const [teamsResp, matchesResp] = await Promise.all([
      sb.from('event_teams').select('event_key').eq('event_key', eventKey).limit(1),
      sb.from('matches').select('match_key').eq('event_key', eventKey).limit(1),
    ]);
    if ((teamsResp.data?.length ?? 0) > 0 && (matchesResp.data?.length ?? 0) > 0) {
      ingestedEvents.add(eventKey);
      return true;
    }
  } catch {
    /* fall through to false */
  }
  return false;
}

// ── ingest_event (ingestion_service.py:87) ────────────────────
export async function ingestEvent(eventKey: string): Promise<string> {
  const tba = getTbaClient();
  const frc = getFrcClient();
  const year = Number(eventKey.slice(0, 4));
  const eventCode = eventKey.slice(4);

  // ── 1. Event metadata (TBA) ──────────────────────────────
  const eventRaw = await tba.getEvent<Obj>(eventKey);
  if (!eventRaw) throw new Error(`TBA returned no data for event '${eventKey}'`);

  const start = eventRaw.start_date ?? '';
  const end = eventRaw.end_date ?? '';
  const status = eventStatus(start, end);

  await upsertRows('events', [
    {
      event_key: eventKey,
      name: eventRaw.name ?? '',
      start_date: start || null,
      end_date: end || null,
      competition_type: 'frc',
      raw_data: JSON.stringify({
        city: eventRaw.city ?? '',
        state_prov: eventRaw.state_prov ?? '',
        country: eventRaw.country ?? '',
        event_type: eventRaw.event_type ?? -1,
        event_type_string: eventRaw.event_type_string ?? '',
        district: eventRaw.district ?? null,
        week: eventRaw.week ?? null,
        short_name: eventRaw.short_name ?? '',
        status,
      }),
    },
  ]);

  // ── 2. Teams + OPRs + EPA + Rankings (parallel) ──────────
  const [teamsRaw, oprsRaw, epaMap, rankingsRaw] = await Promise.all([
    safe(() => tba.getEventTeamsFull<Obj[]>(eventKey)),
    safe(() => tba.getEventOprs<Obj>(eventKey)),
    safe(() => getEpaMap(eventKey)),
    safe(() => frc.getRankings(year, eventCode)),
  ]);

  if (teamsRaw) {
    const teamRows = teamsRaw.map((t) => ({
      team_key: t.key,
      team_number: t.team_number ?? 0,
      nickname: t.nickname ?? '',
      competition_type: 'frc',
      raw_tims_data: JSON.stringify({
        city: t.city ?? '',
        state_prov: t.state_prov ?? '',
        country: t.country ?? '',
        rookie_year: t.rookie_year ?? null,
        school_name: t.school_name ?? '',
      }),
    }));
    await upsertRows('teams', teamRows);
  }

  const oprLookup: Record<string, Obj> = {};
  if (oprsRaw && typeof oprsRaw === 'object') {
    for (const tk of Object.keys(oprsRaw.oprs ?? {})) {
      oprLookup[tk] = {
        opr: oprsRaw.oprs?.[tk],
        dpr: oprsRaw.dprs?.[tk],
        ccwm: oprsRaw.ccwms?.[tk],
      };
    }
  }

  const rankLookup: Record<string, Obj> = {};
  if (rankingsRaw) {
    for (const r of rankingsRaw as Obj[]) {
      const tn = r.teamNumber;
      if (!tn) continue;
      let sortOrders = r.sortOrders;
      if (!sortOrders) {
        const so: unknown[] = [];
        for (let i = 1; i <= 6; i += 1) {
          const v = r[`sortOrder${i}`];
          if (v !== null && v !== undefined) so.push(v);
        }
        sortOrders = so.length ? so : null;
      }
      rankLookup[`frc${tn}`] = {
        rank: r.rank,
        wins: r.wins ?? 0,
        losses: r.losses ?? 0,
        ties: r.ties ?? 0,
        qual_average: r.qualAverage,
        sort_orders: sortOrders,
        matches_played: r.matchesPlayed ?? 0,
        dq: r.dq ?? 0,
      };
    }
  }

  if (teamsRaw) {
    const etRows = teamsRaw.map((t) => {
      const tk = t.key as string;
      const data: Obj = { ...(oprLookup[tk] ?? {}), ...(rankLookup[tk] ?? {}) };
      if (epaMap && typeof epaMap === 'object' && tk in epaMap) {
        data.epa = (epaMap as Obj)[tk];
      }
      return { event_key: eventKey, team_key: tk, raw_data: JSON.stringify(data) };
    });
    await upsertRows('event_teams', etRows);
  }

  // ── 3. Matches (TBA format) ──────────────────────────────
  const matchesRaw = await safe(() => tba.getEventMatches<Obj[]>(eventKey));
  if (matchesRaw) {
    const matchRows = matchesRaw.map((m) => {
      const mk = m.key ?? '';
      const cl = m.comp_level ?? 'qm';
      const red = m.alliances?.red ?? {};
      const blue = m.alliances?.blue ?? {};
      const rs = red.score ?? -1;
      const bs = blue.score ?? -1;

      let mstatus: string;
      if (rs != null && rs >= 0 && bs != null && bs >= 0) mstatus = 'completed';
      else if (m.actual_time) mstatus = 'in_progress';
      else mstatus = 'upcoming';

      const rawTime = m.time ?? m.predicted_time;
      let scheduledIso: string | null = null;
      if (rawTime != null && typeof rawTime === 'number') {
        scheduledIso = new Date(rawTime * 1000).toISOString();
      }

      return {
        match_key: mk,
        event_key: eventKey,
        comp_level: cl,
        match_number: m.match_number ?? 0,
        set_number: m.set_number ?? 1,
        status: mstatus,
        alliances: JSON.stringify({
          red: { score: rs != null ? rs : -1, team_keys: red.team_keys ?? [] },
          blue: { score: bs != null ? bs : -1, team_keys: blue.team_keys ?? [] },
        }),
        score_breakdown: JSON.stringify(m.score_breakdown ?? {}),
        scheduled_time: scheduledIso,
        raw_data: JSON.stringify(m),
      };
    });
    await upsertRows('matches', matchRows);
  }

  // ── 4. Alliances → events.raw_data ───────────────────────
  const alliancesRaw = await safe(() => tba.getEventAlliances<Obj[]>(eventKey));
  if (alliancesRaw && alliancesRaw.length) {
    try {
      const sb = getSupabase();
      const { data } = await sb.from('events').select('raw_data').eq('event_key', eventKey);
      let currentRaw: Obj = {};
      if (data && data.length && data[0]!.raw_data) {
        currentRaw = data[0]!.raw_data;
        if (typeof currentRaw === 'string') currentRaw = JSON.parse(currentRaw);
      }
      currentRaw.alliances = alliancesRaw;
      await upsertRows('events', [{ event_key: eventKey, raw_data: JSON.stringify(currentRaw) }]);
    } catch (e) {
      console.warn(`Alliance storage failed for ${eventKey}: ${String(e)}`);
    }
  }

  // ── 5. Pre-warm caches (avatars + summary) ───────────────
  const teamKeys = teamsRaw ? teamsRaw.map((t) => t.key as string) : [];
  if (teamKeys.length) {
    try {
      await prefetchAvatars(teamKeys, year);
    } catch (e) {
      console.warn(`Avatar prefetch failed for ${eventKey}: ${String(e)}`);
    }
  }

  try {
    await getEventSummary(eventKey);
  } catch (e) {
    console.warn(`Summary pre-compute failed for ${eventKey}: ${String(e)}`);
  }

  // ── 6. Register for live polling if ongoing ──────────────
  if (status === 'ongoing') {
    setEventTypes({ [eventKey]: eventRaw.event_type ?? -1 });
    addWatchedEvent(eventKey);
  }

  ingestedEvents.add(eventKey);
  return status;
}

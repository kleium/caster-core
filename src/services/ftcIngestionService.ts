/**
 * FTC on-demand ingestion — port of the FTC portion of
 * backend/app/services/ingestion_service.py (is_ftc_ingested/ingest_ftc_event).
 *
 * Reuses the same sync task functions the ftc_event_sync worker uses
 * (workers/ftcEventSyncTasks.ts) and the match poller's per-event poll
 * (workers/ftcMatchPoller.ts) — ingestion is just "run those once, right now,
 * for one event" instead of waiting for the next 120s/5s sweep.
 */
import { getFtcClient } from './ftcClient.js';
import { getSupabase, upsertRows } from './supabase.js';
import {
  syncFtcTeams,
  syncFtcAlliances,
  syncFtcStats,
  syncFtcRankings,
} from '../workers/ftcEventSyncTasks.js';
import { pollFtcMatches } from '../workers/ftcMatchPoller.js';
import { addWatchedFtcEvent } from '../workers/ftcPollerState.js';

type Obj = Record<string, any>;

async function safe(promise: Promise<void>): Promise<void> {
  try {
    await promise;
  } catch {
    /* non-fatal — ingestion proceeds best-effort per step */
  }
}

function stripNulls(d: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** 'upcoming' | 'ongoing' | 'completed' | 'unknown'. Mirrors ingestion_service.py:_event_status. */
function eventStatus(startStr: string | null | undefined, endStr: string | null | undefined): string {
  const sd = startStr ? startStr.slice(0, 10) : '';
  const ed = endStr ? endStr.slice(0, 10) : '';
  const sdMs = Date.parse(`${sd}T00:00:00`);
  const edMs = Date.parse(`${ed}T00:00:00`);
  if (Number.isNaN(sdMs) || Number.isNaN(edMs)) return 'unknown';
  const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00`);
  if (todayMs > edMs + 86_400_000) return 'completed';
  if (todayMs >= sdMs) return 'ongoing';
  return 'upcoming';
}

// Track which FTC events have been ingested this process's lifetime.
const ingestedFtcEvents = new Set<string>();

/**
 * Check whether an FTC event already has team data in Supabase. Only checks
 * `event_teams` (not matches) — upcoming events have no matches yet. Requires
 * a row with non-null `raw_data`: pure FK-stub rows (created before
 * stats/rankings arrive) must not block a full ingest. ingestion_service.py:323.
 */
export async function isFtcIngested(eventKey: string): Promise<boolean> {
  if (ingestedFtcEvents.has(eventKey)) return true;
  try {
    const sb = getSupabase();
    const { data } = await sb
      .from('event_teams')
      .select('event_key')
      .eq('event_key', eventKey)
      .not('raw_data', 'is', null)
      .limit(1);
    if (data && data.length) {
      ingestedFtcEvents.add(eventKey);
      return true;
    }
  } catch {
    /* fall through to false */
  }
  return false;
}

/** Parse '2025ftcXYZ' → [2025, 'XYZ'] (local copy matching ingestion_service.py's own inline parse). */
function parseFtcKeyLocal(eventKey: string): [number, string] {
  const key = eventKey.toLowerCase();
  const idx = key.indexOf('ftc');
  if (idx !== -1) return [Number(key.slice(0, idx)), key.slice(idx + 3).toUpperCase()];
  return [Number(eventKey.slice(0, 4)), eventKey.slice(4).toUpperCase()];
}

/**
 * One-shot full ingestion of an FTC event into Supabase. Returns the computed
 * event status. ingestion_service.py:354.
 */
export async function ingestFtcEvent(eventKey: string): Promise<string> {
  const [year, eventCode] = parseFtcKeyLocal(eventKey);
  const ftc = getFtcClient();

  // ── 1. Event metadata ────────────────────────────────────
  const ev = await ftc.getEvent(year, eventCode);
  if (!ev) throw new Error(`FTC API returned no data for event '${eventKey}'`);

  const start = ev.dateStart ?? '';
  const end = ev.dateEnd ?? '';
  const status = eventStatus(start ? start.slice(0, 10) : null, end ? end.slice(0, 10) : null);

  await upsertRows('events', [
    {
      event_key: eventKey,
      name: ev.name ?? eventCode,
      start_date: start ? start.slice(0, 10) : null,
      end_date: end ? end.slice(0, 10) : null,
      competition_type: 'ftc',
      raw_data: stripNulls({
        code: eventCode,
        type: ev.type ?? null,
        typeName: ev.typeName ?? null,
        regionCode: ev.regionCode ?? null,
        leagueCode: ev.leagueCode ?? null,
        divisionCode: ev.divisionCode ?? null,
        city: ev.city ?? null,
        stateprov: ev.stateprov ?? null,
        country: ev.country ?? null,
        venue: ev.venue ?? null,
        website: ev.website ?? null,
        status,
      }),
    },
  ]);

  // ── 2. Teams + alliances (seed first, no merge contention) ──
  await Promise.all([safe(syncFtcTeams(eventKey)), safe(syncFtcAlliances(eventKey))]);

  // ── 3. Stats + rankings (merge-heavy, sequential) ────────
  await safe(syncFtcStats(eventKey));
  await safe(syncFtcRankings(eventKey));

  // ── 4. Initial match data ────────────────────────────────
  try {
    await pollFtcMatches(eventKey);
  } catch (e) {
    console.warn(`FTC initial match poll failed for ${eventKey}: ${String(e)}`);
  }

  // ── 5. Register for live polling if ongoing ──────────────
  if (status === 'ongoing') {
    addWatchedFtcEvent(eventKey);
  }

  ingestedFtcEvents.add(eventKey);
  return status;
}

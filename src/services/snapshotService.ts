/**
 * GET /api/events/{event_key}/snapshot — cached full-event payload. Port of
 * backend/app/routers/snapshot.py (FRC portion).
 *
 * Bundles info/teams/matches/alliances/playoffs/summary into one response.
 * Disk-cached with a two-tier TTL: fresh (<30min) serves directly; stale
 * (30min-2hr) serves immediately and rebuilds in the background; expired
 * (>2hr) forces a synchronous rebuild. Cold misses (no Supabase data yet)
 * run a full on-demand ingest first.
 */
import { readSnapshot, writeSnapshot } from '../lib/snapshotCache.js';
import { coalesce } from '../lib/inflight.js';
import { getEventInfo, getEventTeamsWithStats } from './eventService.js';
import { getAllMatches, getPlayoffMatches } from './matchesService.js';
import { getAlliancesWithStats } from './allianceService.js';
import { getEventSummary } from './summaryService.js';
import { isIngested, ingestEvent } from './ingestionService.js';

type Obj = Record<string, any>;

export { invalidateSnapshot } from '../lib/snapshotCache.js';
export { writeSnapshot } from '../lib/snapshotCache.js';

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/** Assemble a full snapshot by calling the existing service layer. snapshot.py:87. */
export async function buildSnapshot(eventKey: string): Promise<Obj> {
  const [info, teams, matchesData, alliances, playoffs, summary] = await Promise.all([
    getEventInfo(eventKey),
    getEventTeamsWithStats(eventKey),
    getAllMatches(eventKey),
    safe(getAlliancesWithStats(eventKey)),
    safe(getPlayoffMatches(eventKey)),
    safe(getEventSummary(eventKey)),
  ]);

  return {
    event_key: eventKey,
    info,
    teams,
    matches: matchesData,
    alliances,
    playoffs,
    summary,
  };
}

/** Rebuild snapshot in background (stale-while-revalidate). snapshot.py:133. */
function backgroundRebuild(eventKey: string): void {
  void (async () => {
    try {
      const payload = await coalesce(`snapshot_build:${eventKey}`, buildSnapshot as never, eventKey as never);
      await writeSnapshot(eventKey, payload as Obj);
    } catch {
      /* logged upstream via console in buildSnapshot's own callees; non-fatal here */
    }
  })();
}

/** Cold-miss path: ensure ingestion, then build the snapshot. snapshot.py:149. */
async function ingestAndBuild(eventKey: string): Promise<Obj> {
  if (!(await isIngested(eventKey))) {
    await ingestEvent(eventKey);
  }
  const payload = await buildSnapshot(eventKey);
  await writeSnapshot(eventKey, payload);
  return payload;
}

/** GET /api/events/{event_key}/snapshot handler logic. snapshot.py:163. */
export async function getEventSnapshot(eventKey: string): Promise<Obj> {
  // Fast path: serve from disk cache.
  const { data: cached, fresh } = await readSnapshot(eventKey);
  if (cached && fresh) {
    cached._cached = true;
    return cached;
  }

  // Stale-while-revalidate.
  if (cached && !fresh) {
    backgroundRebuild(eventKey);
    cached._cached = true;
    cached._stale = true;
    return cached;
  }

  // Cold miss — single-flight the whole ingest + build.
  const { data: cachedAgain } = await readSnapshot(eventKey);
  if (cachedAgain) {
    cachedAgain._cached = true;
    return cachedAgain;
  }

  const payload = await coalesce(`snapshot_build:${eventKey}`, ingestAndBuild as never, eventKey as never);
  const result = { ...(payload as Obj) };
  result._cached = false;
  return result;
}

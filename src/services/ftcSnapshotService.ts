/**
 * GET /api/ftc/events/{event_key}/snapshot — cached full-event payload. Port
 * of the FTC portion (`ftc_router`) of backend/app/routers/snapshot.py.
 *
 * Same two-tier disk-cache TTL as the FRC snapshot (shared via
 * lib/snapshotCache.ts): fresh serves directly, stale serves immediately and
 * rebuilds in the background, expired forces a synchronous rebuild. Cold
 * misses run a full on-demand FTC ingest first.
 */
import { readSnapshot, writeSnapshot } from '../lib/snapshotCache.js';
import { coalesce } from '../lib/inflight.js';
import { getEventInfo, getEventTeamsWithStats, getAlliances } from './ftcEventService.js';
import { getAllMatches, getPlayoffMatches } from './ftcMatchesService.js';
import { isFtcIngested, ingestFtcEvent } from './ftcIngestionService.js';
import { addWatchedFtcEvent } from '../workers/ftcPollerState.js';

type Obj = Record<string, any>;

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/** Assemble a full FTC snapshot from the service layer. snapshot.py:212. */
async function buildFtcSnapshot(eventKey: string): Promise<Obj> {
  const [info, teams, matchesData, alliances, playoffs] = await Promise.all([
    getEventInfo(eventKey),
    getEventTeamsWithStats(eventKey),
    safe(getAllMatches(eventKey)),
    safe(getAlliances(eventKey)),
    safe(getPlayoffMatches(eventKey)),
  ]);

  return {
    event_key: eventKey,
    info,
    teams,
    matches: matchesData,
    alliances,
    playoffs,
    summary: null,
  };
}

/** Rebuild snapshot in background (stale-while-revalidate). snapshot.py:265. */
function backgroundRebuild(eventKey: string): void {
  void (async () => {
    try {
      const payload = await coalesce(
        `snapshot_build:${eventKey}`,
        buildFtcSnapshot as never,
        eventKey as never,
      );
      await writeSnapshot(eventKey, payload as Obj);
    } catch {
      /* logged upstream via console in buildFtcSnapshot's own callees; non-fatal here */
    }
  })();
}

/**
 * Cold-miss path: ensure ingestion, then build the snapshot. If the warm
 * ftc_event_sync worker already populated Supabase, ingest is skipped and the
 * event is just registered for live polling. snapshot.py:241.
 */
async function ftcIngestAndBuild(eventKey: string): Promise<Obj> {
  if (!(await isFtcIngested(eventKey))) {
    await ingestFtcEvent(eventKey);
  } else {
    addWatchedFtcEvent(eventKey);
  }
  const payload = await buildFtcSnapshot(eventKey);
  await writeSnapshot(eventKey, payload);
  return payload;
}

/** GET /api/ftc/events/{event_key}/snapshot handler logic. snapshot.py:277. */
export async function getFtcEventSnapshot(eventKey: string): Promise<Obj> {
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

  const payload = await coalesce(
    `snapshot_build:${eventKey}`,
    ftcIngestAndBuild as never,
    eventKey as never,
  );
  const result = { ...(payload as Obj) };
  result._cached = false;
  return result;
}

/**
 * Warm-path FTC worker — port of backend/app/workers/ftc_event_sync.py.
 *
 * Every 120s: syncs event metadata (discovering ongoing events for the hot
 * poller), teams, playoff alliances, FTC Scout stats, and rankings into
 * Supabase. Mirrors eventSync.ts (FRC); the individual sync steps live in
 * ftcEventSyncTasks.ts to keep this file to just the orchestration loop.
 *
 * Deferred: `_warm_ftc_event_connections` (needs ftc_event_service's
 * connections builder — an M4c+ read-layer slice, same deferral pattern as
 * FRC's M2→M3g).
 */
import { setFtcActiveEvents } from './ftcPollerState.js';
import { currentFtcSeason } from '../lib/ftcSeason.js';
import {
  syncFtcEventMetadata,
  syncFtcTeams,
  syncFtcStats,
  syncFtcRankings,
  syncFtcAlliances,
} from './ftcEventSyncTasks.js';

const SYNC_INTERVAL_MS = 120_000; // between sweeps (ftc_event_sync.py:22)

/** FTC API uses kickoff-year seasons (season 2025 = 2025-2026 season). */

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

async function loop(season: number): Promise<void> {
  console.info(`FTC event sync started (season=${season}, interval=${SYNC_INTERVAL_MS / 1000}s)`);
  let active = new Set<string>();

  while (_running) {
    try {
      // 1) Metadata + ongoing/recently-completed discovery.
      const { ongoing, recentlyCompleted } = await syncFtcEventMetadata(season, active);
      active = ongoing;
      setFtcActiveEvents(ongoing);
      if (ongoing.size) console.info(`Active FTC events: ${[...ongoing].sort().join(', ')}`);

      // 2) Teams + alliances for ongoing events (upsert-only, parallel);
      //    teams-only re-sync for recently-completed events (profile updates
      //    often land after the event ends).
      if (!_running) break;
      const seedTasks: Promise<void>[] = [];
      for (const ek of ongoing) {
        seedTasks.push(syncFtcTeams(ek));
        seedTasks.push(syncFtcAlliances(ek));
      }
      for (const ek of recentlyCompleted) {
        if (!ongoing.has(ek)) seedTasks.push(syncFtcTeams(ek));
      }
      if (seedTasks.length) await Promise.allSettled(seedTasks);

      // 3) Merge-heavy stats + rankings — one event at a time.
      for (const ek of ongoing) {
        if (!_running) break;
        try {
          await syncFtcStats(ek);
        } catch (err) {
          console.warn(`FTC stats sync failed for ${ek}: ${String(err)}`);
        }
        try {
          await syncFtcRankings(ek);
        } catch (err) {
          console.warn(`FTC rankings sync failed for ${ek}: ${String(err)}`);
        }
      }

      // 4) Connections cache warming — deferred to M4c+ (needs ftc_event_service).
    } catch (err) {
      console.error(`FTC event sync sweep error: ${String(err)}`);
    }

    if (_running) await interruptibleSleep(SYNC_INTERVAL_MS);
  }
  console.info('FTC event sync stopped');
}

/** Start the FTC event-sync worker. Returns a stop function (cancel + drain). */
export function startFtcEventSync(season?: number): () => Promise<void> {
  if (_running) return stopFtcEventSync;
  _running = true;
  const done = loop(season ?? currentFtcSeason());
  return async () => {
    await stopFtcEventSync();
    await done;
  };
}

async function stopFtcEventSync(): Promise<void> {
  _running = false;
  if (_wakeup) _wakeup();
}

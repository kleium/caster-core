/**
 * Shared FTC poller state — port of the module-level globals in
 * backend/app/workers/ftc_match_poller.py (lines 48-68) and the
 * `_ftc_active_events` piece of ftc_event_sync.py.
 *
 * ⚠️ Process-local, like the FRC poller state — deploy as a single process.
 */

const WATCHED_TTL_MS = 7_200_000; // 2h (ftc_match_poller.py:51)

let _ftcActiveEvents: Set<string> = new Set();
const _watchedFtcEvents = new Map<string, number>(); // event_key → last-access ms

/** Called by ftc_event_sync when it discovers ongoing events (ftc_event_sync.py). */
export function setFtcActiveEvents(keys: Set<string>): void {
  _ftcActiveEvents = keys;
}

export function getFtcActiveEvents(): Set<string> {
  return _ftcActiveEvents;
}

/** Register a user-loaded FTC event for ongoing polling (ftc_match_poller.py:54). */
export function addWatchedFtcEvent(eventKey: string): void {
  _watchedFtcEvents.set(eventKey, Date.now());
}

/** Active + user-watched events, pruning expired watched entries (ftc_match_poller.py:60). */
export function getFtcPollEvents(): Set<string> {
  const now = Date.now();
  for (const [k, ts] of _watchedFtcEvents) {
    if (now - ts > WATCHED_TTL_MS) _watchedFtcEvents.delete(k);
  }
  return new Set([..._ftcActiveEvents, ..._watchedFtcEvents.keys()]);
}

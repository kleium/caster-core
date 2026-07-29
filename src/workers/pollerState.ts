/**
 * Shared poller state — port of the module-level globals in
 * backend/app/workers/match_poller.py (lines 53-91).
 *
 * ⚠️ Process-local, like the Python original: this state assumes a SINGLE
 * process. Running multiple Node processes would give each its own disconnected
 * active-event set and caches. Deploy as one process (see README).
 */

const OFFSEASON_TYPE = 99; // TBA event_type for offseason events (match_poller.py:29)
const WATCHED_TTL_MS = 7200_000; // 2h — prune events not re-requested (match_poller.py:56)

let _activeEventKeys: Set<string> = new Set();
const _watchedEventKeys = new Map<string, number>(); // event_key → last-access ms
const _eventTypes = new Map<string, number>(); // event_key → TBA event_type

/** Called by event_sync when it discovers ongoing events (match_poller.py:61). */
export function setActiveEvents(keys: Set<string>): void {
  _activeEventKeys = keys;
}

/** Record each event's TBA event_type so the poller knows FRC-API vs TBA (match_poller.py:67). */
export function setEventTypes(mapping: Record<string, number>): void {
  for (const [k, v] of Object.entries(mapping)) _eventTypes.set(k, v);
}

/** Register a user-loaded event for ongoing polling (match_poller.py:73). */
export function addWatchedEvent(eventKey: string): void {
  _watchedEventKeys.set(eventKey, Date.now());
}

/** True if this event is TBA-only (never in the FRC Events API) — match_poller.py:79. */
export function isOffseason(eventKey: string): boolean {
  return _eventTypes.get(eventKey) === OFFSEASON_TYPE;
}

/** Active + watched events, pruning expired watched entries (match_poller.py:85). */
export function getActiveEvents(): Set<string> {
  const now = Date.now();
  for (const [k, ts] of _watchedEventKeys) {
    if (now - ts > WATCHED_TTL_MS) _watchedEventKeys.delete(k);
  }
  return new Set([..._activeEventKeys, ..._watchedEventKeys.keys()]);
}

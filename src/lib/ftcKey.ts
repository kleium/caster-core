/**
 * Shared FTC event-key parser — port of `_parse_ftc_key` (duplicated in both
 * ftc_match_poller.py and ftc_event_sync.py in Python "to avoid circular
 * imports"; Node has no such constraint, so this lives in one place).
 */

/** Parse '2025ftcXYZ' → [2025, 'XYZ']. */
export function parseFtcKey(eventKey: string): [number, string] {
  const key = eventKey.toLowerCase();
  const idx = key.indexOf('ftc');
  if (idx !== -1) {
    return [Number(key.slice(0, idx)), key.slice(idx + 3).toUpperCase()];
  }
  return [Number(eventKey.slice(0, 4)), eventKey.slice(4).toUpperCase()];
}

/**
 * TBA short code → FRC Events API event code for championship divisions.
 * Without this, "2026arc" would send "ARC" to FIRST, which 404s.
 * Port of `_TBA_TO_FRC_EVENT_CODE` in backend/app/routers/matches.py.
 */
const TBA_TO_FRC_EVENT_CODE: Record<string, string> = {
  arc: 'ARCHIMEDES',
  car: 'CARSON',
  cur: 'CURIE',
  dal: 'DALY',
  dar: 'DARWIN',
  ein: 'EINSTEIN',
  gal: 'GALILEO',
  haw: 'HAWKING',
  hop: 'HOPPER',
  joh: 'JOHNSON',
  mil: 'MILSTEIN',
  new: 'NEWTON',
  tur: 'TURING',
};

/** Map a raw TBA event-code suffix to the FRC Events API code. */
export function toFrcEventCode(rawCode: string): string {
  return TBA_TO_FRC_EVENT_CODE[rawCode.toLowerCase()] ?? rawCode.toUpperCase();
}

/** FRC comp-level → tournamentLevel. matches.py:_COMP_LEVEL_TO_FRC. */
export const COMP_LEVEL_TO_FRC: Record<string, string> = {
  qm: 'Qualification',
  qf: 'Playoff',
  sf: 'Playoff',
  ef: 'Playoff',
  f: 'Playoff',
};

/** Split a TBA event key like "2026week0" into [2026, "WEEK0"]. matches.py:_tba_key_to_frc. */
export function tbaKeyToFrc(eventKey: string): [number, string] {
  const m = /^(\d{4})(.*)/.exec(eventKey);
  if (!m) throw new RangeError(`Bad event key: ${eventKey}`);
  return [Number(m[1]), m[2]!.toUpperCase()];
}

/**
 * Single-match score breakdown with per-robot mapping — port of
 * `get_match_breakdown` / `_breakdown_from_frc` / `_breakdown_from_tba` in
 * backend/app/routers/matches.py.
 *
 * 2026+ prefers the FRC Events API (instant); older games prefer TBA (which
 * carries reef/coral detail). Whichever is primary, the other is tried as a
 * secondary when the first reports unavailable.
 */
import { getFrcClient } from './frcClient.js';
import { getTbaClient } from './tbaClient.js';
import { toFrcEventCode, COMP_LEVEL_TO_FRC } from '../lib/frcEventCodes.js';
import { parserFor } from '../lib/allianceBreakdown.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

/** FRC Events API path. matches.py:_breakdown_from_frc. */
async function breakdownFromFrc(matchKey: string, gameYear: number): Promise<Obj> {
  // TBA keys: {year}{event}_qm{n} | _sf{set}m{n} | _f{set}m{n}
  const m = /^(\d{4})(\w+?)_([a-z]+)(\d+)(?:m(\d+))?$/.exec(matchKey);
  if (!m) return { match_key: matchKey, available: false };

  const season = Number(m[1]);
  const eventCode = toFrcEventCode(m[2]!);
  const compLevel = m[3]!;
  const firstNum = Number(m[4]);
  const secondNum = m[5] ? Number(m[5]) : null;

  const frcLevel = COMP_LEVEL_TO_FRC[compLevel] ?? 'Qualification';

  let frcMatchNumber: number | null;
  let tbaSetNumber: number;
  let tbaMatchNumber: number;
  if (compLevel === 'qm') {
    frcMatchNumber = firstNum;
    tbaSetNumber = 0;
    tbaMatchNumber = firstNum;
  } else if (compLevel === 'f') {
    // The grand final sits after the 13 double-elim sets, so its FRC
    // matchNumber is typically 14+ — resolved from descriptions below.
    frcMatchNumber = null;
    tbaSetNumber = firstNum;
    tbaMatchNumber = secondNum ?? 1;
  } else {
    // sf/qf/ef: firstNum is the TBA set_number, which equals the FRC
    // matchNumber for double-elim; secondNum is match-within-set (replay).
    frcMatchNumber = firstNum;
    tbaSetNumber = firstNum;
    tbaMatchNumber = secondNum ?? 1;
  }

  const frc = getFrcClient();
  const [scoresList, matchesList] = await Promise.all([
    frc.getScores(season, eventCode, frcLevel, {
      matchNumber: frcMatchNumber, // null for finals → fetch all
      bypassCache: true,
    }),
    frc.getMatches(season, eventCode, { level: frcLevel, bypassCache: true }),
  ]);

  if (compLevel === 'f') {
    const finalMatches = (matchesList as Obj[])
      .filter((mr) => {
        const d = String(pyOr(mr.description, '')).toLowerCase();
        return d.includes('final') && !d.includes('semi');
      })
      .sort((a, b) => (pyGet(a, 'matchNumber', 0) as number) - (pyGet(b, 'matchNumber', 0) as number));
    const finalIdx = tbaMatchNumber - 1;
    if (finalIdx < finalMatches.length) {
      frcMatchNumber = finalMatches[finalIdx]!.matchNumber;
    } else {
      return { match_key: matchKey, available: false };
    }
  }

  const scoreEntry = (scoresList as Obj[]).find((s) => s.matchNumber === frcMatchNumber) ?? null;
  if (!scoreEntry || !pyGet(scoreEntry, 'alliances', undefined)) {
    return { match_key: matchKey, available: false };
  }

  const matchResult = (matchesList as Obj[]).find((mr) => mr.matchNumber === frcMatchNumber) ?? null;

  // Team keys ordered by station (Red1, Red2, Red3).
  let redKeys: string[] = [];
  let blueKeys: string[] = [];
  if (matchResult) {
    const red: [string, string][] = [];
    const blue: [string, string][] = [];
    for (const t of (pyGet(matchResult, 'teams', []) ?? []) as Obj[]) {
      const station = pyGet(t, 'station', '') as string;
      const tk = `frc${t.teamNumber}`;
      if (station.startsWith('Red')) red.push([station, tk]);
      else blue.push([station, tk]);
    }
    const byStation = (a: [string, string], b: [string, string]) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    redKeys = red.sort(byStation).map(([, tk]) => tk);
    blueKeys = blue.sort(byStation).map(([, tk]) => tk);
  }

  let redData: Obj | null = null;
  let blueData: Obj | null = null;
  for (const a of (pyGet(scoreEntry, 'alliances', []) ?? []) as Obj[]) {
    if (a.alliance === 'Red') redData = a;
    else if (a.alliance === 'Blue') blueData = a;
  }
  if (!redData || !blueData) return { match_key: matchKey, available: false };

  const redScore = pyGet(redData, 'totalPoints', 0) as number;
  const blueScore = pyGet(blueData, 'totalPoints', 0) as number;
  let winningAlliance = '';
  const wa = scoreEntry.winningAlliance;
  if (wa === 1) winningAlliance = 'red';
  else if (wa === 2) winningAlliance = 'blue';
  else if (redScore > blueScore) winningAlliance = 'red';
  else if (blueScore > redScore) winningAlliance = 'blue';

  const parse = parserFor(gameYear);

  return {
    match_key: matchKey,
    available: true,
    game_year: gameYear,
    comp_level: compLevel,
    match_number: tbaMatchNumber,
    set_number: tbaSetNumber,
    red: { score: redScore, team_keys: redKeys, breakdown: parse(redData, redKeys) },
    blue: { score: blueScore, team_keys: blueKeys, breakdown: parse(blueData, blueKeys) },
    winning_alliance: winningAlliance,
  };
}

/** TBA path (may lag 20-30s behind FIRST). matches.py:_breakdown_from_tba. */
async function breakdownFromTba(matchKey: string, gameYear: number): Promise<Obj> {
  const client = getTbaClient();
  const match = await client.get<Obj>(`/match/${matchKey}`, { bypassCache: true });

  const sb = match.score_breakdown;
  if (!sb) return { match_key: matchKey, available: false };

  const redKeys = (pyGet(match.alliances.red, 'team_keys', []) ?? []) as string[];
  const blueKeys = (pyGet(match.alliances.blue, 'team_keys', []) ?? []) as string[];
  const parse = parserFor(gameYear);

  return {
    match_key: matchKey,
    available: true,
    game_year: gameYear,
    comp_level: pyGet(match, 'comp_level', ''),
    match_number: pyGet(match, 'match_number', 0),
    set_number: pyGet(match, 'set_number', 0),
    red: {
      score: pyGet(match.alliances.red, 'score', -1),
      team_keys: redKeys,
      breakdown: parse((pyGet(sb, 'red', {}) ?? {}) as Obj, redKeys),
    },
    blue: {
      score: pyGet(match.alliances.blue, 'score', -1),
      team_keys: blueKeys,
      breakdown: parse((pyGet(sb, 'blue', {}) ?? {}) as Obj, blueKeys),
    },
    winning_alliance: pyGet(match, 'winning_alliance', ''),
  };
}

/** GET /api/matches/match/{match_key}/breakdown. matches.py:get_match_breakdown. */
export async function getMatchBreakdown(matchKey: string): Promise<Obj> {
  const yearMatch = /^(\d{4})/.exec(matchKey);
  const gameYear = yearMatch ? Number(yearMatch[1]) : 2025;
  const primary = gameYear >= 2026 ? breakdownFromFrc : breakdownFromTba;
  const secondary = gameYear >= 2026 ? breakdownFromTba : breakdownFromFrc;

  try {
    const result = await primary(matchKey, gameYear);
    // TBA often has data for completed events the FRC API no longer surfaces.
    if (!result.available) {
      try {
        const alt = await secondary(matchKey, gameYear);
        if (alt.available) return alt;
      } catch {
        /* keep the primary's unavailable result */
      }
    }
    return result;
  } catch (e) {
    // Primary threw — fall back to the other source before giving up.
    return await secondary(matchKey, gameYear).catch(() => {
      throw e;
    });
  }
}

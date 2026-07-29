/**
 * Live score fast-path — lightweight score fetch straight from the FRC Events
 * API so the frontend can merge fresh scores into existing play-by-play data
 * without re-pulling the full match list from TBA.
 *
 * Port of `get_fast_scores` in backend/app/routers/matches.py.
 */
import { getFrcClient } from './frcClient.js';
import { toFrcEventCode } from '../lib/frcEventCodes.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export async function getFastScores(eventKey: string): Promise<Obj> {
  const year = Number(eventKey.slice(0, 4));
  const eventCode = toFrcEventCode(eventKey.slice(4));
  const frc = getFrcClient();

  const [qualMatches, playoffMatches] = await Promise.all([
    safe(frc.getMatches(year, eventCode, { level: 'Qualification', bypassCache: true })),
    safe(frc.getMatches(year, eventCode, { level: 'Playoff', bypassCache: true })),
  ]);

  const allFrc = [...(qualMatches ?? []), ...(playoffMatches ?? [])] as Obj[];

  // FRC numbers finals sequentially (14, 15, …) but TBA uses f1m1, f1m2 — so
  // map by sorted order within the finals, not by raw matchNumber.
  const finalMatchNumbers = ((playoffMatches ?? []) as Obj[])
    .filter((mr) => {
      const d = String(pyOr(mr.description, '')).toLowerCase();
      return d.includes('final') && !d.includes('semi');
    })
    .map((mr) => pyGet(mr, 'matchNumber', 0) as number)
    .sort((a, b) => a - b);
  const finalIndexMap = new Map<number, number>();
  finalMatchNumbers.forEach((mn, idx) => finalIndexMap.set(mn, idx + 1));

  const results: Obj[] = [];
  for (const m of allFrc) {
    const level = pyGet(m, 'tournamentLevel', 'Qualification') as string;
    const mn = pyGet(m, 'matchNumber', 0) as number;

    let matchKey: string;
    if (level === 'Qualification') {
      matchKey = `${eventKey}_qm${mn}`;
    } else {
      const desc = String(pyOr(m.description, '')).toLowerCase();
      if (desc.includes('final') && !desc.includes('semi')) {
        matchKey = `${eventKey}_f1m${finalIndexMap.get(mn) ?? mn}`;
      } else {
        matchKey = `${eventKey}_sf${pyGet(m, 'matchNumber', mn)}m1`;
      }
    }

    // Python: `m.get("scoreRedFinal", -1) or -1` — a null/0 score becomes -1.
    const redScore = pyOr(pyGet(m, 'scoreRedFinal', -1), -1) as number;
    const blueScore = pyOr(pyGet(m, 'scoreBlueFinal', -1), -1) as number;

    let winning = '';
    if (redScore >= 0 && blueScore >= 0) {
      if (redScore > blueScore) winning = 'red';
      else if (blueScore > redScore) winning = 'blue';
    }

    results.push({
      key: matchKey,
      red_score: redScore ?? -1,
      blue_score: blueScore ?? -1,
      winning_alliance: winning,
    });
  }

  return { event_key: eventKey, scores: results };
}

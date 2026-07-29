/**
 * Cross-season FTC playoff head-to-head between two teams — port of
 * `get_ftc_head_to_head` in backend/app/services/ftc_event_service.py.
 *
 * FTC Events API data starts at 2019; the default window is the past 3
 * seasons, `allTime` widens it to 2019→current.
 */
import { getFtcClient } from './ftcClient.js';
import { parseFtcBracketLabel } from './ftcMatchesService.js';
import { currentFtcSeason } from '../lib/ftcSeason.js';
import { Semaphore } from '../lib/semaphore.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

const FTC_FIRST_SEASON = 2019;

export async function getFtcHeadToHead(
  teamA: number,
  teamB: number,
  allTime = false,
  seasons = 3,
): Promise<Obj> {
  const client = getFtcClient();
  const current = currentFtcSeason();

  const yearRange: number[] = [];
  const start = allTime ? FTC_FIRST_SEASON : Math.max(FTC_FIRST_SEASON, current - seasons + 1);
  for (let y = start; y <= current; y += 1) yearRange.push(y);

  const sem = new Semaphore(6);
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> =>
    sem.run(async () => {
      try {
        return await fn();
      } catch {
        return null;
      }
    });

  const results: Obj[] = [];

  for (const checkYear of yearRange) {
    // Find common events by pulling each team's matches and taking event codes.
    const [matchesARaw, matchesBRaw] = await Promise.all([
      safe(() => client.getMatches(checkYear, '', { teamNumber: teamA })),
      safe(() => client.getMatches(checkYear, '', { teamNumber: teamB })),
    ]);
    const matchesA = (matchesARaw ?? []) as Obj[];
    const matchesB = (matchesBRaw ?? []) as Obj[];

    const eventsA = new Set(matchesA.map((m) => m.eventCode).filter(Boolean));
    const eventsB = new Set(matchesB.map((m) => m.eventCode).filter(Boolean));
    const commonEvents = [...eventsA].filter((c) => eventsB.has(c));
    if (!commonEvents.length) continue;

    const allEvents = await safe(() => client.getEvents(checkYear));
    const eventNames: Record<string, string> = {};
    for (const ev of (allEvents ?? []) as Obj[]) {
      const code = pyGet(ev, 'code', '') as string;
      eventNames[code] = pyGet(ev, 'name', code) as string;
    }

    for (const evCode of commonEvents) {
      const playoff = await safe(() => client.getScheduleHybrid(checkYear, evCode, 'playoff'));
      if (!playoff || !playoff.length) continue;

      for (const m of playoff as Obj[]) {
        const teamsIn = (pyGet(m, 'teams', []) ?? []) as Obj[];
        const redNums = new Set(
          teamsIn
            .filter((t) => String(pyOr(t.station, '')).startsWith('Red'))
            .map((t) => pyGet(t, 'teamNumber', 0) as number),
        );
        const blueNums = new Set(
          teamsIn
            .filter((t) => String(pyOr(t.station, '')).startsWith('Blue'))
            .map((t) => pyGet(t, 'teamNumber', 0) as number),
        );

        const aRed = redNums.has(teamA);
        const aBlue = blueNums.has(teamA);
        const bRed = redNums.has(teamB);
        const bBlue = blueNums.has(teamB);
        if ((!aRed && !aBlue) || (!bRed && !bBlue)) continue;

        const redScore = m.scoreRedFinal ?? null;
        const blueScore = m.scoreBlueFinal ?? null;
        const matchNum = pyGet(m, 'matchNumber', 0) as number;
        const series = pyGet(m, 'series', 1) as number;
        const desc = pyGet(m, 'description', '') as string;
        const { label } = parseFtcBracketLabel(desc, series, matchNum);

        let winnerAlliance = '';
        if (redScore !== null && blueScore !== null) {
          if (redScore > blueScore) winnerAlliance = 'red';
          else if (blueScore > redScore) winnerAlliance = 'blue';
        }

        const sortedNums = (s: Set<number>) =>
          [...s].sort((x, y) => x - y).filter(Boolean).map((n) => String(n));

        const base = {
          event_key: `${checkYear}ftc${evCode.toLowerCase()}`,
          event_name: pyGet(eventNames, evCode, evCode),
          match_key: `${checkYear}ftc${evCode}_${series}m${matchNum}`,
          match_label: label,
          comp_level: label,
          year: checkYear,
          red_teams: sortedNums(redNums),
          blue_teams: sortedNums(blueNums),
          red_score: pyOr(redScore, 0),
          blue_score: pyOr(blueScore, 0),
        };

        if ((aRed && bBlue) || (aBlue && bRed)) {
          const aSide = aRed ? 'red' : 'blue';
          const aWon = winnerAlliance === aSide;
          results.push({
            ...base,
            winner: aWon ? String(teamA) : winnerAlliance ? String(teamB) : 'tie',
            relationship: 'opponents',
          });
        } else if ((aRed && bRed) || (aBlue && bBlue)) {
          const side = aRed && bRed ? 'red' : 'blue';
          results.push({
            ...base,
            winner: winnerAlliance === side ? 'both' : 'neither',
            relationship: 'allies',
          });
        }
      }
    }
  }

  const opp = results.filter((r) => r.relationship === 'opponents');
  const ally = results.filter((r) => r.relationship === 'allies');
  const aWins = opp.filter((r) => r.winner === String(teamA)).length;
  const bWins = opp.filter((r) => r.winner === String(teamB)).length;

  const teamNicknames: Record<string, string> = {};
  for (const tn of [teamA, teamB]) {
    const info = await safe(() => client.getTeamInfo(currentFtcSeason(), tn));
    if (info) {
      const name = pyOr((info as Obj).nameShort, pyOr((info as Obj).nameFull, '')) as string;
      if (name) teamNicknames[String(tn)] = name;
    }
  }

  return {
    team_a: teamA,
    team_b: teamB,
    opponent_matches: opp,
    ally_matches: ally,
    h2h_summary: {
      total_opponent_matches: opp.length,
      team_a_wins: aWins,
      team_b_wins: bWins,
      total_ally_matches: ally.length,
    },
    years_checked: yearRange,
    all_time: allTime,
    team_nicknames: teamNicknames,
  };
}

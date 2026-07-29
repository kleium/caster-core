/**
 * Batch awards summary + two-team head-to-head history — port of the
 * `get_awards_summary` / `get_head_to_head` half of
 * backend/app/services/team_service.py.
 *
 * (Highest-stage-of-play and season achievements live in teamStatsService.ts.)
 */
import { getTbaClient } from './tbaClient.js';
import { pyGet, pyTruthy } from '../lib/pysemantics.js';
import { COMP_LEVEL_LABELS } from '../lib/compLevels.js';

type Obj = Record<string, any>;

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

const BLUE_BANNER_TYPES = new Set([0, 1, 3]);
const OFFSEASON_TYPES = new Set([99, 100, -1]);

/**
 * Blue-banner count + recent (last 3 seasons) awards for a batch of teams,
 * keyed by team number as a string. team_service.py:505.
 */
export async function getAwardsSummary(teamNumbers: number[]): Promise<Obj> {
  const client = getTbaClient();
  const currentYear = new Date().getFullYear();
  const recentCutoff = currentYear - 3;

  const fetchTeam = async (num: number): Promise<Obj> => {
    const teamKey = `frc${num}`;
    const [allAwards, allEventsSimple] = await Promise.all([
      safe(client.getTeamAwards<Obj[]>(teamKey)),
      safe(client.getTeamEventsSimple<Obj[]>(teamKey)),
    ]);

    const eventNameMap: Record<string, string> = {};
    const eventTypeMap: Record<string, number> = {};
    if (pyTruthy(allEventsSimple)) {
      for (const ev of allEventsSimple!) {
        eventNameMap[ev.key] = pyGet(ev, 'name', ev.key) as string;
        eventTypeMap[ev.key] = pyGet(ev, 'event_type', -1) as number;
      }
    }

    const blueBanners: Obj[] = [];
    const recentAwards: Obj[] = [];

    if (pyTruthy(allAwards)) {
      for (const aw of allAwards!) {
        const awType = aw.award_type;
        const awYear = aw.year;
        const awEvent = pyGet(aw, 'event_key', '') as string;
        const isBanner =
          BLUE_BANNER_TYPES.has(awType) &&
          !OFFSEASON_TYPES.has(pyGet(eventTypeMap, awEvent, -1) as number);
        const entry = {
          name: pyGet(aw, 'name', ''),
          year: awYear,
          event_key: awEvent,
          event_name: pyGet(eventNameMap, awEvent, awEvent),
          is_blue_banner: isBanner,
        };
        if (isBanner) blueBanners.push(entry);
        if (awYear && awYear >= recentCutoff) recentAwards.push(entry);
      }
    }

    // Newest first. Python's list.sort is stable, as is Array.prototype.sort.
    recentAwards.sort((a, b) => (pyGet(b, 'year', 0) as number) - (pyGet(a, 'year', 0) as number));

    return {
      team_number: num,
      blue_banner_count: blueBanners.length,
      blue_banners: blueBanners,
      recent_awards: recentAwards,
    };
  };

  const results = await Promise.all(teamNumbers.map((n) => fetchTeam(n)));
  const out: Obj = {};
  for (const r of results) out[String(r.team_number)] = r;
  return out;
}

/** Format a match code into a readable label. team_service.py:598. */
function matchLabel(compLevel: string, matchNum: number, setNum: number): string {
  const short: Record<string, string> = { ef: 'R1', qf: 'R2', sf: 'R3', f: 'F' };
  const prefix = short[compLevel] ?? compLevel.toUpperCase();
  if (compLevel === 'f') return `Final ${matchNum}`;
  return `${prefix} ${setNum}-${matchNum}`;
}

/**
 * Every playoff match where two teams faced each other (or allied).
 * team_service.py:574.
 */
export async function getHeadToHead(
  teamA: number,
  teamB: number,
  year?: number | null,
  allTime = false,
): Promise<Obj> {
  const client = getTbaClient();
  const keyA = `frc${teamA}`;
  const keyB = `frc${teamB}`;
  const resolvedYear = year ?? new Date().getFullYear();

  let yearRange: number[];
  if (allTime) {
    const [yearsA, yearsB] = await Promise.all([
      safe(client.getTeamYearsParticipated<number[]>(keyA)),
      safe(client.getTeamYearsParticipated<number[]>(keyB)),
    ]);
    const allYears = [...new Set([...(yearsA ?? []), ...(yearsB ?? [])])].sort((a, b) => a - b);
    const startYear = allYears.length ? allYears[0]! : resolvedYear - 2;
    yearRange = [];
    for (let y = startYear; y <= resolvedYear; y += 1) yearRange.push(y);
  } else {
    yearRange = [resolvedYear - 2, resolvedYear - 1, resolvedYear];
  }

  const results: Obj[] = [];

  for (const checkYear of yearRange) {
    const [eventsA, eventsB] = await Promise.all([
      safe(client.getTeamEvents<Obj[]>(keyA, checkYear)),
      safe(client.getTeamEvents<Obj[]>(keyB, checkYear)),
    ]);
    if (!pyTruthy(eventsA) || !pyTruthy(eventsB)) continue;

    const ekA: Record<string, Obj> = {};
    for (const e of eventsA!) ekA[e.key] = e;
    const ekB: Record<string, Obj> = {};
    for (const e of eventsB!) ekB[e.key] = e;
    const common = Object.keys(ekA).filter((k) => k in ekB);

    const eventNameMap: Record<string, string> = {};
    for (const ekKey of common) {
      const ev = ekA[ekKey] ?? ekB[ekKey];
      eventNameMap[ekKey] = ev ? (pyGet(ev, 'name', ekKey) as string) : ekKey;
    }

    for (const ek of common) {
      const matches = await safe(client.getEventMatches<Obj[]>(ek));
      if (!pyTruthy(matches)) continue;

      for (const m of matches!) {
        if (m.comp_level === 'qm') continue; // playoffs only

        const red: string[] = m.alliances?.red?.team_keys ?? [];
        const blue: string[] = m.alliances?.blue?.team_keys ?? [];
        const aRed = red.includes(keyA);
        const aBlue = blue.includes(keyA);
        const bRed = red.includes(keyB);
        const bBlue = blue.includes(keyB);

        if ((!aRed && !aBlue) || (!bRed && !bBlue)) continue;

        const winner = pyGet(m, 'winning_alliance', '') as string;
        const base = {
          event_key: ek,
          event_name: pyGet(eventNameMap, ek, ek),
          match_key: m.key,
          match_label: matchLabel(m.comp_level, pyGet(m, 'match_number', 0) as number, pyGet(m, 'set_number', 0) as number),
          comp_level: pyGet(COMP_LEVEL_LABELS, m.comp_level, m.comp_level),
          year: checkYear,
          red_teams: red.map((tk) => tk.replace('frc', '')),
          blue_teams: blue.map((tk) => tk.replace('frc', '')),
          red_score: pyGet(m.alliances.red, 'score', 0),
          blue_score: pyGet(m.alliances.blue, 'score', 0),
        };

        if ((aRed && bBlue) || (aBlue && bRed)) {
          const aSide = aRed ? 'red' : 'blue';
          const aWon = winner === aSide;
          results.push({
            ...base,
            winner: aWon ? String(teamA) : winner ? String(teamB) : 'tie',
            relationship: 'opponents',
          });
        } else if ((aRed && bRed) || (aBlue && bBlue)) {
          const side = aRed && bRed ? 'red' : 'blue';
          results.push({
            ...base,
            winner: winner === side ? 'both' : 'neither',
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

  const allNums = new Set<string>();
  for (const r of results) {
    for (const n of r.red_teams) allNums.add(n);
    for (const n of r.blue_teams) allNums.add(n);
  }

  const nickResults = await Promise.all(
    [...allNums].map(async (num): Promise<[string, string]> => {
      const info = await safe(client.getTeam<Obj>(`frc${num}`));
      return [num, info ? (pyGet(info, 'nickname', '') as string) : ''];
    }),
  );
  const teamNicknames: Record<string, string> = {};
  for (const [n, nick] of nickResults) {
    if (nick) teamNicknames[n] = nick;
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

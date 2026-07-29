/**
 * FTC match read layer — port of get_all_matches / get_playoff_matches from
 * backend/app/services/ftc_event_service.py.
 *
 * Reads team identity/rankings/OPR and the match schedule from Supabase first
 * (populated by ftc_event_sync + ftc_match_poller); falls back to the FTC
 * Events API + FTC Scout on a cold miss.
 */
import { getFtcClient } from './ftcClient.js';
import { getFtcscoutClient } from './ftcscoutClient.js';
import { readEvent, readEventTeamsFull, readMatches } from './supabase.js';
import { parseFtcKey } from '../lib/ftcKey.js';
import { pyRound } from '../lib/pyround.js';
import { pyGet } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

function asObject(v: unknown): Obj {
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' ? (v as Obj) : {};
}

/** Rich enough to serve if at least one row has a rank (ftc_event_service.py:63). */
function sbFtcTeamsValid(sbRows: Obj[]): boolean {
  for (const r of sbRows) {
    if (asObject(r.raw_data).rank != null) return true;
  }
  return false;
}

// ── _parse_ftc_bracket_label (ftc_event_service.py:114) ───────
export function parseFtcBracketLabel(
  desc: string,
  series: number,
  matchNum: number,
): { compLevel: string; label: string; sortKey: [number, number, number] } {
  const dl = desc.toLowerCase();
  const roundM = /round\s*(\d+)/.exec(dl);
  const rnd = roundM ? Number(roundM[1]) : series;

  if (dl.includes('final bracket') || (dl.includes('final') && !dl.includes('semi'))) {
    let label = 'Final';
    if (matchNum > 1) label += ` (Match ${matchNum})`;
    return { compLevel: 'f', label, sortKey: [3, 0, matchNum] };
  }
  if (dl.includes('upper bracket')) {
    let label = `Upper R${rnd}`;
    if (matchNum > 1) label += ` (Match ${matchNum})`;
    return { compLevel: 'sf', label, sortKey: [1, rnd, matchNum] };
  }
  if (dl.includes('lower bracket')) {
    let label = `Lower R${rnd}`;
    if (matchNum > 1) label += ` (Match ${matchNum})`;
    return { compLevel: 'sf', label, sortKey: [2, rnd, matchNum] };
  }
  const label = desc.trim() ? desc.trim() : `Playoff ${series}`;
  return { compLevel: 'sf', label, sortKey: [1, series, matchNum] };
}

function cmpSortKey(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

// ── get_all_matches (ftc_event_service.py:506) ────────────────
export async function getAllMatches(eventKey: string): Promise<Obj> {
  const [year, eventCode] = parseFtcKey(eventKey);

  // ── Supabase-first: team data ────────────────────────────
  let sbTeamRows: Obj[] = [];
  try {
    sbTeamRows = await readEventTeamsFull(eventKey);
  } catch {
    sbTeamRows = [];
  }

  const teamInfo: Record<number, Obj> = {};
  const rankMapSb: Record<number, Obj> = {};
  const scoutMapSb: Record<number, Obj> = {};

  if (sbTeamRows.length && sbFtcTeamsValid(sbTeamRows)) {
    for (const r of sbTeamRows) {
      const num = r.team_number ?? 0;
      if (!num) continue;
      const raw = asObject(r.raw_data);
      const tims = asObject(r.tims_data);

      teamInfo[num] = {
        team_number: num,
        nickname: pyGet(r, 'nickname', `Team ${num}`),
        school_name: pyGet(tims, 'school_name', ''),
        city: pyGet(tims, 'city', ''),
        state_prov: pyGet(tims, 'state_prov', ''),
        country: pyGet(tims, 'country', ''),
        rookie_year: tims.rookie_year ?? null,
      };
      rankMapSb[num] = raw; // raw_data holds both rankings + OPR
      scoutMapSb[num] = raw; // same row — workers merged into one JSONB
    }
  }

  // ── Supabase-first: match schedule ───────────────────────
  let sbMatches: Obj[] = [];
  try {
    sbMatches = await readMatches(eventKey);
  } catch {
    sbMatches = [];
  }

  // Alliances from Supabase events.raw_data (stored by syncFtcAlliances).
  const allianceLookup: Record<number, number> = {};
  try {
    const evRow = await readEvent(eventKey);
    if (evRow) {
      const evRaw = asObject(evRow.raw_data);
      for (const a of (evRaw.alliances ?? []) as Obj[]) {
        const anum = a.number ?? 0;
        for (const tnum of (a.pick_numbers ?? []) as number[]) {
          if (tnum) allianceLookup[tnum] = anum;
        }
      }
    }
  } catch {
    /* ignore */
  }

  // ── Build source: Supabase matches + Supabase teams ──────
  let qualRaw: Obj[] = [];
  let playoffRaw: Obj[] = [];

  const useSbMatches = sbMatches.length > 0;
  const useSbTeams = Object.keys(teamInfo).length > 0;

  if (useSbMatches) {
    for (const m of sbMatches) {
      // asObject coerces non-dict/unparseable raw_data to {} rather than
      // skipping (matching Python's `if not isinstance(rd, dict): continue`
      // only for genuine type mismatches — an empty-but-valid dict proceeds).
      const rd = asObject(m.raw_data);
      const cl = m.comp_level ?? 'qm';
      if (!['qm', 'sf', 'f'].includes(cl)) continue; // skip practice/scrimmage rows
      if (cl === 'qm') qualRaw.push(rd);
      else playoffRaw.push(rd);
    }
  }

  if (!useSbMatches || !useSbTeams) {
    const client = getFtcClient();
    const scout = getFtcscoutClient();

    const tasks: Array<Promise<unknown>> = [];
    const labels: string[] = [];
    if (!useSbMatches) {
      tasks.push(client.getScheduleHybrid(year, eventCode, 'qual'));
      tasks.push(client.getScheduleHybrid(year, eventCode, 'playoff'));
      labels.push('qual', 'playoff');
    }
    if (!useSbTeams) {
      tasks.push(client.getEventTeams(year, eventCode));
      tasks.push(client.getRankings(year, eventCode));
      tasks.push(scout.getEventTeamStats(year, eventCode));
      tasks.push(client.getAlliances(year, eventCode));
      labels.push('teams', 'rankings', 'scout', 'alliances');
    }

    const settled = await Promise.allSettled(tasks);
    const apiMap: Record<string, unknown> = {};
    labels.forEach((label, i) => {
      apiMap[label] = settled[i]!.status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<unknown>).value : [];
    });

    if (!useSbMatches) {
      qualRaw = (apiMap.qual as Obj[]) ?? [];
      playoffRaw = (apiMap.playoff as Obj[]) ?? [];
    }

    if (!useSbTeams) {
      const rawTeams = (apiMap.teams as Obj[]) ?? [];
      const rawRankings = (apiMap.rankings as Obj[]) ?? [];
      const scoutStats = (apiMap.scout as Obj[]) ?? [];
      const rawAlliances = (apiMap.alliances as Obj[]) ?? [];

      for (const t of rawTeams) {
        const num = t.teamNumber ?? 0;
        if (num) {
          teamInfo[num] = {
            team_number: num,
            nickname: t.nameShort || t.nameFull || `Team ${num}`,
            school_name: pyGet(t, 'schoolName', ''),
            city: pyGet(t, 'city', ''),
            state_prov: pyGet(t, 'stateProv', ''),
            country: pyGet(t, 'country', ''),
            rookie_year: t.rookieYear ?? null,
          };
        }
      }
      for (const r of rawRankings) {
        const num = r.teamNumber ?? 0;
        if (num) rankMapSb[num] = r;
      }
      for (const s of scoutStats) {
        const num = s.team_number ?? 0;
        if (num) scoutMapSb[num] = s;
      }

      // Rebuild alliance lookup from API alliances.
      for (const a of rawAlliances) {
        const anum = a.number ?? 0;
        for (const role of ['captain', 'round1', 'round2', 'round3', 'backup']) {
          const slot = a[role];
          let tnum: number | undefined;
          if (slot && typeof slot === 'object') tnum = slot.teamNumber ?? 0;
          else if (typeof slot === 'number') tnum = slot;
          else continue;
          if (tnum) allianceLookup[tnum] = anum;
        }
      }
    }
  }

  function buildTeam(teamNumber: number): Obj {
    const info = teamInfo[teamNumber] ?? {};
    const rk = rankMapSb[teamNumber] ?? {};
    const sd = scoutMapSb[teamNumber] ?? {};
    const wins = rk.wins || 0;
    const losses = rk.losses || 0;
    const ties = rk.ties || 0;
    const oprVal = rk.opr_total || sd.opr_total;
    const sortOrders = (rk.sort_orders || rk.sortOrders || []) as unknown[];
    const qualAvg = rk.qual_average || rk.qualAverage || 0;
    const mp = rk.matches_played || rk.matchesPlayed || 0;
    const rpVal = sortOrders.length ? (sortOrders[0] as number) : null;
    const avgRp = rpVal != null && mp > 0 ? pyRound(rpVal / mp, 2) : 0;

    return {
      team_key: `ftc${teamNumber}`,
      team_number: teamNumber,
      nickname: pyGet(info, 'nickname', `Team ${teamNumber}`),
      school_name: pyGet(info, 'school_name', ''),
      city: pyGet(info, 'city', ''),
      state_prov: pyGet(info, 'state_prov', ''),
      country: pyGet(info, 'country', ''),
      rookie_year: info.rookie_year ?? null,
      avatar: null,
      rank: pyGet(rk, 'rank', '-'),
      wins,
      losses,
      ties,
      opr: oprVal != null ? pyRound(oprVal, 2) : 0,
      opr_auto: rk.opr_auto || sd.opr_auto || null,
      opr_dc: rk.opr_dc || sd.opr_dc || null,
      opr_np: rk.opr_np || sd.opr_np || null,
      epa: null,
      avg_rp: avgRp,
      qual_average: qualAvg,
      high_score: 0,
      high_score_match: '',
      avg_total: rk.avg_total || sd.avg_total || null,
      avg_auto: rk.avg_auto || sd.avg_auto || null,
      avg_dc: rk.avg_dc || sd.avg_dc || null,
      avg_np: rk.avg_np || sd.avg_np || null,
      max_total: rk.max_total || sd.max_total || null,
      max_auto: rk.max_auto || sd.max_auto || null,
      max_dc: rk.max_dc || sd.max_dc || null,
      min_total: rk.min_total || sd.min_total || null,
      dev_total: rk.dev_total || sd.dev_total || null,
    };
  }

  // ── Build match list ──
  const allRaw: Array<[Obj, 'qual' | 'playoff']> = [
    ...qualRaw.map((m): [Obj, 'qual'] => [m, 'qual']),
    ...playoffRaw.map((m): [Obj, 'playoff'] => [m, 'playoff']),
  ];

  let eventHigh: Obj = { score: 0, match: '', teams: [] as number[] };

  const rows: Array<{ row: Obj; sortKey: number[] }> = [];
  for (const [rawMatch, level] of allRaw) {
    const matchNum = rawMatch.matchNumber ?? 0;
    const teamsInMatch = (rawMatch.teams ?? []) as Obj[];

    const redRaw = teamsInMatch.filter((t) => (t.station ?? '').startsWith('Red'));
    const blueRaw = teamsInMatch.filter((t) => (t.station ?? '').startsWith('Blue'));
    const redNums = redRaw.map((t) => t.teamNumber ?? 0);
    const blueNums = blueRaw.map((t) => t.teamNumber ?? 0);

    const redTeams = redNums.filter(Boolean).map(buildTeam);
    const blueTeams = blueNums.filter(Boolean).map(buildTeam);

    const redScore = rawMatch.scoreRedFinal ?? null;
    const blueScore = rawMatch.scoreBlueFinal ?? null;

    let winning = '';
    if (redScore !== null && blueScore !== null) {
      if (redScore > blueScore) winning = 'red';
      else if (blueScore > redScore) winning = 'blue';
    }

    let compLevel: string;
    let matchKey: string;
    let label: string;
    let sortKey: number[];
    if (level === 'qual') {
      compLevel = 'qm';
      matchKey = `${year}ftc${eventCode}_qm${matchNum}`;
      label = `Qualification ${matchNum}`;
      sortKey = [0, matchNum, 0];
    } else {
      let series = rawMatch.series || 0;
      if (series === 0) series = matchNum;
      const desc = rawMatch.description ?? '';
      const parsed = parseFtcBracketLabel(desc, series, matchNum);
      compLevel = parsed.compLevel;
      label = parsed.label;
      sortKey = parsed.sortKey;
      matchKey = `${year}ftc${eventCode}_${compLevel}${series}m${matchNum}`;
    }

    const rs = redScore !== null ? redScore : -1;
    const bs = blueScore !== null ? blueScore : -1;

    for (const [scoreVal, tnums] of [
      [rs, redNums],
      [bs, blueNums],
    ] as [number, number[]][]) {
      if (scoreVal > eventHigh.score) {
        eventHigh = { score: scoreVal, match: label, teams: tnums };
      }
    }

    const hasBreakdown = rs >= 0 && bs >= 0;

    rows.push({
      sortKey,
      row: {
        key: matchKey,
        comp_level: compLevel,
        match_number: matchNum,
        set_number: rawMatch.series ?? 1,
        label,
        // NOT stripped before returning — this is a genuine quirk of the FTC
        // service (unlike FRC's matches.py, which explicitly `del`s it).
        sort_key: sortKey,
        time: rawMatch.actualStartTime || rawMatch.startTime || null,
        has_breakdown: hasBreakdown,
        red: {
          teams: redTeams,
          score: rs,
          total_opr: pyRound(redTeams.reduce((s, t) => s + t.opr, 0), 2),
          alliance_number: compLevel !== 'qm' && redNums.length ? allianceLookup[redNums[0]!] ?? null : null,
        },
        blue: {
          teams: blueTeams,
          score: bs,
          total_opr: pyRound(blueTeams.reduce((s, t) => s + t.opr, 0), 2),
          alliance_number: compLevel !== 'qm' && blueNums.length ? allianceLookup[blueNums[0]!] ?? null : null,
        },
        winning_alliance: winning,
        pred: null,
        program: 'FTC',
      },
    });
  }

  rows.sort((a, b) => cmpSortKey(a.sortKey, b.sortKey));

  return {
    event_key: eventKey,
    matches: rows.map((r) => r.row),
    event_high_score: eventHigh.score > 0 ? eventHigh : null,
  };
}

// ── get_playoff_matches (ftc_event_service.py:840) ─────────────
export async function getPlayoffMatches(eventKey: string): Promise<Obj> {
  const data = await getAllMatches(eventKey);
  const playoff = (data.matches as Obj[]).filter((m) => m.comp_level !== 'qm');
  return { event_key: eventKey, matches: playoff };
}

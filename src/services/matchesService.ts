/**
 * Match read layer — port of get_all_matches (play-by-play) and
 * get_playoff_matches from backend/app/routers/matches.py.
 *
 * These read live from TBA + Statbotics + FRC (NOT Supabase) and compute
 * per-team running stats. Parity notes: object key order mirrors the Python
 * dicts; nullable fields use `?? null`; rounding uses pyRound; Python `or` /
 * `dict.get` semantics via pyOr/pyGet.
 */
import { getTbaClient } from './tbaClient.js';
import { getFrcClient } from './frcClient.js';
import { getEpaMap, getMatchPredictions } from './statboticsClient.js';
import { checkEventHigh } from './worldRecordService.js';
import { pyRound } from '../lib/pyround.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';

// FRC double-elim bracket structure (matches.py:19-27).
const DOUBLE_ELIM_MAP: Record<number, [number, string]> = {
  1: [1, 'upper'], 2: [1, 'upper'], 3: [1, 'upper'], 4: [1, 'upper'],
  5: [2, 'lower'], 6: [2, 'lower'], 7: [2, 'upper'], 8: [2, 'upper'],
  9: [3, 'lower'], 10: [3, 'lower'],
  11: [4, 'upper'], 12: [4, 'lower'],
  13: [5, 'lower'],
};
const ROUND_LABELS: Record<number, string> = {
  1: 'Round 1', 2: 'Round 2', 3: 'Round 3', 4: 'Round 4', 5: 'Round 5', 0: 'Grand Final',
};
const COMP_LEVEL_ORDER: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
const COMP_LEVEL_LABELS: Record<string, string> = {
  qm: 'Qualification', ef: 'Eighths', qf: 'Quarterfinal', sf: 'Match', f: 'Final',
};

const roundLabel = (n: number): string => ROUND_LABELS[n] ?? `Round ${n}`;

/** Tuple comparison for [number, number, number] sort keys. */
function cmpSortKey(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

type Obj = Record<string, any>;

// ── get_all_matches (matches.py:34) ─────────────────────────
export async function getAllMatches(eventKey: string): Promise<Obj> {
  const client = getTbaClient();
  const frc = getFrcClient();
  const year = Number(eventKey.slice(0, 4));
  const eventCode = eventKey.slice(4);

  // matches + teams_full are NOT wrapped (throw → propagate); the rest are _safe.
  const [matchesRaw, rankings, oprs, teamsRaw, frcTeamsRaw, epaDataR, predDataR, alliancesRaw] =
    await Promise.all([
      client.getEventMatches<Obj[]>(eventKey),
      client.getEventRankings<Obj>(eventKey).catch(() => null),
      client.getEventOprs<Obj>(eventKey).catch(() => null),
      client.getEventTeamsFull<Obj[]>(eventKey),
      frc.getEventTeams(year, eventCode).catch(() => null),
      getEpaMap(eventKey).catch(() => null),
      getMatchPredictions(eventKey).catch(() => null),
      client.getEventAlliances<Obj[]>(eventKey).catch(() => null),
    ]);
  const epaData = epaDataR ?? {};
  const predData = predDataR ?? {};

  // Alliance-number lookup (team_key → alliance #).
  const allianceLookup: Record<string, number> = {};
  if (alliancesRaw) {
    alliancesRaw.forEach((a, idx) => {
      for (const tk of (a.picks ?? []) as string[]) allianceLookup[tk] = idx + 1;
    });
  }

  // FRC Events org-name lookup (teamNumber → schoolOrg).
  const frcOrgMap: Record<number, string> = {};
  for (const ft of frcTeamsRaw ?? []) {
    const num = ft.teamNumber as number | undefined;
    const org = (ft.schoolName || ft.nameShort || '') as string;
    if (num && org) frcOrgMap[num] = org;
  }

  // Team info lookup.
  const teamInfo: Record<string, Obj> = {};
  for (const t of teamsRaw ?? []) {
    const tnum = t.team_number as number;
    teamInfo[t.key as string] = {
      team_number: tnum,
      nickname: t.nickname ?? '',
      city: t.city ?? '',
      state_prov: t.state_prov ?? '',
      country: t.country ?? '',
      rookie_year: t.rookie_year ?? null,
      school_name: frcOrgMap[tnum] || t.school_name || '',
    };
  }

  const rankMap: Record<string, Obj> = {};
  if (rankings && rankings.rankings) {
    for (const r of rankings.rankings as Obj[]) rankMap[r.team_key as string] = r;
  }

  const oprMap: Record<string, number> = {};
  if (oprs && oprs.oprs) {
    for (const tk of Object.keys(oprs.oprs as Obj)) oprMap[tk] = pyRound((oprs.oprs as Obj)[tk], 2);
  }

  // Per-team running qual scores.
  const teamMatches: Record<string, number[]> = {};
  for (const m of matchesRaw) {
    if (m.comp_level !== 'qm') continue;
    for (const color of ['red', 'blue'] as const) {
      const score = pyGet(m.alliances[color], 'score', 0) as number;
      if (score < 0) continue;
      for (const tk of (m.alliances[color].team_keys ?? []) as string[]) {
        (teamMatches[tk] ??= []).push(score);
      }
    }
  }

  // Event high score (across all matches).
  let eventHigh: Obj = { score: 0, match: '', teams: [] };
  for (const m of matchesRaw) {
    const cl = (m.comp_level ?? 'qm') as string;
    const mn = (m.match_number ?? 0) as number;
    const sn = (m.set_number ?? 0) as number;
    let matchLabel: string;
    if (cl === 'qm') matchLabel = `Qualification ${mn}`;
    else if (cl === 'f') matchLabel = `Final ${mn}`;
    else {
      const levelName = COMP_LEVEL_LABELS[cl] ?? cl;
      matchLabel = `${levelName} ${sn}` + (mn > 1 ? ` (Match ${mn})` : '');
    }
    for (const color of ['red', 'blue'] as const) {
      const s = pyGet(m.alliances[color], 'score', 0) as number;
      if (s > eventHigh.score) {
        eventHigh = {
          score: s,
          match: matchLabel,
          teams: ((m.alliances[color].team_keys ?? []) as string[]).map((tk) =>
            Number(tk.replace('frc', '')),
          ),
        };
      }
    }
  }

  const buildTeam = (tk: string): Obj => {
    const info = (teamInfo[tk] ?? {}) as Obj;
    const rk = (rankMap[tk] ?? {}) as Obj;
    const rec = (rk.record ?? {}) as Obj;
    const scores = teamMatches[tk] ?? [];
    let rpList: number[] = [];
    if (rankings && rankings.rankings) {
      for (const r of rankings.rankings as Obj[]) {
        if (r.team_key === tk) {
          const sortOrders = (r.sort_orders ?? []) as any[];
          if (sortOrders.length) {
            rpList = [
              typeof sortOrders[0] === 'number' ? sortOrders[0] : (sortOrders[0]?.value ?? 0),
            ];
          }
        }
      }
    }
    return {
      team_key: tk,
      team_number: pyGet(info, 'team_number', Number(tk.replace('frc', ''))),
      nickname: pyGet(info, 'nickname', ''),
      school_name: pyGet(info, 'school_name', ''),
      city: pyGet(info, 'city', ''),
      state_prov: pyGet(info, 'state_prov', ''),
      country: pyGet(info, 'country', ''),
      rookie_year: pyGet(info, 'rookie_year') ?? null,
      rank: pyGet(rk, 'rank', '-'),
      wins: pyGet(rec, 'wins', 0),
      losses: pyGet(rec, 'losses', 0),
      ties: pyGet(rec, 'ties', 0),
      qual_average: scores.length ? pyRound(scores.reduce((a, b) => a + b, 0) / scores.length, 2) : 0,
      avg_rp: rpList.length ? pyRound(rpList[0]!, 2) : 0,
      opr: pyGet(oprMap, tk, 0),
      epa: ((epaData as Obj)[tk] ?? {}).epa ?? null,
      high_score: scores.length ? Math.max(...scores) : 0,
      high_score_match: '',
    };
  };

  // Each team's high-score qual match label.
  const teamHighMatch: Record<string, string> = {};
  for (const m of matchesRaw) {
    if (m.comp_level !== 'qm') continue;
    for (const color of ['red', 'blue'] as const) {
      const s = pyGet(m.alliances[color], 'score', 0) as number;
      for (const tk of (m.alliances[color].team_keys ?? []) as string[]) {
        const scores = teamMatches[tk] ?? [0];
        if (s >= Math.max(...scores)) {
          teamHighMatch[tk] = `Qualification ${m.match_number ?? '?'}`;
        }
      }
    }
  }

  // ── Build match list (with parallel sort keys) ──
  const rows: Array<{ row: Obj; sortKey: number[] }> = [];
  for (const m of matchesRaw) {
    const cl = (m.comp_level ?? 'qm') as string;
    const mn = (m.match_number ?? 0) as number;
    const sn = (m.set_number ?? 0) as number;
    let label: string;
    let sortKey: number[];
    if (cl === 'qm') {
      label = `Qualification ${mn}`;
      sortKey = [0, mn, 0];
    } else if (cl === 'f') {
      label = `Final ${mn}`;
      sortKey = [COMP_LEVEL_ORDER[cl] ?? 9, sn, mn];
    } else {
      const levelName = COMP_LEVEL_LABELS[cl] ?? cl;
      label = `${levelName} ${sn}` + (mn > 1 ? ` (Match ${mn})` : '');
      sortKey = [COMP_LEVEL_ORDER[cl] ?? 9, sn, mn];
    }

    const redKeys = (m.alliances.red.team_keys ?? []) as string[];
    const blueKeys = (m.alliances.blue.team_keys ?? []) as string[];

    const redTeams = redKeys.map((tk) => {
      const t = buildTeam(tk);
      t.high_score_match = teamHighMatch[tk] ?? '';
      return t;
    });
    const blueTeams = blueKeys.map((tk) => {
      const t = buildTeam(tk);
      t.high_score_match = teamHighMatch[tk] ?? '';
      return t;
    });

    rows.push({
      sortKey,
      row: {
        key: m.key,
        comp_level: cl,
        match_number: mn,
        set_number: sn,
        label,
        time: pyOr(pyGet(m, 'actual_time'), pyGet(m, 'predicted_time')) ?? null,
        has_breakdown: (m.score_breakdown ?? null) !== null,
        red: {
          teams: redTeams,
          score: pyGet(m.alliances.red, 'score', -1),
          total_opr: pyRound(redKeys.reduce((s, tk) => s + (pyGet(oprMap, tk, 0) as number), 0), 2),
          alliance_number: cl !== 'qm' && redKeys.length ? allianceLookup[redKeys[0]!] ?? null : null,
        },
        blue: {
          teams: blueTeams,
          score: pyGet(m.alliances.blue, 'score', -1),
          total_opr: pyRound(blueKeys.reduce((s, tk) => s + (pyGet(oprMap, tk, 0) as number), 0), 2),
          alliance_number: cl !== 'qm' && blueKeys.length ? allianceLookup[blueKeys[0]!] ?? null : null,
        },
        winning_alliance: pyGet(m, 'winning_alliance', ''),
        pred: (predData as Obj)[m.key as string] ?? null,
      },
    });
  }

  rows.sort((a, b) => cmpSortKey(a.sortKey, b.sortKey));

  // Inject placeholders for the full double-elim bracket when playoffs exist.
  const hasPlayoffs = rows.some((r) => r.row.comp_level !== 'qm');
  if (hasPlayoffs) {
    const existingSets = new Set<number>();
    let hasFinal = false;
    for (const { row } of rows) {
      if (row.comp_level === 'sf') existingSets.add(row.set_number as number);
      else if (row.comp_level === 'f') hasFinal = true;
    }
    const emptySide = () => ({ teams: [], score: -1, total_opr: 0, alliance_number: null });
    for (let sn = 1; sn <= 13; sn += 1) {
      if (!existingSets.has(sn)) {
        rows.push({
          sortKey: [COMP_LEVEL_ORDER.sf!, sn, 1],
          row: {
            key: `${eventKey}_sf${sn}m1`,
            comp_level: 'sf',
            match_number: 1,
            set_number: sn,
            label: `Match ${sn}`,
            time: null,
            has_breakdown: false,
            red: emptySide(),
            blue: emptySide(),
            winning_alliance: '',
            pred: null,
          },
        });
      }
    }
    if (!hasFinal) {
      rows.push({
        sortKey: [COMP_LEVEL_ORDER.f!, 1, 1],
        row: {
          key: `${eventKey}_f1m1`,
          comp_level: 'f',
          match_number: 1,
          set_number: 1,
          label: 'Final 1',
          time: null,
          has_breakdown: false,
          red: emptySide(),
          blue: emptySide(),
          winning_alliance: '',
          pred: null,
        },
      });
    }
    rows.sort((a, b) => cmpSortKey(a.sortKey, b.sortKey));
  }

  const result = rows.map((r) => r.row);

  // Event name for the world-record label.
  let eventName = eventKey;
  try {
    const evInfo = await client.getEvent<Obj>(eventKey);
    if (evInfo) eventName = (evInfo.short_name || evInfo.name || eventKey) as string;
  } catch {
    /* ignore */
  }
  const isWorldRecord = await checkEventHigh(eventKey, eventName, eventHigh as any);

  return {
    event_key: eventKey,
    matches: result,
    event_high_score: eventHigh,
    is_world_record: isWorldRecord,
    total_matches: result.length,
  };
}

// ── get_playoff_matches (matches.py:1062) ───────────────────
export async function getPlayoffMatches(eventKey: string): Promise<Obj> {
  const client = getTbaClient();
  const [matches, alliances, oprs, teams] = await Promise.all([
    client.getEventMatches<Obj[]>(eventKey),
    client.getEventAlliances<Obj[]>(eventKey),
    client.getEventOprs<Obj>(eventKey),
    client.getEventTeams<Obj[]>(eventKey),
  ]);

  const nameMap: Record<string, string> = {};
  const countryMap: Record<string, string> = {};
  for (const t of teams ?? []) {
    nameMap[t.key as string] = (t.nickname ?? '') as string;
    countryMap[t.key as string] = (t.country ?? '') as string;
  }

  const oprMap: Record<string, number> = {};
  if (oprs && oprs.oprs) {
    for (const tk of Object.keys(oprs.oprs as Obj)) oprMap[tk] = pyRound((oprs.oprs as Obj)[tk], 2);
  }

  const allianceLookup: Record<string, number> = {};
  if (alliances) {
    alliances.forEach((a, idx) => {
      for (const tk of (a.picks ?? []) as string[]) allianceLookup[tk] = idx + 1;
    });
  }

  const playoff = (matches ?? []).filter((m) => m.comp_level !== 'qm');

  const buildSide = (keys: string[]): Obj => ({
    team_keys: keys,
    team_numbers: keys.map((tk) => Number(tk.replace('frc', ''))),
    team_names: keys.map((tk) => nameMap[tk] ?? ''),
    team_countries: keys.map((tk) => countryMap[tk] ?? ''),
  });

  type Row = { row: Obj; sortKey: number[] };
  const rows: Row[] = [];
  for (const m of playoff) {
    const sn = (m.set_number ?? 0) as number;
    const cl = (m.comp_level ?? '') as string;
    let roundNum: number;
    let bracket: string;
    if (cl === 'f') {
      roundNum = 0;
      bracket = 'final';
    } else if (sn in DOUBLE_ELIM_MAP) {
      [roundNum, bracket] = DOUBLE_ELIM_MAP[sn]!;
    } else {
      roundNum = 99;
      bracket = 'unknown';
    }

    const redKeys = (m.alliances.red.team_keys ?? []) as string[];
    const blueKeys = (m.alliances.blue.team_keys ?? []) as string[];

    rows.push({
      sortKey: [roundNum > 0 ? roundNum : 99, sn, (m.match_number ?? 0) as number],
      row: {
        key: m.key,
        round: roundNum,
        round_label: roundLabel(roundNum),
        bracket,
        set_number: sn,
        match_number: m.match_number ?? 0,
        red: {
          ...buildSide(redKeys),
          score: pyGet(m.alliances.red, 'score', -1),
          alliance_number: redKeys.length ? allianceLookup[redKeys[0]!] ?? null : null,
          total_opr: pyRound(redKeys.reduce((s, tk) => s + (pyGet(oprMap, tk, 0) as number), 0), 2),
        },
        blue: {
          ...buildSide(blueKeys),
          score: pyGet(m.alliances.blue, 'score', -1),
          alliance_number: blueKeys.length ? allianceLookup[blueKeys[0]!] ?? null : null,
          total_opr: pyRound(blueKeys.reduce((s, tk) => s + (pyGet(oprMap, tk, 0) as number), 0), 2),
        },
        winning_alliance: pyGet(m, 'winning_alliance', ''),
        score_breakdown: m.score_breakdown ?? null,
        time: pyOr(pyGet(m, 'actual_time'), pyGet(m, 'predicted_time')) ?? null,
      },
    });
  }

  // Ensure all 13 double-elim sets + finals appear.
  const existingSets = new Set<number>();
  let hasFinal = false;
  for (const { row } of rows) {
    if (row.bracket === 'final') hasFinal = true;
    else if ((row.set_number as number) in DOUBLE_ELIM_MAP) existingSets.add(row.set_number as number);
  }
  const emptyPoSide = () => ({
    team_keys: [], team_numbers: [], team_names: [], team_countries: [],
    score: -1, alliance_number: null, total_opr: 0,
  });
  for (const [snStr, [rnd, bkt]] of Object.entries(DOUBLE_ELIM_MAP)) {
    const sn = Number(snStr);
    if (!existingSets.has(sn)) {
      rows.push({
        sortKey: [rnd > 0 ? rnd : 99, sn, 1],
        row: {
          key: `${eventKey}_sf${sn}m1`,
          round: rnd,
          round_label: roundLabel(rnd),
          bracket: bkt,
          set_number: sn,
          match_number: 1,
          red: emptyPoSide(),
          blue: emptyPoSide(),
          winning_alliance: '',
          score_breakdown: null,
          time: null,
        },
      });
    }
  }
  if (!hasFinal) {
    rows.push({
      sortKey: [99, 1, 1],
      row: {
        key: `${eventKey}_f1m1`,
        round: 0,
        round_label: 'Grand Final',
        bracket: 'final',
        set_number: 1,
        match_number: 1,
        red: emptyPoSide(),
        blue: emptyPoSide(),
        winning_alliance: '',
        score_breakdown: null,
        time: null,
      },
    });
  }

  rows.sort((a, b) => cmpSortKey(a.sortKey, b.sortKey));
  return { event_key: eventKey, matches: rows.map((r) => r.row) };
}

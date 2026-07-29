/**
 * Side-by-side comparison of 2-6 teams at an event — port of
 * `get_team_comparison` in backend/app/services/event_service.py.
 *
 * Supabase-first (event_teams + matches), falling back to TBA + Statbotics
 * when Supabase rows are absent or too thin to be useful.
 */
import { getTbaClient } from './tbaClient.js';
import { getEpaMap } from './statboticsClient.js';
import { readEventTeamsFull, readMatches } from './supabase.js';
import { pyGet, pyOr, pyTruthy } from '../lib/pysemantics.js';
import { pyRound } from '../lib/pyround.js';

type Obj = Record<string, any>;

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

function asDict(v: unknown): Obj {
  let d = pyOr(v, {}) as unknown;
  if (typeof d === 'string') d = JSON.parse(d);
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return {};
  return d as Obj;
}

/**
 * Supabase rows are only usable if at least one carries rank OR opr — rows
 * holding EPA alone (Statbotics-only) are too thin. event_service.py:_sb_teams_valid.
 */
function sbTeamsValid(sbRows: Obj[]): boolean {
  for (const r of sbRows) {
    let rd = pyOr(r.raw_data, {}) as unknown;
    if (typeof rd === 'string') rd = JSON.parse(rd);
    if (typeof rd !== 'object' || rd === null || Array.isArray(rd)) continue;
    const d = rd as Obj;
    if (d.rank !== null && d.rank !== undefined) return true;
    if (d.opr !== null && d.opr !== undefined) return true;
  }
  return false;
}

/** Average RP from sort_orders[0] when numeric, else 0. */
function avgRpFrom(sortOrders: unknown): number {
  const so = (pyOr(sortOrders, []) ?? []) as unknown[];
  return so.length && typeof so[0] === 'number' ? pyRound(so[0] as number, 2) : 0;
}

export async function getTeamComparison(eventKey: string, teamsCsv: string): Promise<Obj> {
  const teamKeys = teamsCsv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (teamKeys.length < 2 || teamKeys.length > 6) {
    throw new RangeError('Provide between 2 and 6 team keys');
  }

  // ── Supabase first ────────────────────────────────────────
  let sbTeams: Obj[] = [];
  let sbMatches: Obj[] = [];
  try {
    [sbTeams, sbMatches] = await Promise.all([readEventTeamsFull(eventKey), readMatches(eventKey)]);
  } catch {
    /* fall through to the API path */
  }

  if (pyTruthy(sbTeams) && sbTeamsValid(sbTeams)) {
    const teamRawMap: Record<string, Obj> = {};
    const teamInfoMap: Record<string, Obj> = {};
    for (const r of sbTeams) {
      const tk = r.team_key as string;
      const raw = asDict(r.raw_data);
      const tims = asDict(r.tims_data);
      const frcD = asDict(r.frc_data);
      teamRawMap[tk] = raw;
      teamInfoMap[tk] = {
        team_number: pyGet(r, 'team_number', 0),
        nickname: pyGet(r, 'nickname', ''),
        city: pyOr(frcD.city, pyGet(tims, 'city', '')),
        state_prov: pyOr(frcD.stateProv, pyGet(tims, 'state_prov', '')),
        country: pyOr(frcD.country, pyGet(tims, 'country', '')),
      };
    }

    const teamScores: Record<string, number[]> = {};
    for (const m of sbMatches) {
      if (m.comp_level !== 'qm') continue;
      const alliances = asDict(m.alliances);
      for (const color of ['red', 'blue']) {
        const alliance = (pyOr(alliances[color], {}) ?? {}) as Obj;
        const score = pyGet(alliance, 'score', -1) as number;
        if (score < 0) continue;
        for (const tk of (pyGet(alliance, 'team_keys', []) ?? []) as string[]) {
          (teamScores[tk] ??= []).push(score);
        }
      }
    }

    const comparison = teamKeys.map((tk) => {
      const raw = (pyGet(teamRawMap, tk, {}) ?? {}) as Obj;
      const info = (pyGet(teamInfoMap, tk, {}) ?? {}) as Obj;
      const epaBlock = (pyOr(raw.epa, {}) ?? {}) as Obj;
      const scores = (pyGet(teamScores, tk, []) ?? []) as number[];
      const opr = pyGet(raw, 'opr', 0) as number;
      return {
        team_key: tk,
        team_number: pyGet(info, 'team_number', Number(tk.replace('frc', ''))),
        nickname: pyGet(info, 'nickname', ''),
        city: pyGet(info, 'city', ''),
        state_prov: pyGet(info, 'state_prov', ''),
        country: pyGet(info, 'country', ''),
        avatar: null,
        rank: pyGet(raw, 'rank', '-'),
        wins: pyGet(raw, 'wins', 0),
        losses: pyGet(raw, 'losses', 0),
        ties: pyGet(raw, 'ties', 0),
        // Python: `round(raw.get("opr", 0), 2) if raw.get("opr") else 0` —
        // a falsy opr (0/None) short-circuits to a plain 0.
        opr: pyTruthy(opr) ? pyRound(opr, 2) : 0,
        epa: epaBlock.epa ?? null,
        epa_auto: epaBlock.epa_auto ?? null,
        epa_teleop: epaBlock.epa_teleop ?? null,
        epa_endgame: epaBlock.epa_endgame ?? null,
        avg_rp: avgRpFrom(raw.sort_orders),
        qual_average: scores.length
          ? pyRound(scores.reduce((a, b) => a + b, 0) / scores.length, 2)
          : 0,
        high_score: scores.length ? Math.max(...scores) : 0,
        matches_played: scores.length,
      };
    });

    return { event_key: eventKey, teams: comparison };
  }

  // ── Fallback: TBA + Statbotics ────────────────────────────
  const client = getTbaClient();
  const [matchesRawIn, rankings, oprs, teamsRaw, epaDataIn] = await Promise.all([
    safe(client.getEventMatches<Obj[]>(eventKey)),
    safe(client.getEventRankings<Obj>(eventKey)),
    safe(client.getEventOprs<Obj>(eventKey)),
    safe(client.getEventTeamsFull<Obj[]>(eventKey)),
    safe(getEpaMap(eventKey)),
  ]);
  const epaData = (pyOr(epaDataIn, {}) ?? {}) as Obj;

  const teamInfo: Record<string, Obj> = {};
  for (const t of teamsRaw ?? []) teamInfo[t.key] = t;

  const rankMap: Record<string, Obj> = {};
  if (rankings && pyTruthy(rankings.rankings)) {
    for (const r of rankings.rankings as Obj[]) rankMap[r.team_key] = r;
  }

  const oprData: Record<string, Obj> = {};
  if (oprs) {
    const oprBlock = (pyGet(oprs, 'oprs', {}) ?? {}) as Obj;
    for (const tk of Object.keys(oprBlock)) {
      oprData[tk] = { opr: pyRound(pyGet(oprBlock, tk, 0) as number, 2) };
    }
  }

  const teamScores: Record<string, number[]> = {};
  for (const m of (pyOr(matchesRawIn, []) ?? []) as Obj[]) {
    if (m.comp_level !== 'qm') continue;
    for (const color of ['red', 'blue']) {
      const score = pyGet(m.alliances[color], 'score', -1) as number;
      if (score < 0) continue;
      for (const tk of (pyGet(m.alliances[color], 'team_keys', []) ?? []) as string[]) {
        (teamScores[tk] ??= []).push(score);
      }
    }
  }

  const comparison = teamKeys.map((tk) => {
    const info = (pyGet(teamInfo, tk, {}) ?? {}) as Obj;
    const rk = (pyGet(rankMap, tk, {}) ?? {}) as Obj;
    const rec = (pyGet(rk, 'record', {}) ?? {}) as Obj;
    const o = (pyGet(oprData, tk, { opr: 0 }) ?? { opr: 0 }) as Obj;
    const epa = (pyGet(epaData, tk, {}) ?? {}) as Obj;
    const scores = (pyGet(teamScores, tk, []) ?? []) as number[];
    return {
      team_key: tk,
      team_number: pyGet(info, 'team_number', Number(tk.replace('frc', ''))),
      nickname: pyGet(info, 'nickname', ''),
      city: pyGet(info, 'city', ''),
      state_prov: pyGet(info, 'state_prov', ''),
      country: pyGet(info, 'country', ''),
      avatar: null,
      rank: pyGet(rk, 'rank', '-'),
      wins: pyGet(rec, 'wins', 0),
      losses: pyGet(rec, 'losses', 0),
      ties: pyGet(rec, 'ties', 0),
      opr: o.opr,
      epa: pyGet(epa, 'epa', null),
      epa_auto: pyGet(epa, 'epa_auto', null),
      epa_teleop: pyGet(epa, 'epa_teleop', null),
      epa_endgame: pyGet(epa, 'epa_endgame', null),
      avg_rp: avgRpFrom(pyGet(rk, 'sort_orders', [])),
      qual_average: scores.length
        ? pyRound(scores.reduce((a, b) => a + b, 0) / scores.length, 2)
        : 0,
      high_score: scores.length ? Math.max(...scores) : 0,
      matches_played: scores.length,
    };
  });

  return { event_key: eventKey, teams: comparison };
}

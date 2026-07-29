/**
 * Event Summary — demographics, Hall of Fame, top scorers, high scores. Port
 * of the get_event_summary / get_event_summary_stats slice of
 * backend/app/services/summary_service.py.
 */
import { getTbaClient } from './tbaClient.js';
import { getEpaMap } from './statboticsClient.js';
import { getCachedSummary, setCachedSummary } from './supabase.js';
import * as payloadCache from '../lib/payloadCache.js';
import { ensureAwardLookups } from '../lib/regionStats.js';
import { Semaphore } from '../lib/semaphore.js';
import { pyRound } from '../lib/pyround.js';
import { pyGet } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

const API_SEMAPHORE = new Semaphore(10);
const SUMMARY_TTL = 300; // seconds — demographics, HoF, scorers (summary_service.py:18)

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await API_SEMAPHORE.run(fn);
  } catch {
    return null;
  }
}

// ── get_event_summary (summary_service.py:100) ──────────────
export async function getEventSummary(eventKey: string): Promise<Obj> {
  // 1) Disk cache.
  const cached = await payloadCache.readPayload('summary', eventKey, SUMMARY_TTL);
  if (cached) return cached;

  // 2) Supabase cache — respect TTL for live events.
  const sbRow = await getCachedSummary(eventKey);
  if (sbRow && sbRow.summary) {
    let sbFresh = true;
    const updated = sbRow.updated_at;
    if (updated) {
      const ts = Date.parse(updated);
      if (!Number.isNaN(ts)) {
        const ageSeconds = (Date.now() - ts) / 1000;
        if (ageSeconds > SUMMARY_TTL) sbFresh = false;
      } else {
        sbFresh = false;
      }
    }
    if (sbFresh) {
      const summary = sbRow.summary as Obj;
      await payloadCache.writePayload('summary', eventKey, summary);
      return summary;
    }
  }

  // 3) Build from scratch.
  const result = await buildEventSummary(eventKey);
  if (!('error' in result)) {
    await payloadCache.writePayload('summary', eventKey, result);
    await setCachedSummary(eventKey, result, undefined);
  }
  return result;
}

async function buildEventSummary(eventKey: string): Promise<Obj> {
  const client = getTbaClient();
  const year = Number(eventKey.slice(0, 4));

  const [eventInfo, teams, rankings, oprs, epaDataR, matchesRaw] = await Promise.all([
    safe(() => client.getEvent<Obj>(eventKey)),
    client.getEventTeamsFull<Obj[]>(eventKey),
    safe(() => client.getEventRankings<Obj>(eventKey)),
    safe(() => client.getEventOprs<Obj>(eventKey)),
    safe(() => getEpaMap(eventKey)),
    safe(() => client.getEventMatches<Obj[]>(eventKey)),
  ]);
  const epaData = epaDataR ?? {};

  if (!teams || teams.length === 0) {
    return { error: 'No teams found for this event.' };
  }

  const eventCountry = (eventInfo?.country ?? '') as string;

  // ── Demographics ────────────────────────────────────────
  const total = teams.length;
  let rookieCount = 0;
  let veteranCount = 0;
  const countries = new Set<string>();
  let foreignCount = 0;
  const teamAges: number[] = [];

  for (const t of teams) {
    const ry = t.rookie_year as number | undefined;
    const country = (t.country ?? '') as string;
    if (country) countries.add(country);
    if (eventCountry && country && country !== eventCountry) foreignCount += 1;
    if (ry) teamAges.push(year - ry);
    if (ry && ry === year) rookieCount += 1;
    else if (ry && ry < year) veteranCount += 1;
  }

  const avgTeamAge = teamAges.length
    ? pyRound(teamAges.reduce((a, b) => a + b, 0) / teamAges.length, 1)
    : 0;

  const demographics = {
    total_teams: total,
    rookie_count: rookieCount,
    rookie_pct: total ? pyRound((100 * rookieCount) / total, 1) : 0,
    veteran_count: veteranCount,
    veteran_pct: total ? pyRound((100 * veteranCount) / total, 1) : 0,
    avg_team_age: avgTeamAge,
    foreign_count: foreignCount,
    foreign_pct: total ? pyRound((100 * foreignCount) / total, 1) : 0,
    event_country: eventCountry,
    country_count: countries.size,
    countries: [...countries].sort(),
  };

  // ── Hall of Fame & Impact Award (instant lookup) ────────
  const { hofByNum, impactByNum } = await ensureAwardLookups();
  const hofTeams: Obj[] = [];
  const impactFinalists: Obj[] = [];
  for (const t of teams) {
    const num = t.team_number as number;
    const info = {
      team_number: num,
      nickname: t.nickname ?? '',
      city: t.city ?? '',
      state_prov: t.state_prov ?? '',
      country: t.country ?? '',
    };
    if (hofByNum.has(num)) {
      hofTeams.push({ ...info, impact_years: hofByNum.get(num)!.years ?? [] });
    } else if (impactByNum.has(num)) {
      impactFinalists.push({ ...info, impact_years: impactByNum.get(num)!.years ?? [] });
    }
  }

  // ── Top 3 OPR contributors ──────────────────────────────
  const topScorers = computeTopScorers(teams, oprs, rankings, epaData);

  // ── High scores (by match) ──────────────────────────────
  const nameMapFull: Record<string, string> = {};
  for (const t of teams) nameMapFull[`frc${t.team_number}`] = t.nickname ?? '';
  const highScores = computeHighScores(matchesRaw, nameMapFull);

  return {
    event_key: eventKey,
    demographics,
    hall_of_fame: hofTeams,
    impact_finalists: impactFinalists,
    top_scorers: topScorers,
    high_scores: highScores,
    is_championship: eventInfo ? [3, 4].includes(eventInfo.event_type) : false,
  };
}

// ── get_event_summary_stats (summary_service.py:1292) ────────
export async function getEventSummaryStats(eventKey: string): Promise<Obj> {
  const client = getTbaClient();
  // Clear cache for rankings/OPRs/matches so we get fresh data.
  for (const suffix of ['/rankings', '/oprs', '/matches']) {
    client.clearCacheEntry(`/event/${eventKey}${suffix}`);
  }

  const [teams, rankings, oprs, epaDataR, matchesRaw] = await Promise.all([
    client.getEventTeams<Obj[]>(eventKey),
    safe(() => client.getEventRankings<Obj>(eventKey)),
    safe(() => client.getEventOprs<Obj>(eventKey)),
    safe(() => getEpaMap(eventKey)),
    safe(() => client.getEventMatches<Obj[]>(eventKey)),
  ]);
  const epaData = epaDataR ?? {};

  const nameMap: Record<string, string> = {};
  for (const t of teams ?? []) nameMap[t.key] = t.nickname ?? '';

  return {
    top_scorers: computeTopScorers(teams, oprs, rankings, epaData),
    high_scores: computeHighScores(matchesRaw, nameMap),
  };
}

// ── _compute_top_scorers (summary_service.py:1318) ───────────
function computeTopScorers(
  teams: Obj[] | null,
  oprs: Obj | null,
  rankings: Obj | null,
  epaData: Obj,
): Obj[] {
  if (!oprs || !oprs.oprs) return [];

  const nameMap: Record<string, Obj> = {};
  for (const t of teams ?? []) nameMap[t.key] = t;

  const rankMap: Record<string, number | string> = {};
  if (rankings && rankings.rankings) {
    for (const r of rankings.rankings as Obj[]) rankMap[r.team_key] = r.rank ?? 0;
  }

  const scored: Obj[] = [];
  for (const [tk, oprVal] of Object.entries(oprs.oprs as Record<string, number>)) {
    const t = nameMap[tk] ?? {};
    const epaInfo = (epaData[tk] ?? {}) as Obj;
    scored.push({
      team_key: tk,
      team_number: pyGet(t, 'team_number', Number(tk.replace('frc', ''))),
      nickname: pyGet(t, 'nickname', ''),
      opr: pyRound(oprVal, 2),
      epa: epaInfo.epa ?? null,
      rank: pyGet(rankMap, tk, '-'),
    });
  }

  scored.sort((a, b) => b.opr - a.opr);
  return scored.slice(0, 3);
}

// ── _match_label (summary_service.py:1354) ────────────────────
const COMP_LEVEL_LABELS_SHORT: Record<string, string> = {
  qm: 'Qual', ef: 'Eighths', qf: 'QF', sf: 'SF', f: 'F',
};

function matchLabel(m: Obj): string {
  const cl = (m.comp_level ?? 'qm') as string;
  const prefix = COMP_LEVEL_LABELS_SHORT[cl] ?? cl.toUpperCase();
  const mn = m.match_number ?? '?';
  if (cl === 'qm') return `${prefix} ${mn}`;
  const sn = m.set_number ?? '';
  return sn ? `${prefix} ${sn}-${mn}` : `${prefix} ${mn}`;
}

// ── _compute_high_scores (summary_service.py:1365) ────────────
function computeHighScores(matchesRaw: Obj[] | null, nameMap: Record<string, string>): Obj[] {
  if (!matchesRaw || matchesRaw.length === 0) return [];

  const entries: Obj[] = [];
  for (const m of matchesRaw) {
    const redScore = pyGet(m.alliances?.red ?? {}, 'score', -1) as number;
    if (m.winning_alliance == null && redScore < 0) continue;
    for (const color of ['red', 'blue'] as const) {
      const alliance = m.alliances?.[color] ?? {};
      const score = pyGet(alliance, 'score', -1) as number;
      if (score <= 0) continue;
      const teamKeys = (alliance.team_keys ?? []) as string[];
      const teamList = teamKeys.map((tk) => ({
        team_number: Number(tk.replace('frc', '')),
        nickname: nameMap[tk] ?? '',
      }));
      entries.push({
        score,
        match: matchLabel(m),
        match_key: m.key ?? '',
        color,
        teams: teamList,
      });
    }
  }

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, 3);
}

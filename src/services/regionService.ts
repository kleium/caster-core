/**
 * Region & Event History — port of get_event_history / _build_event_history
 * from backend/app/services/region_service.py.
 */
import { getTbaClient } from './tbaClient.js';
import { getCachedSummary, setCachedSummary } from './supabase.js';
import * as payloadCache from '../lib/payloadCache.js';
import { Semaphore } from '../lib/semaphore.js';

type Obj = Record<string, any>;

const API_SEMAPHORE = new Semaphore(10);
const HISTORY_TTL = 3600; // seconds — data is very stable (region_service.py:18)

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function semaphoreSafe<T>(fn: () => Promise<T>): Promise<T | null> {
  return safe(() => API_SEMAPHORE.run(fn));
}

/** Lowercase, strip combining marks (İ→i) — matches unicodedata NFKD stripping. */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

// ── Award type constants (region_service.py:55-60) ───────────
const AWARD_WINNER = 1;
const AWARD_FINALIST = 2;
const AWARD_IMPACT = 0;
const AWARD_EI = 9;
const AWARD_RAS = 10;

// ── Event code aliases — verbatim from region_service.py:65-123 ──────────
const EVENT_CODE_ALIASES: Record<string, string[]> = {
  flor: ['fl', 'flor'],
  flwp: ['sfl', 'flbr', 'flfo', 'flwp'],
  ohcl: ['oh', 'ohcl'],
  lake: ['la', 'lake'],
  scmb: ['sc', 'scmb'],
  gadu: ['ga', 'gadu'],
  cala: ['ca', 'calb', 'capo', 'cala'],
  casj: ['ca2', 'sj', 'casj'],
  cada: ['sac', 'casa', 'cada'],
  paca: ['papi', 'paca'],
  mdba: ['md', 'mdba', 'mdcp'],
  ilch: ['il', 'ilch'],
  gl: ['mi', 'mi1', 'gl'],
  txsa: ['stx', 'txsa'],
  nhgrs: ['nh', 'nhgrs', 'nhsal'],
  nyro: ['roc', 'nyro'],
  nyli2: ['li', 'nyli', 'nyli2'],
  nyny: ['ny2', 'nyny'],
  nytr: ['ny', 'nyal', 'nytr'],
  mabos: ['ma', 'mabos'],
  ctha: ['ct', 'ctha'],
  code: ['co', 'code'],
  hiho: ['hi', 'hiho'],
  utwv: ['ut', 'utwv'],
  wimi: ['wi', 'wimi'],
  mnmi: ['mn', 'mnmi'],
  okok: ['ok', 'okok'],
  arli: ['arfa', 'arli'],
  azva: ['az', 'azva'],
  onwat: ['wat', 'onwat'],
  brba: ['br', 'brbr', 'brba'],
  brsp: ['brsp'],
};

// Reverse lookup: any code -> set of all sibling codes (region_service.py:126-129).
const CODE_TO_FAMILY = new Map<string, Set<string>>();
for (const aliases of Object.values(EVENT_CODE_ALIASES)) {
  const set = new Set(aliases);
  for (const code of aliases) CODE_TO_FAMILY.set(code, set);
}

// ── get_event_history (region_service.py:140) ───────────────
export async function getEventHistory(eventKey: string): Promise<Obj> {
  // 1) Disk cache.
  const cached = await payloadCache.readPayload('history', eventKey, HISTORY_TTL);
  if (cached) {
    const { _ts, ...rest } = cached;
    return rest;
  }

  // 2) Supabase cache.
  const sbKey = `hist_${eventKey}`;
  const sbRow = await getCachedSummary(sbKey);
  if (sbRow && sbRow.summary) {
    await payloadCache.writePayload('history', eventKey, sbRow.summary as Obj);
    return sbRow.summary as Obj;
  }

  // 3) Build from scratch.
  const result = await buildEventHistory(eventKey);
  if (!('error' in result)) {
    await payloadCache.writePayload('history', eventKey, result);
    await setCachedSummary(sbKey, result, undefined);
  }
  return result;
}

interface YearData {
  year: number;
  event_key: string;
  winners: string[];
  finalists: string[];
  impact: string | null;
}

async function buildEventHistory(eventKey: string): Promise<Obj> {
  const client = getTbaClient();

  const event = await client.getEvent<Obj>(eventKey);
  if (!event) return { error: 'Event not found' };

  const eventCode = (event.first_event_code || eventKey.slice(4)) as string;
  const eventName = (event.name ?? eventKey) as string;
  const eventShort = normalizeName(event.short_name || '');
  const currentYear = Number(eventKey.slice(0, 4));
  const currentDistrictAbbr = (event.district ?? {}).abbreviation ?? '';

  const keyCode = eventKey.slice(4);
  let aliasCodes = CODE_TO_FAMILY.get(keyCode) ?? new Set([keyCode]);
  if (eventCode && eventCode !== keyCode) {
    const other = CODE_TO_FAMILY.get(eventCode) ?? new Set([eventCode]);
    aliasCodes = new Set([...aliasCodes, ...other]);
  }

  // Scan from 1992 (first FRC season) through current year, concurrency-limited.
  const years = Array.from({ length: currentYear - 1992 + 1 }, (_, i) => 1992 + i);
  const yearResults = await Promise.all(
    years.map((year) => API_SEMAPHORE.run(() => client.getEventsByYear<Obj[]>(year))),
  );

  const usedAliasMap = CODE_TO_FAMILY.has(keyCode);

  let allInstances: Obj[] = [];
  for (const events of yearResults) {
    if (!events) continue;
    for (const ev of events) {
      const ec = (ev.first_event_code ?? '') as string;
      const evKeyCode = (ev.key as string).slice(4);
      if (aliasCodes.has(evKeyCode) || (ec && aliasCodes.has(ec))) {
        allInstances.push(ev);
      }
    }
  }

  // Filter out events that reused the same code but are actually different.
  if (!usedAliasMap && eventShort && allInstances.length > 1) {
    const filtered = allInstances.filter((ev) => {
      const evShort = normalizeName(ev.short_name || '');
      const evDistrictAbbr = (ev.district ?? {}).abbreviation ?? '';
      return (
        evShort === eventShort ||
        (currentDistrictAbbr && evDistrictAbbr === currentDistrictAbbr)
      );
    });
    if (filtered.length) allInstances = filtered;
  }

  if (allInstances.length === 0) allInstances = [event];

  allInstances.sort((a, b) => ((a.start_date ?? '') < (b.start_date ?? '') ? -1 : 1));

  // Fetch awards for all instances in parallel.
  const awardResults = await Promise.all(
    allInstances.map((ev) => semaphoreSafe(() => client.get<Obj[]>(`/event/${ev.key}/awards`))),
  );

  const winners = new Map<string, number>();
  const finalists = new Map<string, number>();
  const impactWinners = new Map<string, number>();
  const eiWinners = new Map<string, number>();
  const rasWinners = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const teamInfoMap = new Map<string, { team_number: number; nickname: string }>();
  const yearlyResults: YearData[] = [];

  allInstances.forEach((ev, i) => {
    const awards = awardResults[i];
    if (!awards) return;
    const ek = ev.key as string;
    const year = Number(ek.slice(0, 4));
    const yearData: YearData = { year, event_key: ek, winners: [], finalists: [], impact: null };

    for (const a of awards) {
      const atype = a.award_type;
      for (const r of (a.recipient_list ?? []) as Obj[]) {
        const tk = r.team_key as string | undefined;
        if (!tk) continue;
        if (!teamInfoMap.has(tk)) {
          teamInfoMap.set(tk, { team_number: Number(tk.slice(3)), nickname: '' });
        }
        if (atype === AWARD_WINNER) {
          bump(winners, tk);
          yearData.winners.push(tk);
        } else if (atype === AWARD_FINALIST) {
          bump(finalists, tk);
          yearData.finalists.push(tk);
        } else if (atype === AWARD_IMPACT) {
          bump(impactWinners, tk);
          yearData.impact = tk;
        } else if (atype === AWARD_EI) {
          bump(eiWinners, tk);
        } else if (atype === AWARD_RAS) {
          bump(rasWinners, tk);
        }
      }
    }
    yearlyResults.push(yearData);
  });

  // Team info for top teams (names).
  const mostCommon = (m: Map<string, number>, limit: number): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);

  const topTks = new Set<string>();
  for (const counter of [winners, finalists, impactWinners, eiWinners]) {
    for (const tk of mostCommon(counter, 10)) topTks.add(tk);
  }
  for (const yr of yearlyResults) {
    for (const tk of yr.winners) topTks.add(tk);
    for (const tk of yr.finalists) topTks.add(tk);
    if (yr.impact) topTks.add(yr.impact);
  }

  const missingTks = [...topTks].filter((tk) => (teamInfoMap.get(tk)?.nickname ?? '') === '');
  if (missingTks.length) {
    const results = await Promise.all(
      missingTks.map((tk) => semaphoreSafe(() => client.get<Obj>(`/team/${tk}`))),
    );
    missingTks.forEach((tk, i) => {
      const info = results[i];
      if (info) {
        teamInfoMap.set(tk, {
          team_number: info.team_number ?? Number(tk.slice(3)),
          nickname: info.nickname ?? '',
        });
      }
    });
  }

  const buildLeaderboard = (counter: Map<string, number>, limit = 10): Obj[] =>
    [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tk, count]) => {
        const info = teamInfoMap.get(tk) ?? { team_number: Number(tk.slice(3)), nickname: '' };
        return { team_number: info.team_number, nickname: info.nickname, count };
      });

  const resolveTeams = (tks: string[]): Obj[] =>
    tks.map((tk) => {
      const info = teamInfoMap.get(tk);
      return {
        team_number: info?.team_number ?? Number(tk.slice(3)),
        nickname: info?.nickname ?? '',
      };
    });

  const timeline = yearlyResults.map((yr) => ({
    year: yr.year,
    event_key: yr.event_key,
    winners: resolveTeams(yr.winners),
    finalists: resolveTeams(yr.finalists),
    impact: yr.impact ? resolveTeams([yr.impact])[0] : null,
  }));
  timeline.sort((a, b) => b.year - a.year);

  const firstInstance = allInstances[0]!;
  const firstYear = Number((firstInstance.key as string).slice(0, 4));

  return {
    event_name: eventName,
    event_key: eventKey,
    first_held: firstYear,
    editions: allInstances.length,
    years_held: allInstances.map((e) => Number((e.key as string).slice(0, 4))).sort((a, b) => a - b),
    most_wins: buildLeaderboard(winners, 10),
    most_finalists: buildLeaderboard(finalists, 10),
    most_impact: buildLeaderboard(impactWinners, 10),
    most_ei: buildLeaderboard(eiWinners, 5),
    most_ras: buildLeaderboard(rasWinners, 5),
    timeline,
  };
}

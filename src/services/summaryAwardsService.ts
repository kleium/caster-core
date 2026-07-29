/**
 * Event Summary Awards — port of get_event_summary_awards /
 * _build_event_summary_awards (and its helpers) from
 * backend/app/services/summary_service.py.
 *
 * Deferred/heavier summary data: for regular events, returning past-event
 * champions/finalists + previous-season award winners; for championship
 * divisions/finals (event_type 3/4), current-season winners/impact recipients
 * + returning Einstein contenders.
 */
import { getTbaClient } from './tbaClient.js';
import { getEventHistory } from './regionService.js';
import { ensureEinsteinLookup } from '../lib/einsteinHistory.js';
import { getCachedSummary, setCachedSummary } from './supabase.js';
import * as payloadCache from '../lib/payloadCache.js';
import { Semaphore } from '../lib/semaphore.js';

type Obj = Record<string, any>;

const API_SEMAPHORE = new Semaphore(10);
const AWARDS_TTL = 3600; // seconds (summary_service.py:19)
const SEASON_AWARDS_TTL = 3600; // seconds (summary_service.py:21)

// Bump whenever the championship awards payload format changes in a way that
// requires existing Supabase cache entries to be invalidated (summary_service.py:26).
const EINSTEIN_CACHE_VERSION = 4;

const AWARD_TYPE_IMPACT = 0;
const AWARD_TYPE_WINNER = 1;
const AWARD_TYPE_FINALIST = 2;
const CHAMPIONSHIP_EVENT_TYPES = new Set([3, 4]);

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await API_SEMAPHORE.run(fn);
  } catch {
    return null;
  }
}

// ── get_event_summary_awards (summary_service.py:232) ────────
export async function getEventSummaryAwards(eventKey: string): Promise<Obj> {
  // 1) Disk cache.
  const cached = await payloadCache.readPayload('awards', eventKey, AWARDS_TTL);
  if (cached && 'is_championship' in cached) {
    if (!cached.is_championship || cached.einstein_v === EINSTEIN_CACHE_VERSION) {
      return cached;
    }
  }

  // 2) Supabase cache.
  const sbRow = await getCachedSummary(eventKey);
  if (sbRow && sbRow.awards) {
    const awards = sbRow.awards as Obj;
    if ('is_championship' in awards) {
      if (!awards.is_championship || awards.einstein_v === EINSTEIN_CACHE_VERSION) {
        await payloadCache.writePayload('awards', eventKey, awards);
        return awards;
      }
    }
  }

  // 3) Build from scratch — fall back to stale disk cache if the live build fails.
  let result: Obj;
  try {
    result = await buildEventSummaryAwards(eventKey);
  } catch (err) {
    const stale = await payloadCache.readStale('awards', eventKey);
    if (stale && 'is_championship' in stale) return stale;
    throw err;
  }
  await payloadCache.writePayload('awards', eventKey, result);

  const persistKeys = [
    'past_event_champions', 'past_season_awards', 'current_season_winners',
    'impact_recipients', 'season_winners', 'season_impact', 'einstein_contenders',
  ];
  if (result.is_championship || persistKeys.some((k) => truthy(result[k]))) {
    await setCachedSummary(eventKey, undefined, result);
  }
  return result;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

async function buildEventSummaryAwards(eventKey: string): Promise<Obj> {
  const client = getTbaClient();
  const year = Number(eventKey.slice(0, 4));

  const [eventHistory, teams, eventInfo] = await Promise.all([
    safe(() => getEventHistory(eventKey)),
    client.getEventTeamsFull<Obj[]>(eventKey),
    safe(() => client.getEvent<Obj>(eventKey)),
  ]);
  const currentEventType = (eventInfo?.event_type ?? -1) as number;
  const isChamp = CHAMPIONSHIP_EVENT_TYPES.has(currentEventType);

  if (!teams || teams.length === 0) {
    return { is_championship: isChamp, past_event_champions: [], past_season_awards: [] };
  }

  if (CHAMPIONSHIP_EVENT_TYPES.has(currentEventType)) {
    return buildChampsAwards(client, teams, year);
  }

  // ── Regular event flow ──────────────────────────────────
  const allianceCache: Record<string, Obj[]> = {};
  if (eventHistory && eventHistory.timeline) {
    const histKeys = (eventHistory.timeline as Obj[])
      .map((yr) => yr.event_key as string)
      .filter(Boolean);
    const allianceResults = await Promise.all(
      histKeys.map((ek) => safe(() => client.getEventAlliances<Obj[]>(ek))),
    );
    histKeys.forEach((ek, i) => {
      if (allianceResults[i]) allianceCache[ek] = allianceResults[i]!;
    });
  }

  const pastEventChampions = extractPastEventChampions(eventHistory, teams, year, allianceCache);

  const prevYear = year - 1;
  const prevAwardResults = await Promise.all(
    teams.map((t) => safe(() => client.getTeamAwardsYear<Obj[]>(`frc${t.team_number}`, prevYear))),
  );
  const pastSeasonAwards = await buildPastSeasonAwards(client, teams, prevAwardResults, prevYear, false);

  return {
    is_championship: false,
    past_event_champions: pastEventChampions,
    past_season_awards: pastSeasonAwards,
  };
}

// ── _extract_past_event_champions (summary_service.py:809) ───
const PICK_LABELS = ['Captain', '1st Pick', '2nd Pick', 'Backup'];

function extractPastEventChampions(
  eventHistory: Obj | null,
  teams: Obj[],
  currentYear: number,
  allianceCache: Record<string, Obj[]>,
): Obj[] {
  if (!eventHistory || !eventHistory.timeline) return [];

  const teamNums = new Set(teams.map((t) => t.team_number as number));
  const nameMap: Record<number, string> = {};
  for (const t of teams) nameMap[t.team_number as number] = t.nickname ?? '';

  const champMap = new Map<number, { years_won: Obj[]; years_finalist: Obj[] }>();

  for (const yrData of eventHistory.timeline as Obj[]) {
    const yr = yrData.year as number;
    const ek = (yrData.event_key ?? '') as string;
    if (yr >= currentYear) continue;

    const pickMap: Record<string, { pick: string; alliance: string | number }> = {};
    const alliancesRaw = allianceCache[ek] ?? [];
    for (const al of alliancesRaw) {
      const nameParts = ((al.name ?? '') as string).split(/\s+/).filter(Boolean);
      const alNum = al.number ?? (nameParts.length ? nameParts[nameParts.length - 1] : '');
      const backupIn = (al.backup ?? {})?.in as string | undefined;
      ((al.picks ?? []) as string[]).forEach((tk, idx) => {
        if (idx < PICK_LABELS.length) {
          const label = tk === backupIn ? 'Backup' : PICK_LABELS[idx]!;
          pickMap[tk] = { pick: label, alliance: alNum };
        }
      });
    }

    for (const w of (yrData.winners ?? []) as Obj[]) {
      const num = w.team_number as number;
      if (teamNums.has(num)) {
        if (!champMap.has(num)) champMap.set(num, { years_won: [], years_finalist: [] });
        const info = pickMap[`frc${num}`] ?? ({} as { pick?: string; alliance?: string | number });
        champMap.get(num)!.years_won.push({ year: yr, pick: info.pick ?? '', alliance: info.alliance ?? '' });
      }
    }
    for (const f of (yrData.finalists ?? []) as Obj[]) {
      const num = f.team_number as number;
      if (teamNums.has(num)) {
        if (!champMap.has(num)) champMap.set(num, { years_won: [], years_finalist: [] });
        const info = pickMap[`frc${num}`] ?? ({} as { pick?: string; alliance?: string | number });
        champMap.get(num)!.years_finalist.push({ year: yr, pick: info.pick ?? '', alliance: info.alliance ?? '' });
      }
    }
  }

  const result: Obj[] = [];
  for (const num of [...champMap.keys()].sort((a, b) => a - b)) {
    const d = champMap.get(num)!;
    result.push({
      team_number: num,
      nickname: nameMap[num] ?? '',
      years_won: [...d.years_won].sort((a, b) => a.year - b.year),
      years_finalist: [...d.years_finalist].sort((a, b) => a.year - b.year),
    });
  }
  return result;
}

// ── Shared pick-map builder for winner events (used by both champs + past-season) ──
function buildPickMaps(
  ekList: string[],
  allianceResults: (Obj[] | null)[],
  eventTypes: Record<string, number>,
): Record<string, Record<string, { pick: string; alliance: string | number }>> {
  const pickMaps: Record<string, Record<string, { pick: string; alliance: string | number }>> = {};
  ekList.forEach((ek, i) => {
    const alliances = allianceResults[i];
    if (!alliances) return;
    const pm: Record<string, { pick: string; alliance: string | number }> = {};
    const ekIsChamp = CHAMPIONSHIP_EVENT_TYPES.has(eventTypes[ek] ?? -1);
    const labels = ekIsChamp
      ? ['Captain', '1st Pick', '2nd Pick', '3rd Pick']
      : ['Captain', '1st Pick', '2nd Pick', 'Backup'];
    for (const al of alliances) {
      const nameParts = ((al.name ?? '') as string).split(/\s+/).filter(Boolean);
      const alNum = al.number ?? (nameParts.length ? nameParts[nameParts.length - 1] : '');
      const backupIn = (al.backup ?? {})?.in as string | undefined;
      ((al.picks ?? []) as string[]).forEach((tk, idx) => {
        if (idx < labels.length) {
          const label = tk === backupIn ? 'Backup' : labels[idx]!;
          pm[tk] = { pick: label, alliance: alNum };
        }
      });
    }
    pickMaps[ek] = pm;
  });
  return pickMaps;
}

// ── _build_champs_awards (summary_service.py:889) ─────────────
async function buildChampsAwards(client: ReturnType<typeof getTbaClient>, teams: Obj[], year: number): Promise<Obj> {
  const nameMap: Record<number, string> = {};
  const teamNums: number[] = [];
  for (const t of teams) {
    nameMap[t.team_number as number] = t.nickname ?? '';
    teamNums.push(t.team_number as number);
  }

  const awardResults = await Promise.all(
    teams.map((t) => safe(() => client.getTeamAwardsYear<Obj[]>(`frc${t.team_number}`, year))),
  );

  const winners: Record<number, Obj[]> = {};
  const impact: Record<number, Obj[]> = {};
  const allianceEventKeys = new Set<string>();
  const awardEventKeys = new Set<string>();

  teams.forEach((t, i) => {
    const awards = awardResults[i];
    if (!awards) return;
    const num = t.team_number as number;
    for (const a of awards) {
      const atype = a.award_type;
      const ek = (a.event_key ?? '') as string;
      if (atype === AWARD_TYPE_IMPACT) {
        (impact[num] ??= []).push({ event_key: ek });
        awardEventKeys.add(ek);
      } else if (atype === AWARD_TYPE_WINNER) {
        (winners[num] ??= []).push({ event_key: ek });
        awardEventKeys.add(ek);
        allianceEventKeys.add(ek);
      }
    }
  });

  const ekList = [...awardEventKeys].sort();
  const allianceEkList = [...allianceEventKeys].sort();
  const [infoResults, allianceResults] = await Promise.all([
    Promise.all(ekList.map((ek) => safe(() => client.getEvent<Obj>(ek)))),
    Promise.all(allianceEkList.map((ek) => safe(() => client.getEventAlliances<Obj[]>(ek)))),
  ]);

  const eventNames: Record<string, string> = {};
  const eventTypes: Record<string, number> = {};
  ekList.forEach((ek, i) => {
    const info = infoResults[i];
    if (info) {
      eventNames[ek] = info.short_name || info.name || ek;
      eventTypes[ek] = info.event_type ?? -1;
    } else {
      eventNames[ek] = ek;
      eventTypes[ek] = -1;
    }
  });

  const pickMaps = buildPickMaps(allianceEkList, allianceResults, eventTypes);

  const seasonWinners: Obj[] = [];
  for (const num of Object.keys(winners).map(Number).sort((a, b) => a - b)) {
    const entries: Obj[] = [];
    for (const w of winners[num]!) {
      const ek = w.event_key as string;
      if (CHAMPIONSHIP_EVENT_TYPES.has(eventTypes[ek] ?? -1)) continue;
      const info = pickMaps[ek]?.[`frc${num}`] ?? ({} as { pick?: string; alliance?: string | number });
      const entry: Obj = { type: 'winner', event_key: ek, event_name: eventNames[ek] ?? ek };
      if (info.pick) {
        entry.pick = info.pick;
        entry.alliance = info.alliance ?? '';
      }
      entries.push(entry);
    }
    if (entries.length) seasonWinners.push({ team_number: num, nickname: nameMap[num] ?? '', awards: entries });
  }

  const seasonImpact: Obj[] = [];
  for (const num of Object.keys(impact).map(Number).sort((a, b) => a - b)) {
    const entries: Obj[] = [];
    for (const a of impact[num]!) {
      const ek = a.event_key as string;
      if (CHAMPIONSHIP_EVENT_TYPES.has(eventTypes[ek] ?? -1)) continue;
      entries.push({ type: 'impact', event_key: ek, event_name: eventNames[ek] ?? ek });
    }
    if (entries.length) seasonImpact.push({ team_number: num, nickname: nameMap[num] ?? '', awards: entries });
  }

  // ── Returning Einstein contenders ───────────────────────
  const einsteinByNum = await ensureEinsteinLookup();
  const einsteinContenders: Obj[] = [];
  for (const num of [...teamNums].sort((a, b) => a - b)) {
    const entry = einsteinByNum.get(num);
    if (!entry) continue;
    const contenderYears = entry.contender_years ?? [];
    const winnerYears = entry.winner_years ?? [];
    if (contenderYears.length === 0) continue;
    if (Math.max(...contenderYears) !== year - 1 && winnerYears.length === 0) continue;
    einsteinContenders.push({
      team_number: num,
      nickname: nameMap[num] || entry.nickname || '',
      einstein_winner: winnerYears.length > 0,
      contender_count: contenderYears.length,
      winner_count: winnerYears.length,
    });
  }

  return {
    is_championship: true,
    einstein_v: EINSTEIN_CACHE_VERSION,
    season_winners: seasonWinners,
    season_impact: seasonImpact,
    einstein_contenders: einsteinContenders,
  };
}

// ── _build_past_season_awards (summary_service.py:1047) ───────
async function buildPastSeasonAwards(
  client: ReturnType<typeof getTbaClient>,
  teams: Obj[],
  prevAwardResults: (Obj[] | null)[],
  _prevYear: number,
  includeChamps: boolean,
): Promise<Obj[]> {
  const nameMap: Record<number, string> = {};
  for (const t of teams) nameMap[t.team_number as number] = t.nickname ?? '';

  const teamAwardMap: Record<number, Obj[]> = {};
  const awardEventKeys = new Set<string>();
  const allianceEventKeys = new Set<string>();

  teams.forEach((t, i) => {
    const awards = prevAwardResults[i];
    if (!awards) return;
    const num = t.team_number as number;
    for (const a of awards) {
      const atype = a.award_type;
      if (![AWARD_TYPE_IMPACT, AWARD_TYPE_WINNER, AWARD_TYPE_FINALIST].includes(atype)) continue;
      const ek = (a.event_key ?? '') as string;
      const label = { 0: 'impact', 1: 'winner', 2: 'finalist' }[atype as 0 | 1 | 2] ?? '';
      (teamAwardMap[num] ??= []).push({ type: label, event_key: ek });
      awardEventKeys.add(ek);
      if (atype === AWARD_TYPE_WINNER || atype === AWARD_TYPE_FINALIST) allianceEventKeys.add(ek);
    }
  });

  if (Object.keys(teamAwardMap).length === 0) return [];

  const ekList = [...awardEventKeys];
  const allianceEkList = [...allianceEventKeys];
  const [infos, allianceResults] = await Promise.all([
    Promise.all(ekList.map((ek) => safe(() => client.getEvent<Obj>(ek)))),
    Promise.all(allianceEkList.map((ek) => safe(() => client.getEventAlliances<Obj[]>(ek)))),
  ]);

  const eventNames: Record<string, string> = {};
  const eventTypes: Record<string, number> = {};
  ekList.forEach((ek, i) => {
    const info = infos[i];
    if (info) {
      eventNames[ek] = info.short_name || info.name || ek;
      eventTypes[ek] = info.event_type ?? -1;
    } else {
      eventNames[ek] = ek;
      eventTypes[ek] = -1;
    }
  });

  const pickMaps = buildPickMaps(allianceEkList, allianceResults, eventTypes);

  const result: Obj[] = [];
  for (const num of Object.keys(teamAwardMap).map(Number).sort((a, b) => a - b)) {
    const filtered: Obj[] = [];
    for (const a of teamAwardMap[num]!) {
      const ek = a.event_key as string;
      if (!includeChamps && CHAMPIONSHIP_EVENT_TYPES.has(eventTypes[ek] ?? -1)) continue;
      let info: { pick?: string; alliance?: string | number } = {};
      if (a.type === 'winner' || a.type === 'finalist') {
        info = pickMaps[ek]?.[`frc${num}`] ?? ({} as { pick?: string; alliance?: string | number });
      }
      const entry: Obj = { type: a.type, event_key: ek, event_name: eventNames[ek] ?? ek };
      if (info.pick) {
        entry.pick = info.pick;
        entry.alliance = info.alliance ?? '';
      }
      filtered.push(entry);
    }
    if (filtered.length) result.push({ team_number: num, nickname: nameMap[num] ?? '', awards: filtered });
  }
  return result;
}

// ── get_current_season_awards (summary_service.py:1147) ──────
export async function getCurrentSeasonAwards(eventKey: string): Promise<Obj> {
  // 1) Disk cache.
  const cached = await payloadCache.readPayload('season_awards', eventKey, SEASON_AWARDS_TTL);
  if (cached) {
    const { _ts, ...rest } = cached;
    return rest;
  }

  // 2) Supabase cache.
  const sbKey = `seas_${eventKey}`;
  const sbRow = await getCachedSummary(sbKey);
  if (sbRow && sbRow.summary) {
    await payloadCache.writePayload('season_awards', eventKey, sbRow.summary as Obj);
    return sbRow.summary as Obj;
  }

  // 3) Build from scratch.
  const result = await buildCurrentSeasonAwards(eventKey);
  await payloadCache.writePayload('season_awards', eventKey, result);
  if (truthy(result.season_awards)) {
    await setCachedSummary(sbKey, result, undefined);
  }
  return result;
}

async function buildCurrentSeasonAwards(eventKey: string): Promise<Obj> {
  const client = getTbaClient();
  const year = Number(eventKey.slice(0, 4));

  const teams = await client.getEventTeamsFull<Obj[]>(eventKey);
  if (!teams || teams.length === 0) return { season_awards: [] };

  const awardResults = await Promise.all(
    teams.map((t) => safe(() => client.getTeamAwardsYear<Obj[]>(`frc${t.team_number}`, year))),
  );

  const nameMap: Record<number, string> = {};
  for (const t of teams) nameMap[t.team_number as number] = t.nickname ?? '';

  const teamAwardMap: Record<number, Obj[]> = {};
  const awardEventKeys = new Set<string>();
  const allianceEventKeys = new Set<string>();

  teams.forEach((t, i) => {
    const awards = awardResults[i];
    if (!awards) return;
    const num = t.team_number as number;
    for (const a of awards) {
      const atype = a.award_type;
      if (![AWARD_TYPE_IMPACT, AWARD_TYPE_WINNER, AWARD_TYPE_FINALIST].includes(atype)) continue;
      const ek = (a.event_key ?? '') as string;
      // Exclude awards from the current event itself.
      if (ek === eventKey) continue;
      const label = { 0: 'impact', 1: 'winner', 2: 'finalist' }[atype as 0 | 1 | 2] ?? '';
      (teamAwardMap[num] ??= []).push({ type: label, event_key: ek });
      awardEventKeys.add(ek);
      if (atype === AWARD_TYPE_WINNER || atype === AWARD_TYPE_FINALIST) allianceEventKeys.add(ek);
    }
  });

  if (Object.keys(teamAwardMap).length === 0) return { season_awards: [] };

  const ekList = [...awardEventKeys];
  const allianceEkList = [...allianceEventKeys];
  const [infos, allianceResults] = await Promise.all([
    Promise.all(ekList.map((ek) => safe(() => client.getEvent<Obj>(ek)))),
    Promise.all(allianceEkList.map((ek) => safe(() => client.getEventAlliances<Obj[]>(ek)))),
  ]);

  const eventNames: Record<string, string> = {};
  const eventTypesCs: Record<string, number> = {};
  ekList.forEach((ek, i) => {
    const info = infos[i];
    if (info) {
      eventNames[ek] = info.short_name || info.name || ek;
      eventTypesCs[ek] = info.event_type ?? -1;
    } else {
      eventNames[ek] = ek;
      eventTypesCs[ek] = -1;
    }
  });

  const pickMaps = buildPickMaps(allianceEkList, allianceResults, eventTypesCs);

  const result: Obj[] = [];
  for (const num of Object.keys(teamAwardMap).map(Number).sort((a, b) => a - b)) {
    const entries: Obj[] = [];
    for (const a of teamAwardMap[num]!) {
      const ek = a.event_key as string;
      let info: { pick?: string; alliance?: string | number } = {};
      if (a.type === 'winner' || a.type === 'finalist') {
        info = pickMaps[ek]?.[`frc${num}`] ?? ({} as { pick?: string; alliance?: string | number });
      }
      const entry: Obj = { type: a.type, event_key: ek, event_name: eventNames[ek] ?? ek };
      if (info.pick) {
        entry.pick = info.pick;
        entry.alliance = info.alliance ?? '';
      }
      entries.push(entry);
    }
    if (entries.length) result.push({ team_number: num, nickname: nameMap[num] ?? '', awards: entries });
  }

  // Sort: impact first, then winner, then finalist.
  const sortKey = (t: Obj): number => {
    const types = new Set((t.awards as Obj[]).map((a) => a.type));
    if (types.has('impact')) return 0;
    if (types.has('winner')) return 1;
    return 2;
  };
  result.sort((a, b) => sortKey(a) - sortKey(b));

  return { season_awards: result };
}

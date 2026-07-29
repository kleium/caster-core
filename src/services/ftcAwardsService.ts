/**
 * FTC awards — port of get_event_awards / get_ftc_past_season_awards /
 * get_ftc_current_season_awards from backend/app/services/ftc_event_service.py.
 */
import { getFtcClient } from './ftcClient.js';
import { getCachedSummary, setCachedSummary } from './supabase.js';
import * as payloadCache from '../lib/payloadCache.js';
import { Semaphore } from '../lib/semaphore.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';
import { parseFtcKey } from '../lib/ftcKey.js';

type Obj = Record<string, any>;

const API_SEMAPHORE = new Semaphore(10);

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await API_SEMAPHORE.run(fn);
  } catch {
    return null;
  }
}

// Award IDs that matter for summary (ftc_event_service.py:964-974).
const FTC_INSPIRE_ID = 11;
const FTC_WINNER_ID = 13;
const FTC_FINALIST_ID = 12;
const FTC_INTERESTING_AWARD_IDS = new Set([FTC_INSPIRE_ID, FTC_WINNER_ID, FTC_FINALIST_ID]);
const FTC_AWARD_TYPE_MAP: Record<number, string> = {
  [FTC_INSPIRE_ID]: 'inspire',
  [FTC_WINNER_ID]: 'winner',
  [FTC_FINALIST_ID]: 'finalist',
};
const NON_COMP_TYPES = new Set(['0', '12', '14', '15']); // Scrimmage, Kickoff, PracticeDay, Volunteer

/** Sort: inspire first, then winners, then finalists (shared by both award funcs). */
function sortByAwardPriority(rows: Obj[]): void {
  const rank = (t: Obj): number => {
    const types = new Set((t.awards as Obj[]).map((a) => a.type));
    if (types.has('inspire')) return 0;
    if (types.has('winner')) return 1;
    return 2;
  };
  rows.sort((a, b) => rank(a) - rank(b));
}

// ── get_event_awards (ftc_event_service.py:945) ────────────────
export async function getEventAwards(eventKey: string): Promise<Obj[]> {
  const [year, eventCode] = parseFtcKey(eventKey);
  const client = getFtcClient();
  const raw = await client.getEventAwards(year, eventCode);
  return raw.map((a) => ({
    name: a.name ?? '',
    award_type: a.awardId ?? null,
    team_number: a.teamNumber ?? null,
    person: a.person ?? null,
    event_key: eventKey,
  }));
}

interface TeamNameLookup {
  teamNums: number[];
  teamNames: Record<number, string>;
}

async function loadEventTeams(year: number, eventCode: string): Promise<TeamNameLookup | null> {
  const client = getFtcClient();
  const rawTeams = await client.getEventTeams(year, eventCode);
  if (rawTeams.length === 0) return null;

  const teamNums: number[] = [];
  const teamNames: Record<number, string> = {};
  for (const t of rawTeams) {
    const num = t.teamNumber ?? 0;
    if (!num) continue;
    teamNums.push(num);
    teamNames[num] = t.nameShort || t.nameFull || `Team ${num}`;
  }
  return { teamNums, teamNames };
}

/** Resolve event codes → names for a season, flagging scrimmage/non-competition codes. */
async function resolveEventNames(
  season: number,
  codes: Set<string>,
): Promise<{ nameMap: Record<string, string>; scrimmageCodes: Set<string> }> {
  const nameMap: Record<string, string> = {};
  const scrimmageCodes = new Set<string>();
  if (codes.size === 0) return { nameMap, scrimmageCodes };
  try {
    const client = getFtcClient();
    const seasonEvents = await client.getEvents(season);
    for (const ev of seasonEvents) {
      const ec = ev.code ?? '';
      if (codes.has(ec)) {
        nameMap[ec] = ev.name ?? ec;
        if (NON_COMP_TYPES.has(String(ev.type ?? ''))) scrimmageCodes.add(ec);
      }
    }
  } catch {
    /* fallback: event code shown as-is */
  }
  return { nameMap, scrimmageCodes };
}

// ── get_ftc_past_season_awards (ftc_event_service.py:977) ──────
export async function getFtcPastSeasonAwards(eventKey: string): Promise<Obj> {
  const sbKey = `ftc_${eventKey}`;

  // 1) Disk cache (30 min TTL).
  const cached = await payloadCache.readPayload('ftc_past_awards', eventKey, 1800);
  if (cached) {
    const { _ts, ...rest } = cached;
    return rest;
  }

  // 2) Supabase cache.
  const sbRow = await getCachedSummary(sbKey);
  if (sbRow && sbRow.awards) {
    await payloadCache.writePayload('ftc_past_awards', eventKey, sbRow.awards as Obj);
    return sbRow.awards as Obj;
  }

  const [year, eventCode] = parseFtcKey(eventKey);
  const client = getFtcClient();
  const prevSeason = year - 1;

  const teams = await loadEventTeams(year, eventCode);
  if (!teams) return { past_season_awards: [] };
  const { teamNums, teamNames } = teams;

  const results = await Promise.all(
    teamNums.map(async (num) => {
      const awards = (await safe(() => client.getTeamAwards(prevSeason, num))) ?? [];
      return [num, awards] as [number, Obj[]];
    }),
  );

  const allEventCodes = new Set<string>();
  for (const [, awards] of results) {
    for (const a of awards) {
      if (a.eventCode) allEventCodes.add(a.eventCode);
    }
  }
  const { nameMap: eventNameMap, scrimmageCodes } = await resolveEventNames(prevSeason, allEventCodes);

  const pastAwards: Obj[] = [];
  for (const [num, awards] of results) {
    if (awards.length === 0) continue;
    const interesting = awards.filter(
      (a) => FTC_INTERESTING_AWARD_IDS.has(a.awardId) && !scrimmageCodes.has(a.eventCode ?? ''),
    );
    if (interesting.length === 0) continue;
    const teamEntry: Obj = { team_number: num, nickname: teamNames[num] ?? `Team ${num}`, awards: [] };
    for (const a of interesting) {
      const ec = a.eventCode ?? '';
      teamEntry.awards.push({
        name: a.name ?? '',
        event_name: eventNameMap[ec] ?? ec,
        type: FTC_AWARD_TYPE_MAP[a.awardId] ?? 'other',
      });
    }
    pastAwards.push(teamEntry);
  }

  sortByAwardPriority(pastAwards);

  const result = { past_season_awards: pastAwards, prev_season: prevSeason };
  await payloadCache.writePayload('ftc_past_awards', eventKey, { ...result });
  if (pastAwards.length) await setCachedSummary(sbKey, undefined, result);
  return result;
}

// ── get_ftc_current_season_awards (ftc_event_service.py:1094) ──
export async function getFtcCurrentSeasonAwards(eventKey: string): Promise<Obj> {
  const sbKey = `ftc_${eventKey}`;

  // 1) Disk cache (10 min TTL).
  const cached = await payloadCache.readPayload('ftc_season_awards', eventKey, 600);
  if (cached) {
    const { _ts, ...rest } = cached;
    return rest;
  }

  // 2) Supabase cache.
  const sbRow = await getCachedSummary(sbKey);
  if (sbRow && sbRow.summary) {
    await payloadCache.writePayload('ftc_season_awards', eventKey, sbRow.summary as Obj);
    return sbRow.summary as Obj;
  }

  const [year, eventCode] = parseFtcKey(eventKey);
  const client = getFtcClient();

  const teams = await loadEventTeams(year, eventCode);
  if (!teams) return { season_awards: [], season: year };
  const { teamNums, teamNames } = teams;

  const results = await Promise.all(
    teamNums.map(async (num) => {
      const awards = (await safe(() => client.getTeamAwards(year, num))) ?? [];
      return [num, awards] as [number, Obj[]];
    }),
  );

  // Collect event codes for name resolution (exclude the current event).
  const allEventCodes = new Set<string>();
  for (const [, awards] of results) {
    for (const a of awards) {
      const ec = a.eventCode ?? '';
      if (ec && ec.toUpperCase() !== eventCode.toUpperCase()) allEventCodes.add(ec);
    }
  }
  const { nameMap: eventNameMap, scrimmageCodes } = await resolveEventNames(year, allEventCodes);

  // Only the big 3, from OTHER events, excluding scrimmages.
  const seasonAwards: Obj[] = [];
  for (const [num, awards] of results) {
    if (awards.length === 0) continue;
    const interesting = awards.filter(
      (a) =>
        FTC_INTERESTING_AWARD_IDS.has(a.awardId) &&
        (a.eventCode ?? '').toUpperCase() !== eventCode.toUpperCase() &&
        !scrimmageCodes.has(a.eventCode ?? ''),
    );
    if (interesting.length === 0) continue;
    const teamEntry: Obj = { team_number: num, nickname: teamNames[num] ?? `Team ${num}`, awards: [] };
    for (const a of interesting) {
      const ec = a.eventCode ?? '';
      teamEntry.awards.push({
        name: a.name ?? '',
        event_name: eventNameMap[ec] ?? ec,
        type: FTC_AWARD_TYPE_MAP[a.awardId] ?? 'other',
      });
    }
    seasonAwards.push(teamEntry);
  }

  sortByAwardPriority(seasonAwards);

  const result = { season_awards: seasonAwards, season: year };
  await payloadCache.writePayload('ftc_season_awards', eventKey, { ...result });
  if (seasonAwards.length) await setCachedSummary(sbKey, result, undefined);
  return result;
}

// ── Batch team awards summary (ftc_event_service.py:1230) ───

/** FTC "blue banner" equivalent: Inspire + Winning Alliance. */
const FTC_BLUE_BANNER_IDS = new Set([FTC_INSPIRE_ID, FTC_WINNER_ID]);

const FTC_AWARD_NAME_MAP: Record<number, string> = {
  11: 'Inspire Award',
  13: 'Winning Alliance',
  12: 'Finalist Alliance',
  1: 'Think Award',
  2: 'Connect Award',
  3: 'Innovate Award',
  4: 'Design Award',
  5: 'Motivate Award',
  6: 'Control Award',
  7: 'Promote Award',
  9: 'Compass Award',
  10: "Judges' Award",
};

/**
 * Recent FTC awards (last 3 seasons) for a batch of teams, keyed by team
 * number as a string — mirrors the FRC `getAwardsSummary` shape so the
 * frontend renderer handles both uniformly. ftc_event_service.py:1230.
 */
export async function getFtcTeamAwardsSummary(teamNumbers: number[]): Promise<Obj> {
  const client = getFtcClient();
  const currentYear = new Date().getFullYear();
  const recentCutoff = currentYear - 3;
  const seasons: number[] = [];
  for (let y = currentYear; y >= recentCutoff; y -= 1) seasons.push(y);

  // Shared across teams, exactly like the Python closure's dict.
  const eventNameCache = new Map<string, string>();

  const resolveEventNames = async (season: number, codes: Set<string>): Promise<void> => {
    if (!codes.size) return;
    const unknown = [...codes].filter((c) => !eventNameCache.has(`${season}:${c}`));
    if (!unknown.length) return;
    try {
      const events = await client.getEvents(season);
      for (const ev of events) {
        const ec = pyGet(ev, 'code', '') as string;
        if (ec) eventNameCache.set(`${season}:${ec}`, pyGet(ev, 'name', ec) as string);
      }
    } catch {
      /* names are best-effort */
    }
  };

  const sem = new Semaphore(10);

  const fetchTeam = async (num: number): Promise<Obj> => {
    const blueBanners: Obj[] = [];
    const recentAwards: Obj[] = [];
    const allEventCodes = new Map<number, Set<string>>();

    for (const season of seasons) {
      let awards: Obj[];
      try {
        awards = await sem.run(() => client.getTeamAwards(season, num));
      } catch {
        continue;
      }

      for (const a of awards) {
        const awardId = a.awardId;
        const ec = pyGet(a, 'eventCode', '') as string;
        if (ec) {
          if (!allEventCodes.has(season)) allEventCodes.set(season, new Set());
          allEventCodes.get(season)!.add(ec);
        }

        const isBanner = FTC_BLUE_BANNER_IDS.has(awardId);
        const entry = {
          name: pyOr(a.name, pyGet(FTC_AWARD_NAME_MAP, awardId, `Award #${awardId}`)),
          year: season,
          event_key: ec,
          event_name: ec, // placeholder — resolved below
          is_blue_banner: isBanner,
        };
        if (isBanner) blueBanners.push(entry);
        recentAwards.push(entry);
      }
    }

    for (const [season, codes] of allEventCodes) {
      await resolveEventNames(season, codes);
    }

    // Both lists hold the SAME entry objects, so resolving once would suffice —
    // but Python walks both, and the objects are shared there too. Kept as-is.
    for (const a of recentAwards) {
      const resolved = eventNameCache.get(`${a.year}:${a.event_key}`);
      if (resolved) a.event_name = resolved;
    }
    for (const a of blueBanners) {
      const resolved = eventNameCache.get(`${a.year}:${a.event_key}`);
      if (resolved) a.event_name = resolved;
    }

    recentAwards.sort((x, y) => (pyGet(y, 'year', 0) as number) - (pyGet(x, 'year', 0) as number));

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

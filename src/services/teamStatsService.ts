/**
 * Team stats — highest stage of play + per-season achievements. Port of the
 * `get_team_stats` / `_get_season_achievements` half of
 * backend/app/services/team_service.py.
 *
 * Awards-summary and head-to-head live in teamLookupService.ts — same Python
 * file, but separate concerns (batch award rollup / cross-team match history).
 */
import { getTbaClient } from './tbaClient.js';
import { getFrcClient } from './frcClient.js';
import { readFrcPlayoffMatches } from './supabase.js';
import { coalesce } from '../lib/inflight.js';
import { pyGet, pyOr, pyTruthy } from '../lib/pysemantics.js';
import {
  COMP_LEVEL_ORDER,
  COMP_LEVEL_LABELS,
  EVENT_TYPE_ORDER,
  EVENT_TYPE_LABELS,
  ET_SHORT,
  WINNER_LABELS,
  resolveDeLevelFrc,
} from '../lib/compLevels.js';

type Obj = Record<string, any>;

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/** Single-flight coalesced team stats lookup. team_service.py:85. */
export async function getTeamStats(teamNumber: number, year?: number | null): Promise<Obj> {
  const cacheKey = `team_stats:${teamNumber}:${year || 'current'}`;
  return coalesce(cacheKey, getTeamStatsImpl as never, teamNumber as never, year as never);
}

async function getTeamStatsImpl(teamNumber: number, yearArg?: number | null): Promise<Obj> {
  const client = getTbaClient();
  const teamKey = `frc${teamNumber}`;
  const includeHistory = yearArg === null || yearArg === undefined;
  const year = includeHistory ? new Date().getFullYear() : (yearArg as number);

  const [teamInfo, years, events, media, allAwards, allEventsSimple] = await Promise.all([
    client.getTeam<Obj>(teamKey),
    safe(client.getTeamYearsParticipated<number[]>(teamKey)),
    client.getTeamEvents<Obj[]>(teamKey, year),
    safe(client.getTeamMedia<Obj[]>(teamKey, year)),
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

  // Avatar (base64 PNG from TBA)
  let avatarBase64: string | null = null;
  if (pyTruthy(media)) {
    for (const item of media!) {
      if (item.type === 'avatar') {
        const b64 = (pyOr(item.details, {}) as Obj).base64Image;
        if (b64) {
          avatarBase64 = `data:image/png;base64,${b64}`;
          break;
        }
      }
    }
  }

  const statuses = (pyOr(await safe(client.getTeamEventsStatuses<Obj>(teamKey, year)), {}) ?? {}) as Obj;

  // Pre-fetch playoff matches for double-elim events (Supabase first, FRC API fallback).
  const frc = getFrcClient();
  const teamNum = Number(teamKey.replace('frc', ''));
  const deEventKeys: string[] = [];
  if (year >= 2023 && statuses && typeof statuses === 'object') {
    for (const [ek, st] of Object.entries(statuses)) {
      const po = st && typeof st === 'object' ? (st as Obj).playoff : null;
      if (po && po.level === 'sf') deEventKeys.push(ek);
    }
  }

  const deMatchMap: Record<string, Obj[]> = {};
  if (deEventKeys.length) {
    const getPlayoffMatches = async (ek: string): Promise<Obj[] | null> => {
      try {
        const sbMatches = await readFrcPlayoffMatches(ek);
        if (pyTruthy(sbMatches)) {
          // The get_frc_playoff_matches RPC currently hands back each row as a
          // JSON *string* rather than an object. Python hits that as
          // `str.get(...)` -> AttributeError -> `except: pass` -> FRC API
          // fallback, which is where the usable data actually comes from. JS
          // would instead read `undefined`, silently yield [], and never fall
          // back — so reject non-object rows explicitly to keep the same
          // effective behavior. (Underlying RPC bug worth fixing once FastAPI
          // is retired; parsing the rows here would make Node read from a
          // different source than FastAPI and break parity today.)
          const usable = (sbMatches as unknown[]).filter(
            (m): m is Obj => typeof m === 'object' && m !== null,
          );
          if (usable.length) {
            return usable.filter((m) =>
              ((m.teams ?? []) as Obj[]).some((t) => t.teamNumber === teamNum),
            );
          }
        }
      } catch {
        /* fall through to FRC API */
      }
      return safe(
        frc.getMatches(year, ek.slice(4).toUpperCase(), { level: 'Playoff', teamNumber: teamNum }),
      );
    };

    const deResults = await Promise.all(deEventKeys.map((ek) => getPlayoffMatches(ek)));
    deEventKeys.forEach((ek, i) => {
      const matches = deResults[i];
      if (pyTruthy(matches)) deMatchMap[ek] = matches as Obj[];
    });
  }

  // Walk every event this year to find the highest stage reached.
  let highestCompRank = -1;
  let highestCompEtRank = -1;
  let highestCompLabel = 'N/A — No events yet';
  let highestEventTypeRank = -1;
  let highestEventType = 99;
  const eventResults: Obj[] = [];

  for (const ev of events) {
    const ek: string = ev.key;
    const et: number = pyGet(ev, 'event_type', 99) as number;
    const etRank = EVENT_TYPE_ORDER[et] ?? 0;

    const status = (statuses && typeof statuses === 'object' ? pyGet(statuses, ek, {}) : {}) as Obj;
    const playoff = pyTruthy(status) ? status.playoff : null;
    const qual = pyTruthy(status) ? status.qual : null;

    let evCompLevel = 'qm';
    let evPlayoffStatus = '';
    if (playoff) {
      const level = pyGet(playoff, 'level', 'qm') as string;
      evCompLevel = level;
      evPlayoffStatus = pyGet(playoff, 'status', '') as string;
      if (evPlayoffStatus === 'won' && level === 'f') evCompLevel = 'winner';
    }

    const compRank = evCompLevel === 'winner' ? 5 : COMP_LEVEL_ORDER[evCompLevel] ?? 0;

    if (compRank > highestCompRank || (compRank === highestCompRank && etRank > highestCompEtRank)) {
      highestCompRank = compRank;
      highestCompEtRank = etRank;
      if (evCompLevel === 'winner') {
        const winnerCtx = WINNER_LABELS[et] ?? '';
        highestCompLabel = winnerCtx ? `Event Winner (${winnerCtx})` : 'Event Winner';
      } else {
        const deStage = deMatchMap[ek] ? resolveDeLevelFrc(deMatchMap[ek]!, teamNum) : null;
        const stage = pyOr(deStage, COMP_LEVEL_LABELS[evCompLevel] ?? 'Qualifications') as string;
        const etCtx = ET_SHORT[et] ?? '';
        highestCompLabel = etCtx ? `${stage} (${etCtx})` : stage;
      }
    }

    // Only count toward highest event level if the team actually competed —
    // excludes award-only appearances (Dean's List, Impact Finalist at Einstein).
    const actuallyCompeted = pyTruthy(qual) || pyTruthy(playoff);
    if (actuallyCompeted && etRank > highestEventTypeRank) {
      highestEventTypeRank = etRank;
      highestEventType = et;
    }

    const qualRanking = (qual ? pyOr(qual.ranking, {}) : {}) as Obj;
    const qualRecord = pyGet(qualRanking, 'record', {}) as Obj;

    // Championship events (3/4) have a real 3rd pick; others use Backup.
    const isChampEt = et === 3 || et === 4;
    const pickLabels = isChampEt
      ? ['Captain', '1st Pick', '2nd Pick', '3rd Pick']
      : ['Captain', '1st Pick', '2nd Pick', 'Backup'];
    const allianceInfo = pyTruthy(status) ? status.alliance : null;
    let alliancePick = '';
    let allianceNumber: unknown = null;
    if (allianceInfo) {
      const pickIdx = allianceInfo.pick;
      allianceNumber = allianceInfo.number;
      const backupInfo = (pyOr(allianceInfo.backup, {}) ?? {}) as Obj;
      if (backupInfo.in === teamKey) {
        alliancePick = 'Backup';
      } else if (pickIdx !== null && pickIdx !== undefined && pickIdx < pickLabels.length) {
        alliancePick = pickLabels[pickIdx]!;
      }
    }

    const evStart = pyGet(ev, 'start_date', '') as string;
    const evEnd = pyGet(ev, 'end_date', '') as string;
    let isUpcoming = false;
    if (evStart) {
      const startMs = Date.parse(`${evStart}T00:00:00`);
      const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00`);
      if (!Number.isNaN(startMs)) isUpcoming = startMs > todayMs;
    }

    // Python: `de_match_map.get(ek) and _resolve(...) or (fallback)` — an
    // and/or chain, NOT a simple ternary: it falls through to the fallback both
    // when the event has no DE matches AND when the resolver returns None.
    const deResolved = deMatchMap[ek] ? resolveDeLevelFrc(deMatchMap[ek]!, teamNum) : null;
    const playoffLevelFallback =
      evCompLevel !== 'winner' ? COMP_LEVEL_LABELS[evCompLevel] ?? evCompLevel : 'Finals';
    const playoffLevel = pyOr(deResolved, playoffLevelFallback) as string;

    eventResults.push({
      event_key: ek,
      event_name: pyGet(ev, 'name', ek),
      event_type: EVENT_TYPE_LABELS[et] ?? 'Other',
      start_date: evStart,
      end_date: evEnd,
      city: pyGet(ev, 'city', ''),
      state_prov: pyGet(ev, 'state_prov', ''),
      is_upcoming: isUpcoming,
      qual_rank: pyGet(qualRanking, 'rank', '-'),
      qual_record: `${pyGet(qualRecord, 'wins', 0)}-${pyGet(qualRecord, 'losses', 0)}-${pyGet(qualRecord, 'ties', 0)}`,
      playoff_level: playoffLevel,
      playoff_status: pyOr(evPlayoffStatus, '-'),
      alliance_pick: alliancePick,
      alliance_number: allianceNumber,
    });
  }

  // ── Awards ──────────────────────────────────────────────
  // TBA blue-banner types: 0 = Impact/Chairman's, 1 = Event Winner,
  // 3 = Woodie Flowers Finalist. (71 is Autonomous Award — excluded.)
  const BLUE_BANNER_TYPES = new Set([0, 1, 3]);
  const OFFSEASON_TYPES = new Set([99, 100, -1]);

  const blueBanners: Obj[] = [];
  const awardsByYear = new Map<number, Obj[]>();
  if (pyTruthy(allAwards)) {
    for (const aw of allAwards!) {
      const awType = aw.award_type;
      const awYear = aw.year;
      const awName = pyGet(aw, 'name', '') as string;
      const awEvent = pyGet(aw, 'event_key', '') as string;
      const entry = {
        award_type: awType,
        name: awName,
        year: awYear,
        event_key: awEvent,
        event_name: pyGet(eventNameMap, awEvent, awEvent),
      };
      if (BLUE_BANNER_TYPES.has(awType)) {
        if (!OFFSEASON_TYPES.has(pyGet(eventTypeMap, awEvent, -1) as number)) {
          blueBanners.push(entry);
        }
      }
      if (!awardsByYear.has(awYear)) awardsByYear.set(awYear, []);
      awardsByYear.get(awYear)!.push(entry);
    }
  }

  // HoF (Impact winner at CMP Finals) / Impact finalist / Einstein wins.
  const hofAwards: Obj[] = [];
  const impactFinalistAwards: Obj[] = [];
  const einsteinWins: Obj[] = [];
  if (pyTruthy(allAwards)) {
    for (const aw of allAwards!) {
      const awType = aw.award_type;
      const awEvent = pyGet(aw, 'event_key', '') as string;
      const evType = pyGet(eventTypeMap, awEvent, -1) as number;
      const mk = () => ({
        year: aw.year,
        event_key: awEvent,
        event_name: pyGet(eventNameMap, awEvent, awEvent),
      });
      if (awType === 0 && evType === 4) hofAwards.push(mk());
      if (awType === 69 && evType === 4) impactFinalistAwards.push(mk());
      if (awType === 1 && evType === 4) einsteinWins.push(mk());
    }
  }

  // Flat list, newest year first.
  const awardsList: Obj[] = [];
  for (const y of [...awardsByYear.keys()].sort((a, b) => b - a)) {
    for (const aw of awardsByYear.get(y)!) awardsList.push(aw);
  }

  const hasCompeted = highestEventTypeRank >= 0;

  // If they haven't competed yet, surface their most recent season instead.
  let lastSeason: Obj | null = null;
  if (!hasCompeted && pyTruthy(years)) {
    const priorYears = years!.filter((y2) => y2 < year).sort((a, b) => b - a);
    if (priorYears.length) {
      const lastAchievements = await getSeasonAchievements(teamKey, [priorYears[0]!]);
      if (pyTruthy(lastAchievements)) lastSeason = lastAchievements[0]!;
    }
  }

  const result: Obj = {
    team_number: teamNumber,
    team_key: teamKey,
    nickname: pyGet(teamInfo, 'nickname', ''),
    city: pyGet(teamInfo, 'city', ''),
    state_prov: pyGet(teamInfo, 'state_prov', ''),
    country: pyGet(teamInfo, 'country', ''),
    rookie_year: teamInfo.rookie_year ?? null,
    years_active: pyTruthy(years) ? years!.length : 0,
    has_competed: hasCompeted,
    highest_stage_of_play: highestCompLabel,
    highest_event_level: EVENT_TYPE_LABELS[highestEventType] ?? 'Unknown',
    events_this_year: eventResults,
    year,
    last_season: lastSeason,
    season_achievements: null,
    avatar: avatarBase64,
    blue_banners: blueBanners,
    blue_banner_count: blueBanners.length,
    awards: awardsList,
    is_hof: hofAwards.length > 0,
    hof_awards: hofAwards,
    is_impact_finalist: impactFinalistAwards.length > 0,
    impact_finalist_awards: impactFinalistAwards,
    einstein_wins: einsteinWins,
    is_einstein_winner: einsteinWins.length > 0,
  };

  if (includeHistory && pyTruthy(years)) {
    result.season_achievements = await getSeasonAchievements(
      teamKey,
      [...years!].sort((a, b) => a - b),
    );
  }

  return result;
}

/** Highest achievement for every season the team competed. team_service.py:408. */
async function getSeasonAchievements(teamKey: string, years: number[]): Promise<Obj[]> {
  const client = getTbaClient();

  const fetchYear = async (y: number): Promise<[number, Obj | null, Obj[] | null]> => {
    const statuses = await safe(client.getTeamEventsStatuses<Obj>(teamKey, y));
    const events = await safe(client.getTeamEvents<Obj[]>(teamKey, y));
    return [y, statuses, events];
  };

  const yearData = await Promise.all(years.map((y) => fetchYear(y)));

  const achievements: Obj[] = [];
  for (const [y, statuses, events] of yearData) {
    if (!pyTruthy(statuses) || typeof statuses !== 'object') {
      achievements.push({ year: y, achievement: 'Competed', event_name: '' });
      continue;
    }

    const evInfo: Record<string, Obj> = {};
    if (pyTruthy(events)) {
      for (const ev of events!) evInfo[ev.key] = ev;
    }

    let bestCompRank = -1;
    let bestEtRank = -1;
    let bestLabel = 'Competed';
    let bestEventName = '';

    for (const [ek, status] of Object.entries(statuses as Obj)) {
      if (!status || typeof status !== 'object') continue;

      const ev = (pyGet(evInfo, ek, {}) ?? {}) as Obj;
      const et = pyGet(ev, 'event_type', 99) as number;
      const etRank = EVENT_TYPE_ORDER[et] ?? 0;
      const playoff = (status as Obj).playoff;
      const qual = (status as Obj).qual;

      // Skip award-only appearances.
      if (!pyTruthy(playoff) && !pyTruthy(qual)) continue;

      let evCompLevel = 'qm';
      let evPlayoffStatus = '';
      if (playoff) {
        const level = pyGet(playoff, 'level', 'qm') as string;
        evCompLevel = level;
        evPlayoffStatus = pyGet(playoff, 'status', '') as string;
        if (evPlayoffStatus === 'won' && level === 'f') evCompLevel = 'winner';
      }

      const compRank = evCompLevel === 'winner' ? 5 : COMP_LEVEL_ORDER[evCompLevel] ?? 0;

      if (compRank > bestCompRank || (compRank === bestCompRank && etRank > bestEtRank)) {
        bestCompRank = compRank;
        bestEtRank = etRank;
        bestEventName = pyGet(ev, 'name', ek) as string;
        if (evCompLevel === 'winner') {
          const winnerCtx = WINNER_LABELS[et] ?? '';
          bestLabel = winnerCtx ? `Event Winner (${winnerCtx})` : 'Event Winner';
        } else {
          bestLabel = COMP_LEVEL_LABELS[evCompLevel] ?? 'Qualifications';
        }
      }
    }

    achievements.push({ year: y, achievement: bestLabel, event_name: bestEventName });
  }

  return achievements;
}

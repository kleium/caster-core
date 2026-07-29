/**
 * Event Advancement — port of get_event_advancement / _build_event_advancement
 * (and helpers) from backend/app/services/summary_service.py.
 *
 * Event-level point standings, advancement awards, event winners, and (for
 * district events) district-wide rankings. For 2026+ regionals/championships,
 * uses the authoritative FRC v3.2 regional-pool eventdetail instead of TBA's
 * district_points (ported faithfully, including its fallback-to-TBA behavior
 * when v3.2 data is unavailable — even for championship events, matching the
 * Python original's actual behavior on that edge case).
 */
import { getTbaClient } from './tbaClient.js';
import { getFrcClient } from './frcClient.js';
import { getCachedSummary, setCachedSummary, readRegionalPoolEvent, readRegionalPoolGlobal } from './supabase.js';
import * as payloadCache from '../lib/payloadCache.js';
import { Semaphore } from '../lib/semaphore.js';

type Obj = Record<string, any>;

const API_SEMAPHORE = new Semaphore(10);
const ADVANCEMENT_TTL = 300; // seconds (summary_service.py:22)

const ADVANCEMENT_AWARD_TYPES: Record<number, string> = {
  0: 'Impact Award',
  9: 'Engineering Inspiration',
  10: 'Rookie All-Star',
};

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await API_SEMAPHORE.run(fn);
  } catch {
    return null;
  }
}

// ── get_event_advancement (summary_service.py:350) ───────────
export async function getEventAdvancement(eventKey: string): Promise<Obj> {
  // 1) Disk cache.
  const cached = await payloadCache.readPayload('advancement', eventKey, ADVANCEMENT_TTL);
  if (cached) {
    const { _ts, ...rest } = cached;
    return rest;
  }

  // 2) Supabase cache.
  const sbKey = `adv_${eventKey}`;
  const sbRow = await getCachedSummary(sbKey);
  if (sbRow && sbRow.summary) {
    await payloadCache.writePayload('advancement', eventKey, sbRow.summary as Obj);
    return sbRow.summary as Obj;
  }

  // 3) Build from scratch.
  const result = await buildEventAdvancement(eventKey);
  if (result && Object.keys(result).length) {
    await payloadCache.writePayload('advancement', eventKey, result);
    await setCachedSummary(sbKey, result, undefined);
  }
  return result;
}

async function buildEventAdvancement(eventKey: string): Promise<Obj> {
  const client = getTbaClient();

  const [eventInfo, teams, dpRaw, awardsRaw, alliances] = await Promise.all([
    safe(() => client.getEvent<Obj>(eventKey)),
    client.getEventTeamsFull<Obj[]>(eventKey),
    safe(() => client.get<Obj>(`/event/${eventKey}/district_points`)),
    safe(() => client.get<Obj[]>(`/event/${eventKey}/awards`)),
    safe(() => client.getEventAlliances<Obj[]>(eventKey)),
  ]);

  if (!teams || teams.length === 0) return {};

  const ev = eventInfo ?? {};
  const eventTypeNum = (ev.event_type ?? -1) as number;
  const districtInfo = ev.district ?? null;
  const isDistrict = [1, 2, 5].includes(eventTypeNum);
  const year = Number(eventKey.slice(0, 4));

  const nameMap: Record<string, string> = {};
  const teamNums = new Set<number>();
  for (const t of teams) {
    nameMap[`frc${t.team_number}`] = t.nickname ?? '';
    teamNums.add(t.team_number as number);
  }

  // ── All awards by team (for display) ────────────────────
  const allAwardsByTeam: Record<number, string[]> = {};
  if (awardsRaw && Array.isArray(awardsRaw)) {
    for (const a of awardsRaw) {
      let aname = (a.name ?? `Award #${a.award_type ?? '?'}`) as string;
      for (const prefix of ['Regional ', 'District ', 'Division ']) {
        if (aname.startsWith(prefix)) {
          aname = aname.slice(prefix.length);
          break;
        }
      }
      for (const r of (a.recipient_list ?? []) as Obj[]) {
        const tk = r.team_key as string | undefined;
        if (tk) {
          const num = Number(tk.replace('frc', ''));
          (allAwardsByTeam[num] ??= []).push(aname);
        }
      }
    }
  }

  // ── For 2026+ regionals (and, per the original's actual behavior, any
  // non-district event including championships), use the FRC v3.2 fast path.
  if (!isDistrict && year >= 2026) {
    return buildRegionalAdvancement(
      eventKey, year, teams, nameMap, teamNums, allAwardsByTeam, dpRaw, alliances,
    );
  }

  // ── District / pre-2026 fallback: use TBA district_points ──
  const pointStandings = buildTbaPointStandings(dpRaw, nameMap);

  const advancementAwards: Obj[] = [];
  if (awardsRaw && Array.isArray(awardsRaw)) {
    for (const a of awardsRaw) {
      const atype = a.award_type as number;
      if (atype in ADVANCEMENT_AWARD_TYPES) {
        for (const r of (a.recipient_list ?? []) as Obj[]) {
          const tk = r.team_key as string | undefined;
          if (tk) {
            const num = Number(tk.replace('frc', ''));
            advancementAwards.push({
              team_number: num,
              nickname: nameMap[tk] ?? '',
              award: ADVANCEMENT_AWARD_TYPES[atype],
            });
          }
        }
      }
    }
  }

  const eventWinners = extractEventWinners(alliances, nameMap);

  const ptsMap: Record<number, Obj> = {};
  for (const t of pointStandings) ptsMap[t.team_number as number] = t;

  const qualifiedTeams: Obj[] = [];
  const seenQualified = new Set<number>();
  for (const w of eventWinners) {
    const num = w.team_number as number;
    if (seenQualified.has(num)) continue;
    seenQualified.add(num);
    const pts = ptsMap[num] ?? {};
    qualifiedTeams.push({
      team_number: num,
      nickname: w.nickname,
      method: w.is_backup ? 'Backup Bot' : 'Event Winner',
      total_points: pts.total ?? 0,
      qual_points: pts.qual_points ?? 0,
      alliance_points: pts.alliance_points ?? 0,
      elim_points: pts.elim_points ?? 0,
      award_points: pts.award_points ?? 0,
      awards: allAwardsByTeam[num] ?? [],
    });
  }
  for (const aa of advancementAwards) {
    if (aa.award !== 'Impact Award') continue;
    const num = aa.team_number as number;
    if (seenQualified.has(num)) continue;
    seenQualified.add(num);
    const pts = ptsMap[num] ?? {};
    qualifiedTeams.push({
      team_number: num,
      nickname: aa.nickname,
      method: 'Impact Award',
      total_points: pts.total ?? 0,
      qual_points: pts.qual_points ?? 0,
      alliance_points: pts.alliance_points ?? 0,
      elim_points: pts.elim_points ?? 0,
      award_points: pts.award_points ?? 0,
      awards: allAwardsByTeam[num] ?? [],
    });
  }

  const result: Obj = {
    event_type: isDistrict ? 'district' : 'regional',
    qualified_teams: qualifiedTeams,
    point_standings: pointStandings,
    advancement_awards: advancementAwards,
    event_winners: eventWinners,
  };

  // ── District-wide rankings (one extra API call) ──────────
  if (isDistrict && districtInfo && districtInfo.key) {
    const dk = districtInfo.key as string;
    const drRaw = await safe(() => client.get<Obj[]>(`/district/${dk}/rankings`));
    if (drRaw && Array.isArray(drRaw)) {
      const districtRankings = drRaw.map((dr) => {
        const tk = (dr.team_key ?? '') as string;
        const num = tk.startsWith('frc') ? Number(tk.replace('frc', '')) : 0;
        return {
          team_number: num,
          rank: dr.rank ?? 0,
          point_total: dr.point_total ?? 0,
          rookie_bonus: dr.rookie_bonus ?? 0,
          event_count: (dr.event_points ?? []).length,
          at_this_event: teamNums.has(num),
        };
      });
      result.district_rankings = districtRankings;
      result.district_name = districtInfo.display_name || (districtInfo.abbreviation ?? '').toUpperCase();
    }
  }

  // ── Regional cumulative points (2026+ with universal points) ─
  // Dead in practice for current-year events — 2026+ regionals return early
  // above via buildRegionalAdvancement — kept for pre-2026 regional parity.
  if (!isDistrict && pointStandings.length) {
    const yr = Number(eventKey.slice(0, 4));
    if (yr >= 2026) {
      result.regional_season = await buildRegionalSeasonPoints(client, teams, eventKey, yr);
      result.regional_pool = await fetchRegionalPoolForEvent(teamNums, yr);
    }
  }

  return result;
}

// ── _build_tba_point_standings (summary_service.py:537) ───────
function buildTbaPointStandings(dpRaw: Obj | null, nameMap: Record<string, string>): Obj[] {
  const pointStandings: Obj[] = [];
  if (dpRaw && typeof dpRaw === 'object') {
    const pts = dpRaw.points ?? dpRaw;
    if (pts && typeof pts === 'object') {
      for (const [tk, pt] of Object.entries(pts as Obj)) {
        if (!pt || typeof pt !== 'object') continue;
        const num = Number(tk.replace('frc', ''));
        pointStandings.push({
          team_number: num,
          nickname: nameMap[tk] ?? '',
          qual_points: (pt as Obj).qual_points ?? 0,
          alliance_points: (pt as Obj).alliance_points ?? 0,
          elim_points: (pt as Obj).elim_points ?? 0,
          award_points: (pt as Obj).award_points ?? 0,
          total: (pt as Obj).total ?? 0,
        });
      }
    }
  }
  pointStandings.sort((a, b) => b.total - a.total);
  return pointStandings;
}

// ── _extract_event_winners (summary_service.py:560) ───────────
function extractEventWinners(alliances: Obj[] | null, nameMap: Record<string, string>): Obj[] {
  const eventWinners: Obj[] = [];
  if (alliances) {
    for (const al of alliances) {
      const status = al.status ?? {};
      if (status && typeof status === 'object' && status.status === 'won') {
        const backup = al.backup ?? {};
        const backupIn = backup.in as string | undefined;
        for (const tk of (al.picks ?? []) as string[]) {
          const num = Number(tk.replace('frc', ''));
          eventWinners.push({ team_number: num, nickname: nameMap[tk] ?? '', is_backup: false });
        }
        if (backupIn) {
          const num = Number(backupIn.replace('frc', ''));
          eventWinners.push({ team_number: num, nickname: nameMap[backupIn] ?? '', is_backup: true });
        }
        break;
      }
    }
  }
  return eventWinners;
}

// ── _build_regional_advancement (summary_service.py:587) ──────
async function buildRegionalAdvancement(
  eventKey: string,
  year: number,
  teams: Obj[],
  nameMap: Record<string, string>,
  teamNums: Set<number>,
  allAwardsByTeam: Record<number, string[]>,
  dpRaw: Obj | null,
  alliances: Obj[] | null,
): Promise<Obj> {
  const eventCode = eventKey.slice(4).toUpperCase();

  // ── Try Supabase first ──────────────────────────────────
  let eventDetail: Obj | null = null;
  try {
    eventDetail = await readRegionalPoolEvent(year, eventKey);
  } catch {
    eventDetail = null;
  }

  // ── FRC API fallback ────────────────────────────────────
  if (!eventDetail) {
    const frc = getFrcClient();
    try {
      eventDetail = await frc.getRegionalPoolEvent(year, eventCode);
    } catch {
      eventDetail = null;
    }
  }

  const teamDetails = (eventDetail?.teamDetails ?? []) as Obj[];

  if (teamDetails.length === 0) {
    // Fallback to TBA data if v3.2 is unavailable.
    const pointStandings = buildTbaPointStandings(dpRaw, nameMap);
    const eventWinners = extractEventWinners(alliances, nameMap);
    return {
      event_type: 'regional',
      qualified_teams: [],
      point_standings: pointStandings,
      event_winners: eventWinners,
    };
  }

  // ── Build point standings from FRC v3.2 (authoritative) ──
  const pointStandings: Obj[] = [];
  const qualifiedTeams: Obj[] = [];
  for (const td of teamDetails) {
    const num = (td.teamNumber ?? 0) as number;
    const rd = td.regionalDetails ?? {};
    const nickname = nameMap[`frc${num}`] ?? td.teamName ?? '';

    pointStandings.push({
      team_number: num,
      nickname,
      qual_points: rd.qualificationPerformancePoints ?? 0,
      alliance_points: rd.allianceSelectionPoints ?? 0,
      elim_points: rd.playoffAdvancementPoints ?? 0,
      award_points: rd.awardPoints ?? 0,
      total: td.regionalPoints ?? 0,
    });

    const qualified = Boolean(td.qualifiedFirstCmp ?? false);
    const qualEvent = ((td.qualifiedFirstCmpEventCode ?? '') as string).toUpperCase();
    if (qualified && qualEvent === eventCode) {
      const awardName = td.qualifiedFirstCmpAwardName;
      const status = (td.championshipStatus ?? '') as string;
      const week = td.qualifiedFirstCmpEventWeek;
      let method: string;
      if (awardName) method = awardName;
      else if (status.includes('Ranking')) method = 'Directly Qualified';
      else if (week != null) method = `Pool W${week}`;
      else method = 'Qualified';

      qualifiedTeams.push({
        team_number: num,
        nickname,
        method,
        total_points: td.regionalPoints ?? 0,
        qual_points: rd.qualificationPerformancePoints ?? 0,
        alliance_points: rd.allianceSelectionPoints ?? 0,
        elim_points: rd.playoffAdvancementPoints ?? 0,
        award_points: rd.awardPoints ?? 0,
        awards: allAwardsByTeam[num] ?? [],
      });
    }
  }

  pointStandings.sort((a, b) => b.total - a.total);
  qualifiedTeams.sort((a, b) => b.total_points - a.total_points);

  const eventWinners = extractEventWinners(alliances, nameMap);

  return {
    event_type: 'regional',
    qualified_teams: qualifiedTeams,
    point_standings: pointStandings,
    event_winners: eventWinners,
  };
}

// ── _fetch_regional_pool_for_event (summary_service.py:694) ──
async function fetchRegionalPoolForEvent(teamNums: Set<number>, year: number): Promise<Obj[]> {
  let allTeams: Obj[] | null = null;
  try {
    allTeams = await readRegionalPoolGlobal(year);
  } catch {
    allTeams = null;
  }

  if (!allTeams) {
    const frc = getFrcClient();
    try {
      allTeams = await frc.getRegionalPool(year);
    } catch {
      return [];
    }
  }

  if (!allTeams || allTeams.length === 0) return [];

  const result: Obj[] = [];
  for (const t of allTeams) {
    if (teamNums.has(t.teamNumber)) {
      result.push({
        team_number: t.teamNumber,
        rank: t.rank ?? null,
        total_points: t.totalPoints ?? null,
        qualified: t.qualifiedFirstCmp ?? false,
        declined: t.declinedFirstCmp ?? false,
        status: t.championshipStatus ?? '',
        qual_method: t.qualifiedFirstCmpAwardName ?? '',
      });
    }
  }
  result.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
  return result;
}

// ── _build_regional_season_points (summary_service.py:737) ────
const SKIP_TYPES = new Set([3, 4, 99, 100, -1]);

async function buildRegionalSeasonPoints(
  client: ReturnType<typeof getTbaClient>,
  teams: Obj[],
  _currentEventKey: string,
  year: number,
): Promise<Obj[]> {
  const teamKeys = teams.map((t) => `frc${t.team_number}`);
  const nameMap: Record<string, string> = {};
  for (const t of teams) nameMap[`frc${t.team_number}`] = t.nickname ?? '';

  // Round 1: each team's events for this year.
  const eventResults = await Promise.all(
    teamKeys.map((tk) => safe(() => client.getTeamEvents<Obj[]>(tk, year))),
  );

  const uniqueEventKeys = new Set<string>();
  const teamEventMap: Record<string, string[]> = {};
  teamKeys.forEach((tk, i) => {
    const events = eventResults[i];
    if (!events) return;
    const ekList: string[] = [];
    for (const ev of events) {
      const ek = (ev.key ?? '') as string;
      const etype = (ev.event_type ?? -1) as number;
      if (SKIP_TYPES.has(etype)) continue;
      ekList.push(ek);
      uniqueEventKeys.add(ek);
    }
    teamEventMap[tk] = ekList;
  });

  if (uniqueEventKeys.size === 0) return [];

  // Round 2: district_points for each unique event.
  const ekListUnique = [...uniqueEventKeys];
  const dpResults = await Promise.all(
    ekListUnique.map((ek) => safe(() => client.get<Obj>(`/event/${ek}/district_points`))),
  );
  const dpCache: Record<string, Obj> = {};
  ekListUnique.forEach((ek, i) => {
    const dpRaw = dpResults[i];
    if (dpRaw && typeof dpRaw === 'object') dpCache[ek] = dpRaw.points ?? dpRaw;
  });

  // Aggregate per team.
  const seasonTotals: Record<string, Obj> = {};
  for (const tk of teamKeys) {
    let total = 0;
    let eventsPlayed = 0;
    for (const ek of teamEventMap[tk] ?? []) {
      const pts = dpCache[ek] ?? {};
      const teamPts = pts[tk];
      if (teamPts && typeof teamPts === 'object') {
        total += teamPts.total ?? 0;
        eventsPlayed += 1;
      }
    }
    if (eventsPlayed > 0) {
      const num = Number(tk.replace('frc', ''));
      seasonTotals[tk] = {
        team_number: num,
        nickname: nameMap[tk] ?? '',
        season_total: total,
        events_played: eventsPlayed,
      };
    }
  }

  const result = Object.values(seasonTotals).sort((a, b) => b.season_total - a.season_total);
  result.forEach((entry, i) => {
    entry.rank = i + 1;
  });
  return result;
}

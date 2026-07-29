/**
 * AI storyline dossier assembly — port of the dossier-building half of
 * backend/app/services/storyline_service.py (everything except LLM calls and
 * caching, which live in storylineService.ts).
 */
import { getTbaClient } from './tbaClient.js';
import { getStatboticsClient } from './statboticsClient.js';
import { getMatchConnections } from './connectionsService.js';
import { pyGet, pyOr, pyTruthy } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

async function safe<T>(promise: Promise<T>, dflt: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return dflt;
  }
}

// ── Team dossier cache (5 min — short-lived, avoids rebuild on rapid requests) ──
const DOSSIER_TTL_MS = 300_000;
const dossierCache = new Map<string, { ts: number; dossier: Obj }>();

/** Assemble a rich context dossier for a single team (with short-lived cache). storyline_service.py:126. */
export async function buildTeamDossier(teamKey: string, eventKey: string, year: number): Promise<Obj> {
  const dossierKey = `${teamKey}:${eventKey}`;
  const now = Date.now();
  const cached = dossierCache.get(dossierKey);
  if (cached && now - cached.ts < DOSSIER_TTL_MS) return cached.dossier;

  const dossier = await buildTeamDossierUncached(teamKey, eventKey, year);
  dossierCache.set(dossierKey, { ts: now, dossier });
  return dossier;
}

const BLUE_BANNER_TYPES = new Set([0, 1, 3]);
const OFFSEASON_TYPES = new Set([99, 100, -1]);
const EI_TYPE = 9;
const IMPACT_TYPE = 0;
const ROBOT_AWARD_TYPES = new Set([16, 17, 20, 21, 29]);

async function buildTeamDossierUncached(teamKey: string, eventKey: string, year: number): Promise<Obj> {
  const tba = getTbaClient();
  const teamNum = Number(teamKey.replace('frc', ''));

  const [teamInfo, allAwards, seasonAwards, seasonStatuses, allEventsSimple, eventInfo, eventTeamsList] =
    await Promise.all([
      tba.getTeam<Obj>(teamKey),
      safe(tba.getTeamAwards<Obj[]>(teamKey), []),
      safe(tba.getTeamAwardsYear<Obj[]>(teamKey, year), []),
      safe(tba.getTeamEventsStatuses<Obj>(teamKey, year), {}),
      safe(tba.getTeamEventsSimple<Obj[]>(teamKey), []),
      safe(tba.getEvent<Obj>(eventKey), {}),
      safe(tba.getEventTeams<Obj[]>(eventKey), []),
    ]);

  const sb = getStatboticsClient();
  const epaData = await safe(sb.get<Obj>(`/team_year/${teamNum}/${year}`), null);

  const eventTypeMap: Record<string, number> = {};
  const eventNameMap: Record<string, string> = {};
  for (const ev of allEventsSimple ?? []) {
    eventTypeMap[ev.key] = pyGet(ev, 'event_type', -1) as number;
    eventNameMap[ev.key] = pyGet(ev, 'name', ev.key) as string;
  }

  let blueBannerCount = 0;
  const blueBannerYears: number[] = [];
  const eventWinnerYears: number[] = [];
  const hofYears: number[] = [];
  const impactFinalistYears: number[] = [];
  const einsteinWinYears: number[] = [];
  const chairmansYears: number[] = [];
  const eiYears: number[] = [];
  const rasYears: number[] = [];

  for (const aw of allAwards ?? []) {
    const awType = aw.award_type;
    const awEvent = aw.event_key ?? '';
    const evType = eventTypeMap[awEvent] ?? -1;
    const awYear = aw.year;

    if (BLUE_BANNER_TYPES.has(awType) && !OFFSEASON_TYPES.has(evType)) {
      blueBannerCount += 1;
      if (awYear) blueBannerYears.push(awYear);
    }
    if (awType === 1 && !OFFSEASON_TYPES.has(evType) && evType !== 4) {
      if (awYear) eventWinnerYears.push(awYear);
    }
    if (awType === 0 && evType === 4) hofYears.push(awYear);
    if (awType === 69 && evType === 4) impactFinalistYears.push(awYear);
    if (awType === 1 && evType === 4) einsteinWinYears.push(awYear);
    if (awType === 0) chairmansYears.push(awYear);
    if (awType === 9 && !OFFSEASON_TYPES.has(evType)) {
      if (awYear) eiYears.push(awYear);
    }
    if ((awType === 10 || awType === 83) && !OFFSEASON_TYPES.has(evType)) {
      if (awYear) rasYears.push(awYear);
    }
  }

  const seasonAwardNames: string[] = [];
  const seasonAwardTiers: string[] = [];
  for (const aw of seasonAwards ?? []) {
    const awEvent = aw.event_key ?? '';
    if (awEvent !== eventKey) {
      const awName = aw.name ?? '';
      const awType = aw.award_type;
      const evName = eventNameMap[awEvent] ?? awEvent;
      seasonAwardNames.push(`${awName} at ${evName}`);
      if (awType === IMPACT_TYPE) seasonAwardTiers.push('impact');
      else if (awType === EI_TYPE) seasonAwardTiers.push('ei');
      else if (ROBOT_AWARD_TYPES.has(awType)) seasonAwardTiers.push('robot');
      else seasonAwardTiers.push('other');
    }
  }
  void seasonAwardTiers; // computed for parity with Python but unused downstream, same as source

  const thisEventAwards: string[] = [];
  for (const aw of seasonAwards ?? []) {
    if (aw.event_key === eventKey) thisEventAwards.push(aw.name ?? '');
  }

  const seasonResults: Obj[] = [];
  if (seasonStatuses && typeof seasonStatuses === 'object') {
    for (const [ek, st] of Object.entries(seasonStatuses as Obj)) {
      if (ek === eventKey || !st || typeof st !== 'object') continue;
      const evName = eventNameMap[ek] ?? ek;
      const qual = (st as Obj).qual;
      const playoff = (st as Obj).playoff;
      const qualRank = qual ? pyGet(qual.ranking ?? {}, 'rank', '?') : '?';
      const qualRecord = qual ? (qual.ranking?.record ?? {}) : {};
      // pyTruthy, not a bare check: Python's `... if qual_record else "?"` treats an
      // empty dict as falsy, so a team with no ranking record reads "?" — a plain JS
      // truthy test would say "0-0-0" and tell the LLM they went winless.
      const wlt = pyTruthy(qualRecord)
        ? `${qualRecord.wins ?? 0}-${qualRecord.losses ?? 0}-${qualRecord.ties ?? 0}`
        : '?';
      let poStatus = '';
      if (playoff) {
        const level = playoff.level ?? '';
        const status = playoff.status ?? '';
        if (status === 'won' && level === 'f') poStatus = 'Event Winner';
        else if (level === 'f') poStatus = 'Finalist';
        else if (level === 'sf') poStatus = 'Semifinalist';
        else poStatus = `Eliminated in ${level}`;
      }
      seasonResults.push({ event: evName, rank: qualRank, record: wlt, playoff: poStatus });
    }
  }

  const thisStatus = seasonStatuses && typeof seasonStatuses === 'object' ? (seasonStatuses as Obj)[eventKey] ?? {} : {};
  const thisQual = thisStatus?.qual;
  let thisRank: string | number = thisQual ? (pyGet(thisQual.ranking ?? {}, 'rank', '?') as string | number) : '?';
  const thisRecord = thisQual ? (thisQual.ranking?.record ?? {}) : {};
  let thisWlt = pyTruthy(thisRecord)
    ? `${thisRecord.wins ?? 0}-${thisRecord.losses ?? 0}-${thisRecord.ties ?? 0}`
    : '?';

  // Cross-check record with actual match scores (TBA ranking records can be
  // stale/wrong — verify against played match data). storyline_service.py:303.
  try {
    const matches = await safe(tba.getTeamEventMatches<Obj[]>(teamKey, eventKey), []);
    if (matches?.length) {
      let w = 0;
      let l = 0;
      let t = 0;
      for (const mt of matches) {
        if (mt.comp_level !== 'qm') continue;
        const red = mt.alliances?.red ?? {};
        const blue = mt.alliances?.blue ?? {};
        const inRed = (red.team_keys ?? []).includes(teamKey);
        const myScore = inRed ? red.score ?? -1 : blue.score ?? -1;
        const oppScore = inRed ? blue.score ?? -1 : red.score ?? -1;
        if (myScore < 0 || oppScore < 0) continue;
        if (myScore > oppScore) w += 1;
        else if (myScore < oppScore) l += 1;
        else t += 1;
      }
      if (w + l + t > 0) thisWlt = `${w}-${l}-${t}`;
    }
  } catch {
    /* keep ranking-based record as fallback */
  }

  // Alliance info at this event
  const allianceInfo = thisStatus?.alliance;
  let allianceStr = '';
  if (allianceInfo) {
    const thisEventType = pyGet(eventInfo ?? {}, 'event_type', -1) as number;
    const pickLabels =
      thisEventType === 3 || thisEventType === 4
        ? ['Captain', '1st Pick', '2nd Pick', '3rd Pick']
        : ['Captain', '1st Pick', '2nd Pick', 'Backup'];
    const pickIdx = allianceInfo.pick ?? 0;
    const aNum = allianceInfo.number;
    const role = pickIdx < pickLabels.length ? pickLabels[pickIdx] : 'Member';
    allianceStr = aNum ? `Alliance ${aNum} ${role}` : (role as string);
  }

  // EPA
  let epaVal: number | null = null;
  if (epaData && typeof epaData === 'object') {
    const epaObj = pyGet(epaData, 'epa', epaData.epa_end);
    if (epaObj && typeof epaObj === 'object') {
      epaVal = (epaObj as Obj).total_points?.mean ?? null;
    } else if (typeof epaObj === 'number') {
      epaVal = epaObj;
    }
  }

  const rookieYear: number | null = teamInfo ? teamInfo.rookie_year ?? null : null;
  const teamAge = rookieYear ? year - rookieYear : null;

  // Travel history
  const eventCountry = pyOr(eventInfo ? pyGet(eventInfo, 'country', '') : '', '') as string;
  const eventCity = pyOr(eventInfo ? pyGet(eventInfo, 'city', '') : '', '') as string;
  const teamCountry = (teamInfo ? pyGet(teamInfo, 'country', '') : '') as string;
  const isInternational = Boolean(teamCountry && eventCountry && teamCountry !== eventCountry);

  let visitsToEventCountry = 0;
  const visitYearsInCountry: number[] = [];
  if (allEventsSimple?.length && eventCountry) {
    for (const ev of allEventsSimple) {
      const evType = pyGet(ev, 'event_type', -1) as number;
      if (OFFSEASON_TYPES.has(evType)) continue;
      if (ev.country === eventCountry) {
        visitsToEventCountry += 1;
        if (ev.year) visitYearsInCountry.push(ev.year);
      }
    }
  }
  const firstYearInCountry = visitYearsInCountry.length ? Math.min(...visitYearsInCountry) : null;
  const firstTimeInCountry = firstYearInCountry ? firstYearInCountry === year : false;
  const seasonsInCountry = new Set(visitYearsInCountry).size;

  let homeEventsEver = 0;
  if (allEventsSimple?.length && teamCountry) {
    for (const ev of allEventsSimple) {
      const evType = pyGet(ev, 'event_type', -1) as number;
      if (ev.country === teamCountry && !OFFSEASON_TYPES.has(evType)) homeEventsEver += 1;
    }
  }
  const homeCountryHasEvents = homeEventsEver > 0;

  let countrymatesAtEvent = 0;
  if (eventTeamsList?.length && teamCountry) {
    for (const t of eventTeamsList) {
      if (t.country === teamCountry) countrymatesAtEvent += 1;
    }
  }
  if (countrymatesAtEvent > 0) countrymatesAtEvent -= 1;

  // Award progression milestones
  const firstEiYear = eiYears.length ? Math.min(...eiYears) : null;
  const firstImpactYear = chairmansYears.length ? Math.min(...chairmansYears) : null;
  const firstRasYear = rasYears.length ? Math.min(...rasYears) : null;

  const eiToImpactSeasons = firstEiYear && firstImpactYear ? firstImpactYear - firstEiYear : null;
  const rookieToImpactSeasons = rookieYear && firstImpactYear ? firstImpactYear - rookieYear : null;
  const rasToImpactSeasons = firstRasYear && firstImpactYear ? firstImpactYear - firstRasYear : null;
  const seasonsSinceEiNoImpact = firstEiYear && !firstImpactYear ? year - firstEiYear : null;

  return {
    team_number: teamNum,
    nickname: teamInfo ? pyGet(teamInfo, 'nickname', '') : '',
    city: teamInfo ? pyGet(teamInfo, 'city', '') : '',
    state_prov: teamInfo ? pyGet(teamInfo, 'state_prov', '') : '',
    country: teamInfo ? pyGet(teamInfo, 'country', '') : '',
    rookie_year: rookieYear,
    team_age: teamAge,
    blue_banners: blueBannerCount,
    blue_banner_years: [...new Set(blueBannerYears)].sort((a, b) => a - b),
    is_hof: hofYears.length > 0,
    hof_years: [...new Set(hofYears)].sort((a, b) => a - b),
    impact_finalist_years: [...new Set(impactFinalistYears)].sort((a, b) => a - b),
    einstein_win_years: [...new Set(einsteinWinYears)].sort((a, b) => a - b),
    chairmans_impact_wins: new Set(chairmansYears).size,
    event_winner_years: [...new Set(eventWinnerYears)].sort((a, b) => a - b),
    event_winner_count: new Set(eventWinnerYears).size,
    ei_wins: [...new Set(eiYears)].sort((a, b) => a - b),
    ras_wins: [...new Set(rasYears)].sort((a, b) => a - b),
    first_ei_year: firstEiYear,
    first_impact_year: firstImpactYear,
    first_ras_year: firstRasYear,
    ei_to_impact_seasons: eiToImpactSeasons,
    rookie_to_impact_seasons: rookieToImpactSeasons,
    ras_to_impact_seasons: rasToImpactSeasons,
    seasons_since_ei_no_impact: seasonsSinceEiNoImpact,
    epa: epaVal,
    this_event_rank: thisRank,
    this_event_record: thisWlt,
    this_event_awards: thisEventAwards,
    alliance_role: allianceStr,
    season_results: seasonResults,
    season_awards_other_events: seasonAwardNames,
    current_year: year,
    event_country: eventCountry,
    event_city: eventCity,
    is_international: isInternational,
    visits_to_event_country: visitsToEventCountry,
    seasons_in_country: seasonsInCountry,
    first_time_in_country: firstTimeInCountry,
    first_year_in_country: firstYearInCountry,
    home_country_has_events: homeCountryHasEvents,
    countrymates_at_event: countrymatesAtEvent,
  };
}

/** Format a team dossier dict into human-readable text for the LLM. storyline_service.py:450. */
export function formatTeamDossier(d: Obj): string {
  const lines: string[] = [`Team ${d.team_number} — ${d.nickname}`];

  const curYear: number = d.current_year ?? new Date().getFullYear();
  lines.push(`  Current season: ${curYear}`);
  const locationParts = [d.city, d.state_prov, d.country].filter(Boolean);
  if (locationParts.length) lines.push(`  From: ${locationParts.join(', ')}`);
  if (d.rookie_year) lines.push(`  Rookie year: ${d.rookie_year} (${d.team_age ?? '?'} seasons)`);

  const bannerCount: number = d.blue_banners ?? 0;
  const bannerYears: number[] = d.blue_banner_years ?? [];
  if (bannerCount) {
    const lastBanner = bannerYears.length ? Math.max(...bannerYears) : null;
    const drought = lastBanner ? curYear - lastBanner : null;
    let bannerLine = `  Blue Banners: ${bannerCount}`;
    if (bannerYears.length) bannerLine += ` (years: ${bannerYears.join(', ')})`;
    if (drought !== null && drought >= 3) bannerLine += ` — last banner ${drought} seasons ago`;
    lines.push(bannerLine);
  } else {
    lines.push('  Blue Banners: 0 — has never won a blue banner');
  }

  if (d.is_hof) lines.push(`  Hall of Fame inductee (years: ${d.hof_years.join(', ')})`);
  if (d.impact_finalist_years?.length) {
    lines.push(`  Impact Award finalist at Championships: ${d.impact_finalist_years.join(', ')}`);
  }
  if (d.einstein_win_years?.length) {
    lines.push(`  Einstein/Championship winner: ${d.einstein_win_years.join(', ')}`);
  }
  if (d.chairmans_impact_wins > 0) {
    lines.push(`  Chairman's/Impact Award wins (all levels): ${d.chairmans_impact_wins}`);
  }
  if (d.event_winner_count > 0) {
    lines.push(
      `  Event Winner (competition): ${d.event_winner_count} (years: ${(d.event_winner_years ?? []).join(', ')})`,
    );
  }
  if (d.ei_wins?.length) {
    lines.push(`  Engineering Inspiration Award wins: ${d.ei_wins.length} (years: ${d.ei_wins.join(', ')})`);
  }
  if (d.ras_wins?.length) {
    lines.push(`  Rookie All-Star / Rising All-Star: ${d.ras_wins.join(', ')}`);
  }

  if (d.this_event_rank && d.this_event_rank !== '?') {
    lines.push(`  Rank at this event: ${d.this_event_rank} (record: ${d.this_event_record ?? '?'})`);
  }
  if (d.this_event_awards?.length) {
    lines.push(`  Awards at this event: ${d.this_event_awards.join(', ')}`);
  }
  if (d.alliance_role) lines.push(`  Playoff role: ${d.alliance_role}`);
  if (d.epa !== null && d.epa !== undefined) lines.push(`  Season EPA: ${Number(d.epa).toFixed(1)}`);

  if (d.season_results?.length) {
    lines.push('  Season results (other events):');
    for (const sr of d.season_results) {
      const po = sr.playoff ? ` → ${sr.playoff}` : '';
      lines.push(`    - ${sr.event}: Rank ${sr.rank} (${sr.record})${po}`);
    }
  }

  if (d.season_awards_other_events?.length) {
    lines.push('  Awards won this season (other events):');
    for (const a of d.season_awards_other_events) lines.push(`    - ${a}`);
  }

  const eventCountry = d.event_country ?? '';
  const teamCountry = d.country ?? '';
  const isIntl = d.is_international ?? false;
  const visits = d.visits_to_event_country ?? 0;
  const seasonsVisited = d.seasons_in_country ?? 0;
  const firstTime = d.first_time_in_country ?? false;
  const homeHasEvents = d.home_country_has_events ?? true;
  if (isIntl) {
    if (firstTime) {
      lines.push(`  Travel: First time competing in ${eventCountry} (home country: ${teamCountry})`);
    } else if (seasonsVisited > 1) {
      const firstYr = d.first_year_in_country;
      lines.push(
        `  Travel: Has competed in ${eventCountry} in ${seasonsVisited} seasons (${visits} events) since ${firstYr} (home country: ${teamCountry})`,
      );
    }
  }
  if (teamCountry && !homeHasEvents) {
    lines.push(`  Home country (${teamCountry}): No FRC events — must always travel abroad to compete`);
  }

  // ── Computed narrative hints ─────────────────────────
  const hints: string[] = [];

  const eventWins: number = d.event_winner_count ?? 0;
  const einsteinWins: number = (d.einstein_win_years ?? []).length;
  const impactCount: number = d.chairmans_impact_wins ?? 0;
  const ei: number[] = d.ei_wins ?? [];
  const ras: number[] = d.ras_wins ?? [];
  const isHof: boolean = d.is_hof ?? false;
  const firstEi = d.first_ei_year;
  const firstImpact = d.first_impact_year;
  const firstRas = d.first_ras_year;
  const eiToImpact = d.ei_to_impact_seasons;
  const rookieToImpact = d.rookie_to_impact_seasons;
  const rasToImpact = d.ras_to_impact_seasons;
  const seasonsChasing = d.seasons_since_ei_no_impact;
  const teamAge: number = d.team_age ?? 99;

  const hasCompetition = eventWins > 0 || einsteinWins > 0;
  const hasCulture = impactCount > 0 || ei.length > 0;

  if (hasCompetition && hasCulture) {
    const parts: string[] = [];
    if (einsteinWins) parts.push(`${einsteinWins}x Einstein champion`);
    if (eventWins) parts.push(`${eventWins}x event winner`);
    if (isHof) parts.push('Hall of Fame');
    else if (impactCount) parts.push(`${impactCount}x Impact`);
    else if (ei.length) parts.push(`${ei.length}x EI`);
    hints.push(`Dual identity: ${parts.join(' + ')} — excels on the field AND in culture`);
  } else if (hasCompetition && !hasCulture) {
    const parts: string[] = [];
    if (einsteinWins) parts.push(`${einsteinWins}x Einstein champion`);
    if (eventWins) parts.push(`${eventWins}x event winner`);
    hints.push(`Competition-focused: ${parts.join(' + ')}, no major culture awards`);
  } else if (hasCulture && !hasCompetition) {
    const parts: string[] = [];
    if (isHof) parts.push('Hall of Fame');
    else if (impactCount) parts.push(`${impactCount}x Impact`);
    if (ei.length) parts.push(`${ei.length}x EI`);
    if (bannerCount === 0) {
      hints.push(`Culture-focused: ${parts.join(' + ')}, 0 event wins in ${teamAge} seasons`);
    } else {
      hints.push(`Culture-focused: ${parts.join(' + ')}`);
    }
  }

  // Season trajectory
  const allResults: Obj[] = [...(d.season_results ?? [])];
  const thisRank = d.this_event_rank;
  const allResultsWithCurrent =
    thisRank && thisRank !== '?' ? [...allResults, { rank: thisRank, event: 'this event' }] : allResults;
  if (allResultsWithCurrent.length >= 2) {
    const ranks = allResultsWithCurrent
      .filter((r) => /^\d+$/.test(String(r.rank ?? '?')))
      .map((r) => Number(r.rank));
    if (ranks.length >= 2) {
      if (ranks[ranks.length - 1]! < ranks[0]!) {
        hints.push(`Rank trend: ${ranks[0]}→${ranks[ranks.length - 1]} (improving)`);
      } else if (ranks[ranks.length - 1]! > ranks[0]!) {
        hints.push(`Rank trend: ${ranks[0]}→${ranks[ranks.length - 1]} (declining)`);
      }
    }
  }

  // Playoff progression
  const playoffLevels: Record<string, number> = {
    'Eliminated in qf': 1,
    'Eliminated in sf': 2,
    Semifinalist: 2,
    Finalist: 3,
    'Event Winner': 4,
  };
  const poResults = allResults
    .filter((sr) => sr.playoff)
    .map((sr) => [sr, playoffLevels[sr.playoff] ?? 0] as const);
  if (poResults.length >= 2) {
    const levels = poResults.map(([, lv]) => lv);
    if (levels[levels.length - 1]! > levels[0]!) {
      const firstPo = poResults[0]![0].playoff;
      const lastPo = poResults[poResults.length - 1]![0].playoff;
      hints.push(`Playoff arc: ${firstPo}→${lastPo}`);
    }
  }

  // Banner drought
  const hasAwards = Boolean(
    (d.season_awards_other_events ?? []).length || (d.this_event_awards ?? []).length || ei.length || impactCount,
  );
  if (bannerCount === 0 && hasAwards && teamAge >= 3) {
    hints.push(`0 blue banners in ${teamAge} seasons despite winning awards`);
  } else if (bannerCount > 0 && bannerYears.length) {
    const drought = curYear - Math.max(...bannerYears);
    if (drought >= 4) hints.push(`Last blue banner: ${Math.max(...bannerYears)} (${drought} seasons ago)`);
  }

  // Award progression milestones — skip EI→Impact noise for elite teams
  const isElite = isHof || einsteinWins > 0;
  if (ras.length && firstRas) hints.push(`Rookie All-Star / Rising All-Star: ${firstRas}`);
  if (eiToImpact !== null && eiToImpact !== undefined && !isElite) {
    hints.push(`EI→Impact: ${eiToImpact} seasons (EI ${firstEi}, Impact ${firstImpact})`);
  } else if (ei.length && impactCount === 0 && seasonsChasing) {
    hints.push(`EI winner (${ei.join(', ')}), no Impact yet — ${seasonsChasing} seasons`);
  }
  if (rookieToImpact !== null && rookieToImpact !== undefined && !isElite) {
    hints.push(`Rookie→Impact: ${rookieToImpact} seasons (rookie ${d.rookie_year}, Impact ${firstImpact})`);
  }
  if (rasToImpact !== null && rasToImpact !== undefined && !isElite) {
    hints.push(`RAS→Impact: ${rasToImpact} seasons`);
  }

  // Rookie/young team
  if (teamAge && teamAge <= 2 && bannerCount > 0) {
    hints.push(`${bannerCount} blue banner(s) in ${teamAge} season(s)`);
  }
  if (teamAge && teamAge <= 2 && thisRank && /^\d+$/.test(String(thisRank)) && Number(thisRank) <= 8) {
    hints.push(`Rookie/2nd-year, ranked #${thisRank} at this event`);
  }

  if (isIntl && firstTime) {
    hints.push(`First time in ${eventCountry} (from ${teamCountry})`);
  }

  if (hints.length) {
    lines.push('  NARRATIVE HINTS (data points — synthesize into natural story, do not read verbatim):');
    for (const h of hints) lines.push(`    • ${h}`);
  }

  return lines.join('\n');
}

/** Format all-time H2H connection data into a compact text section for the LLM. storyline_service.py:661. */
export function formatH2hConnections(connections: Obj[]): string {
  if (!connections?.length) return '';

  const lines: string[] = ['PRIOR HEAD-TO-HEAD HISTORY (all-time playoff record):'];
  for (const c of connections) {
    const ta = c.team_a;
    const tb = c.team_b;
    const taLabel = `${ta} ${c.team_a_name ?? ''}`.trim();
    const tbLabel = `${tb} ${c.team_b_name ?? ''}`.trim();

    const opp: Obj[] = c.opponents_at ?? [];
    const ally: Obj[] = c.partnered_at ?? [];
    const h2hA: number = c.h2h_wins_a ?? 0;
    const h2hB: number = c.h2h_wins_b ?? 0;
    const total = h2hA + h2hB;

    const rowParts: string[] = [];
    if (opp.length) {
      let lead: string;
      if (h2hA > h2hB) lead = `${taLabel} leads ${h2hA}-${h2hB}`;
      else if (h2hB > h2hA) lead = `${tbLabel} leads ${h2hB}-${h2hA}`;
      else lead = `tied ${h2hA}-${h2hB}`;
      const recent = opp[0]!;
      rowParts.push(
        `As opponents: ${total} playoff match(es), ${lead} — last met ${recent.year} ${recent.event_name ?? ''} (${recent.stage ?? ''})`,
      );
    }
    if (ally.length) {
      const recentAlly = ally[0]!;
      let resultNote = '';
      if (recentAlly.result === 'winner') resultNote = ', won event';
      else if (recentAlly.result === 'finalist') resultNote = ', finalist';
      rowParts.push(
        `As allies: ${ally.length} event(s) — last ${recentAlly.year} ${recentAlly.event_name ?? ''} (${recentAlly.stage ?? ''}${resultNote})`,
      );
    }

    if (rowParts.length) {
      lines.push(`  ${taLabel} vs ${tbLabel}:`);
      for (const rp of rowParts) lines.push(`    ${rp}`);
    }
  }

  return lines.join('\n');
}

/** Build a complete text dossier for a match. storyline_service.py:713. */
export async function assembleMatchDossier(eventKey: string, matchKey: string): Promise<string> {
  const tba = getTbaClient();
  const matchData = await tba.getMatch<Obj>(matchKey);
  if (!matchData) return '';

  const year = Number(eventKey.slice(0, 4));
  const redKeys: string[] = matchData.alliances?.red?.team_keys ?? [];
  const blueKeys: string[] = matchData.alliances?.blue?.team_keys ?? [];
  const allKeys = [...redKeys, ...blueKeys];
  const teamNumbers = allKeys.map((tk) => Number(tk.replace('frc', '')));

  async function fetchConnections(): Promise<Obj[]> {
    try {
      return await getMatchConnections(eventKey, teamNumbers, true);
    } catch {
      return [];
    }
  }

  const [dossiers, connections] = await Promise.all([
    Promise.all(allKeys.map((tk) => buildTeamDossier(tk, eventKey, year))),
    fetchConnections(),
  ]);

  const compLevel = matchData.comp_level ?? 'qm';
  const matchNum = matchData.match_number ?? '?';
  const setNum = matchData.set_number ?? 1;

  const levelNames: Record<string, string> = {
    qm: 'Qualification',
    sf: 'Semifinal',
    f: 'Final',
    ef: 'Eighth-Final',
    qf: 'Quarterfinal',
  };
  const levelLabel = levelNames[compLevel] ?? String(compLevel).toUpperCase();
  const matchLabel =
    compLevel === 'qm' ? `${levelLabel} Match ${matchNum}` : `${levelLabel} ${setNum} Match ${matchNum}`;

  const parts: string[] = [`Match: ${matchLabel}`, ''];

  parts.push('RED ALLIANCE:');
  for (let i = 0; i < redKeys.length; i += 1) {
    if (i < dossiers.length) {
      parts.push(formatTeamDossier(dossiers[i]!));
      parts.push('');
    }
  }

  parts.push('BLUE ALLIANCE:');
  for (let i = 0; i < blueKeys.length; i += 1) {
    const idx = redKeys.length + i;
    if (idx < dossiers.length) {
      parts.push(formatTeamDossier(dossiers[idx]!));
      parts.push('');
    }
  }

  const h2hSection = formatH2hConnections(connections);
  if (h2hSection) {
    parts.push(h2hSection);
    parts.push('');
  }

  return parts.join('\n');
}

/** Build a complete text dossier for a single team deep dive. storyline_service.py:780. */
export async function assembleTeamDossier(eventKey: string, teamNumber: number): Promise<string> {
  const year = Number(eventKey.slice(0, 4));
  const teamKey = `frc${teamNumber}`;
  const dossier = await buildTeamDossier(teamKey, eventKey, year);
  return formatTeamDossier(dossier);
}

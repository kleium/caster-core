/**
 * FTC individual team lookup card — port of `get_team_lookup` and its helpers
 * (`_build_events_list`, `_build_event_results`, `_parse_alliance_role`) in
 * backend/app/services/ftc_event_service.py.
 *
 * NOT PORTED: the `include_history=True` branch. `get_team_lookup` has exactly
 * one caller (`ftc_events.py:310`) and it never passes the flag, so that block
 * is unreachable in production — porting ~80 lines of code no request can hit
 * would add surface that could never be parity-tested. Revisit if a route ever
 * starts passing it.
 */
import { getFtcClient } from './ftcClient.js';
import { getFtcscoutClient } from './ftcscoutClient.js';
import { pyGet, pyOr, pyTruthy } from '../lib/pysemantics.js';
import { pyRound } from '../lib/pyround.js';
import { ApiError } from '../plugins/errorEnvelope.js';

type Obj = Record<string, any>;

const FTC_WINNER_ID = 13;
const FTC_FINALIST_ID = 12;
const ALLIANCE_AWARD_IDS = new Set([FTC_WINNER_ID, FTC_FINALIST_ID]);

const EVENT_TYPE_LABEL: Record<string, string> = {
  '0': 'Scrimmage',
  '1': 'League Meet',
  '2': 'Qualifier',
  '3': 'League Tournament',
  '4': 'Championship',
  '6': 'FIRST Championship',
  '7': 'Super Qualifier',
  '10': 'Off-Season',
  '17': 'Premier',
};

/** Raw FTC event list → simplified dicts. ftc_event_service.py:_build_events_list. */
function buildEventsList(events: Obj[], season: number): Obj[] {
  return events.map((ev) => ({
    event_code: pyGet(ev, 'code', ''),
    event_name: pyGet(ev, 'name', ''),
    event_type: pyGet(EVENT_TYPE_LABEL, String(pyGet(ev, 'type', '')), 'Qualifier'),
    city: pyGet(ev, 'city', ''),
    state_prov: pyGet(ev, 'stateprov', ''),
    start_date: pyGet(ev, 'dateStart', ''),
    end_date: pyGet(ev, 'dateEnd', ''),
    year: season,
  }));
}

/** Parse an alliance role from an award name. ftc_event_service.py:_parse_alliance_role. */
function parseAllianceRole(awardName: string, prefix: string): string {
  const name = awardName.trim();
  for (const p of [`${prefix} Alliance`, `${prefix}ing Alliance`]) {
    if (name.toLowerCase().startsWith(p.toLowerCase())) {
      const role = name.slice(p.length).trim().replace(/^-+/, '').trim();
      if (!role) return prefix;
      return `Alliance ${role}`;
    }
  }
  return prefix;
}

/** FRC-style per-event result rows. ftc_event_service.py:_build_event_results. */
function buildEventResults(events: Obj[], awards: Obj[], year: number): Obj[] {
  const nowMs = Date.now();

  const awardsByEvent = new Map<string, Obj[]>();
  for (const a of awards) {
    const ec = pyGet(a, 'eventCode', '') as string;
    if (ec) {
      if (!awardsByEvent.has(ec)) awardsByEvent.set(ec, []);
      awardsByEvent.get(ec)!.push(a);
    }
  }

  const results: Obj[] = [];
  for (const ev of events) {
    // Skip future events. Python compares a NAIVE datetime (Z stripped) against
    // `datetime.utcnow()`, i.e. both are UTC — so parse as UTC here, not local,
    // which is what `new Date("...T00:00:00")` would otherwise do.
    const dateEnd = pyGet(ev, 'dateEnd', '') as string;
    if (dateEnd) {
      const endMs = Date.parse(`${String(dateEnd).replace('Z', '')}Z`);
      if (!Number.isNaN(endMs) && endMs > nowMs) continue;
    }

    const ec = pyGet(ev, 'code', '') as string;
    const et = String(pyGet(ev, 'type', ''));
    const evAwards = awardsByEvent.get(ec) ?? [];

    let allianceStr: string | null = null;
    let playoffResult: string | null = null;
    const realAwardsAtEvent: string[] = [];
    for (const a of evAwards) {
      const aid = a.awardId;
      const name = pyGet(a, 'name', '') as string;
      if (aid === FTC_WINNER_ID) {
        playoffResult = 'Winner';
        allianceStr = parseAllianceRole(name, 'Winner');
      } else if (aid === FTC_FINALIST_ID) {
        if (playoffResult !== 'Winner') playoffResult = 'Finalist';
        allianceStr = pyOr(allianceStr, parseAllianceRole(name, 'Finalist')) as string;
      } else {
        realAwardsAtEvent.push(name);
      }
    }

    results.push({
      event_name: pyGet(ev, 'name', ec),
      event_code: ec,
      event_type: pyGet(EVENT_TYPE_LABEL, et, 'Qualifier'),
      year,
      date_end: dateEnd ? String(dateEnd) : '',
      alliance: allianceStr,
      playoff_result: playoffResult,
      awards: realAwardsAtEvent,
    });
  }
  return results;
}

/** Build a team lookup card from FTC Events API + FTC Scout. ftc_event_service.py:get_team_lookup. */
export async function getTeamLookup(teamNumber: number, season: number): Promise<Obj> {
  const client = getFtcClient();
  const scout = getFtcscoutClient();

  // Avatar is fetched separately — the FTC API returns 501 for /avatars, which
  // would otherwise trip the circuit breaker.
  const settled = await Promise.allSettled([
    client.getTeamInfo(season, teamNumber),
    client.getTeamAwards(season, teamNumber),
    scout.getTeamQuickStats(teamNumber, season),
    client.getTeamEvents(season, teamNumber),
  ]);

  const info = settled[0].status === 'fulfilled' ? settled[0].value : null;
  if (!info) throw new ApiError(404, `FTC team ${teamNumber} not found.`);
  const awards = (settled[1].status === 'fulfilled' ? settled[1].value : []) as Obj[];
  const scoutData = (settled[2].status === 'fulfilled' ? settled[2].value : null) as Obj | null;
  const events = (settled[3].status === 'fulfilled' ? settled[3].value : []) as Obj[];

  // Python fetches the avatar here and then NEVER puts it in the result — the
  // value is discarded. Kept so behaviour (and the ftcClient cache warm this
  // causes) matches exactly; emitting an `avatar` key would break parity.
  // Worth deleting on both sides post-cutover: it is a wasted round trip on
  // every team lookup.
  try {
    await client.getTeamAvatar(season, teamNumber);
  } catch {
    /* avatars are optional */
  }

  const loc = pyGet(info, 'city', '') as string;
  const state = pyGet(info, 'stateProv', '') as string;
  const country = pyGet(info, 'country', '') as string;
  const locationStr = [loc, state, country].filter(Boolean).join(', ');

  const qs = (pyGet((pyOr(scoutData, {}) ?? {}) as Obj, 'quick_stats', {}) ?? {}) as Obj;
  const tot = (pyGet(qs, 'tot', {}) ?? {}) as Obj;
  const auto = (pyGet(qs, 'auto', {}) ?? {}) as Obj;
  const dc = (pyGet(qs, 'dc', {}) ?? {}) as Obj;

  const eventsThisSeason = buildEventsList(events, season);

  const eventNameMap: Record<string, string> = {};
  for (const ev of events) {
    eventNameMap[pyGet(ev, 'code', '') as string] = pyGet(ev, 'name', '') as string;
  }
  const mapAward = (a: Obj) => ({
    name: pyGet(a, 'name', ''),
    event: pyGet(eventNameMap, pyGet(a, 'eventCode', '') as string, pyGet(a, 'eventCode', '')),
    award_id: a.awardId ?? null,
  });
  const currentRealAwards = awards.filter((a) => !ALLIANCE_AWARD_IDS.has(a.awardId)).map(mapAward);
  const currentAlliancePicks = awards.filter((a) => ALLIANCE_AWARD_IDS.has(a.awardId)).map(mapAward);

  const currentEventResults = buildEventResults(events, awards, season);

  return {
    team_number: teamNumber,
    team_key: `ftc${teamNumber}`,
    nickname: pyOr(info.nameShort, pyOr(info.nameFull, `Team ${teamNumber}`)),
    name: pyGet(info, 'nameFull', ''),
    school_name: pyOr(
      pyGet((pyOr(scoutData, {}) ?? {}) as Obj, 'school_name', ''),
      pyGet(info, 'schoolName', ''),
    ),
    city: loc,
    state_prov: state,
    country,
    location: locationStr,
    rookie_year: info.rookieYear ?? null,
    website: pyGet(info, 'website', ''),
    season,
    quick_stats: qs,
    // Python: `round(v, 2) if tot.get("value") else None` — a 0 value yields None.
    opr_global: pyTruthy(tot.value) ? pyRound(pyGet(tot, 'value', 0) as number, 2) : null,
    opr_auto_global: pyTruthy(auto.value) ? pyRound(pyGet(auto, 'value', 0) as number, 2) : null,
    opr_dc_global: pyTruthy(dc.value) ? pyRound(pyGet(dc, 'value', 0) as number, 2) : null,
    global_rank: tot.rank ?? null,
    total_teams: qs.count ?? null,
    awards: currentRealAwards,
    alliance_selections: currentAlliancePicks,
    event_results: currentEventResults,
    events_this_season: eventsThisSeason,
    season_achievements: null,
    all_awards: null,
    program: 'FTC',
  };
}

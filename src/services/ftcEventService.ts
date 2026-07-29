/**
 * FTC event & team service — port of the info/teams/alliances slice of
 * backend/app/services/ftc_event_service.py.
 */
import { getFtcClient } from './ftcClient.js';
import { getFtcscoutClient } from './ftcscoutClient.js';
import { currentFtcSeason } from '../lib/ftcSeason.js';
import { readEvent, readEventTeamsFull } from './supabase.js';
import { parseFtcKey } from '../lib/ftcKey.js';
import { pyRound } from '../lib/pyround.js';
import { pyGet, pyOr, pyTruthy } from '../lib/pysemantics.js';
import { ApiError } from '../plugins/errorEnvelope.js';

type Obj = Record<string, any>;

// ── Event-type code maps (ftc_event_service.py:162-193) ──────
const TYPE_CODE_MAP: Record<string, number> = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '6': 6,
  '7': 5, '10': 99, '12': 100, '14': 100, '15': 100, '17': 3,
};
const TYPE_LABEL_MAP: Record<string, string> = {
  '0': 'Scrimmage', '1': 'League Meet', '2': 'Qualifier',
  '3': 'League Tournament', '4': 'Championship',
  '6': 'FIRST Championship', '7': 'Super Qualifier',
  '10': 'Off-Season', '12': 'Kickoff', '14': 'Practice Day',
  '15': 'Volunteer Event', '17': 'Premier',
};

/** 'upcoming' | 'ongoing' | 'completed' | 'unknown' (ftc_event_service.py:48). */
function eventStatus(startDate: string, endDate: string): string {
  const sd = startDate ? startDate.slice(0, 10) : '';
  const ed = endDate ? endDate.slice(0, 10) : '';
  const sdMs = Date.parse(`${sd}T00:00:00`);
  const edMs = Date.parse(`${ed}T00:00:00`);
  if (Number.isNaN(sdMs) || Number.isNaN(edMs)) return 'unknown';
  const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00`);
  if (todayMs > edMs + 86_400_000) return 'completed';
  if (todayMs >= sdMs) return 'ongoing';
  return 'upcoming';
}

/** Convert an FTC Events API event object to our frontend format. ftc_event_service.py:153. */
function normaliseEvent(ev: Obj, year: number): Obj {
  const code = ev.code ?? '';
  const eventKey = `${year}ftc${code}`.toLowerCase();
  const rawType = String(ev.type ?? '');
  const eventType = TYPE_CODE_MAP[rawType] ?? 2;
  const eventTypeString = TYPE_LABEL_MAP[rawType] ?? 'Qualifier';

  const start = ev.dateStart ?? '';
  const end = ev.dateEnd ?? '';
  let month: number | null = null;
  if (start) {
    const m = Number(start.slice(5, 7));
    if (Number.isFinite(m)) month = m;
  }

  return {
    key: eventKey,
    event_code: code,
    name: pyGet(ev, 'name', code),
    short_name: pyGet(ev, 'name', code),
    event_type: eventType,
    event_type_string: eventTypeString,
    city: pyGet(ev, 'city', ''),
    state_prov: pyGet(ev, 'stateprov', ''),
    country: pyGet(ev, 'country', ''),
    start_date: start,
    end_date: end,
    year,
    week: null,
    month,
    district: null,
    division_code: ev.divisionCode ?? null,
    region_code: pyGet(ev, 'regionCode', ''),
    league_code: pyGet(ev, 'leagueCode', ''),
    region: pyOr(pyGet(ev, 'regionCode', ''), pyGet(ev, 'stateprov', ''), pyGet(ev, 'country', '')),
    status: eventStatus(start, end),
    avatar: null,
    program: 'FTC',
  };
}

// ── get_event_info (ftc_event_service.py:232) ─────────────────
export async function getEventInfo(eventKey: string): Promise<Obj> {
  // ── Try Supabase first ──────────────────────────────────
  let row: Obj | null = null;
  try {
    row = await readEvent(eventKey);
  } catch {
    row = null;
  }

  if (row) {
    const raw = asObject(row.raw_data);
    const start = String(row.start_date ?? '');
    const end = String(row.end_date ?? '');
    const rawType = String(raw.type ?? '');
    const month = start && start.length >= 7 ? Number(start.slice(5, 7)) : null;
    const stateProv = pyGet(raw, 'stateprov', '');
    return {
      key: eventKey,
      event_code: raw.code ?? '',
      name: pyGet(row, 'name', ''),
      short_name: pyGet(row, 'name', ''),
      event_type: TYPE_CODE_MAP[rawType] ?? 2,
      event_type_string: TYPE_LABEL_MAP[rawType] ?? 'Qualifier',
      city: pyGet(raw, 'city', ''),
      state_prov: stateProv,
      country: pyGet(raw, 'country', ''),
      start_date: start,
      end_date: end,
      year: /^\d{4}/.test(eventKey) ? Number(eventKey.slice(0, 4)) : null,
      week: null,
      month,
      district: null,
      division_code: raw.divisionCode ?? null,
      region_code: pyGet(raw, 'regionCode', ''),
      league_code: pyGet(raw, 'leagueCode', ''),
      region: pyOr(pyGet(raw, 'regionCode', ''), stateProv, pyGet(raw, 'country', '')),
      status: pyOr(raw.status, eventStatus(start, end)),
      avatar: null,
      program: 'FTC',
      webcasts: [],
    };
  }

  // ── Fallback: FTC Events API ─────────────────────────────
  const [year, eventCode] = parseFtcKey(eventKey);
  const client = getFtcClient();
  const ev = await client.getEvent(year, eventCode);
  if (!ev) {
    throw new ApiError(404, `FTC event '${eventKey}' not found.`);
  }
  const info = normaliseEvent(ev, year);
  info.webcasts = [];
  return info;
}

function asObject(v: unknown): Obj {
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' ? (v as Obj) : {};
}

/** Rich enough to serve if at least one row has a rank. ftc_event_service.py:63. */
function sbFtcTeamsValid(sbRows: Obj[]): boolean {
  for (const r of sbRows) {
    const rd = asObject(r.raw_data);
    if (rd.rank != null) return true;
  }
  return false;
}

// ── get_event_teams_with_stats (ftc_event_service.py:302) ─────
export async function getEventTeamsWithStats(eventKey: string): Promise<Obj[]> {
  // ── Try Supabase first ──────────────────────────────────
  let sbRows: Obj[] = [];
  try {
    sbRows = await readEventTeamsFull(eventKey);
  } catch (e) {
    console.warn(`Supabase FTC event_teams read failed for ${eventKey}: ${String(e)}`);
    sbRows = [];
  }

  if (sbRows.length && sbFtcTeamsValid(sbRows)) {
    const results: Obj[] = [];
    for (const r of sbRows) {
      const tk = r.team_key as string;
      const raw = asObject(r.raw_data);
      const tims = asObject(r.tims_data);

      const oprVal = raw.opr_total as number | undefined;
      const sortOrders = (raw.sort_orders ?? []) as unknown[];
      const rpVal = sortOrders.length ? sortOrders[0] : (raw.rp ?? null);
      const wins = raw.wins ?? 0;
      const losses = raw.losses ?? 0;
      const ties = raw.ties ?? 0;
      const mp = raw.matches_played ?? 0;

      results.push({
        team_number: r.team_number ?? 0,
        team_key: tk,
        nickname: pyGet(r, 'nickname', ''),
        name: pyOr(tims.full_name, pyGet(r, 'nickname', '')),
        city: pyGet(tims, 'city', ''),
        state_prov: pyGet(tims, 'state_prov', ''),
        country: pyGet(tims, 'country', ''),
        rookie_year: tims.rookie_year ?? null,
        school_name: pyGet(tims, 'school_name', ''),
        avatar: null,
        rank: raw.rank ?? null,
        wins,
        losses,
        ties,
        record: { wins, losses, ties },
        qual_average: raw.qual_average ?? null,
        matches_played: mp,
        sort_orders: sortOrders,
        ranking_points: rpVal,
        rp: rpVal,
        tb: sortOrders.length > 1 ? sortOrders[1] : null,
        opr: oprVal != null ? pyRound(oprVal, 2) : 0,
        opr_auto: raw.opr_auto ?? null,
        opr_dc: raw.opr_dc ?? null,
        opr_np: raw.opr_np ?? null,
        avg_total: raw.avg_total ?? null,
        avg_auto: raw.avg_auto ?? null,
        avg_dc: raw.avg_dc ?? null,
        avg_np: raw.avg_np ?? null,
        max_total: raw.max_total ?? null,
        max_auto: raw.max_auto ?? null,
        max_dc: raw.max_dc ?? null,
        min_total: raw.min_total ?? null,
        dev_total: raw.dev_total ?? null,
        quick_stats: raw.quick_stats ?? null,
        epa: null,
        program: 'FTC',
      });
    }

    sortByRankThenNumber(results);
    return results;
  }

  // ── Fallback: FTC Events API + FTC Scout ─────────────────
  const [year, eventCode] = parseFtcKey(eventKey);
  const client = getFtcClient();
  const scout = getFtcscoutClient();

  const [teamsR, rankingsR, statsR] = await Promise.allSettled([
    client.getEventTeams(year, eventCode),
    client.getRankings(year, eventCode),
    scout.getEventTeamStats(year, eventCode),
  ]);

  const rawTeams = teamsR.status === 'fulfilled' ? teamsR.value : [];
  if (teamsR.status === 'rejected') {
    console.warn(`FTC teams fetch failed for ${eventKey}: ${String(teamsR.reason)}`);
  }
  const rawRankings = rankingsR.status === 'fulfilled' ? rankingsR.value : [];
  if (rankingsR.status === 'rejected') {
    console.warn(`FTC rankings fetch failed for ${eventKey}: ${String(rankingsR.reason)}`);
  }
  const scoutStats = statsR.status === 'fulfilled' ? statsR.value : [];
  if (statsR.status === 'rejected') {
    console.warn(`FTC Scout stats fetch failed for ${eventKey}: ${String(statsR.reason)}`);
  }

  const rankMap: Record<number, Obj> = {};
  for (const r of rawRankings) {
    const num = r.teamNumber ?? 0;
    if (num) rankMap[num] = r;
  }
  const scoutMap: Record<number, Obj> = {};
  for (const s of scoutStats) {
    const num = s.team_number ?? 0;
    if (num) scoutMap[num] = s;
  }

  const apiResults: Obj[] = [];
  for (const t of rawTeams) {
    const num = t.teamNumber ?? 0;
    const ranking = rankMap[num] ?? {};
    const sdata = scoutMap[num] ?? {};

    const wins = ranking.wins ?? 0;
    const losses = ranking.losses ?? 0;
    const ties = ranking.ties ?? 0;
    const oprVal = sdata.opr_total as number | undefined;
    const sortOrders = (ranking.sortOrders ?? []) as unknown[];
    const rpVal = sortOrders.length ? sortOrders[0] : null;

    apiResults.push({
      team_number: num,
      team_key: `ftc${num}`,
      nickname: t.nameShort || t.nameFull || `Team ${num}`,
      name: t.nameFull || t.nameShort || '',
      city: pyGet(t, 'city', ''),
      state_prov: pyGet(t, 'stateProv', ''),
      country: pyGet(t, 'country', ''),
      rookie_year: t.rookieYear ?? null,
      school_name: pyGet(t, 'schoolName', ''),
      avatar: null,
      rank: ranking.rank ?? null,
      wins,
      losses,
      ties,
      record: { wins, losses, ties },
      qual_average: ranking.qualAverage ?? null,
      matches_played: ranking.matchesPlayed ?? 0,
      sort_orders: sortOrders,
      ranking_points: rpVal,
      rp: rpVal,
      tb: sortOrders.length > 1 ? sortOrders[1] : null,
      opr: oprVal != null ? pyRound(oprVal, 2) : 0,
      opr_auto: sdata.opr_auto ?? null,
      opr_dc: sdata.opr_dc ?? null,
      opr_np: sdata.opr_np ?? null,
      avg_total: sdata.avg_total ?? null,
      avg_auto: sdata.avg_auto ?? null,
      avg_dc: sdata.avg_dc ?? null,
      avg_np: sdata.avg_np ?? null,
      max_total: sdata.max_total ?? null,
      max_auto: sdata.max_auto ?? null,
      max_dc: sdata.max_dc ?? null,
      min_total: sdata.min_total ?? null,
      dev_total: sdata.dev_total ?? null,
      quick_stats: sdata.quick_stats ?? null,
      epa: null,
      program: 'FTC',
    });
  }

  sortByRankThenNumber(apiResults);
  return apiResults;
}

function sortByRankThenNumber(rows: Obj[]): void {
  rows.sort((a, b) => {
    const ra = a.rank ?? 9999;
    const rb = b.rank ?? 9999;
    if (ra !== rb) return ra - rb;
    return a.team_number - b.team_number;
  });
}

// ── get_alliances (ftc_event_service.py:890) ──────────────────

/** Extract a team number from an alliance "slot" (dict, number, or missing). */
function slotTeamNum(slot: unknown): number {
  if (slot && typeof slot === 'object') return (slot as Obj).teamNumber ?? 0;
  if (typeof slot === 'number') return Math.trunc(slot);
  return 0;
}

/** Convert raw FTC API alliances to the frontend format. ftc_event_service.py:898. */
function normaliseAlliances(raw: Obj[]): Obj[] {
  const results: Obj[] = [];
  raw.forEach((a, idx) => {
    const i = idx + 1;
    const pickNums = [a.captain, a.round1, a.round2, a.round3]
      .filter((p) => p !== null && p !== undefined)
      .map(slotTeamNum)
      .filter((n) => n);
    results.push({
      number: a.number ?? i,
      picks: pickNums.map((n) => `ftc${n}`),
      pick_numbers: pickNums,
      name: a.name ?? `Alliance ${i}`,
    });
  });
  return results;
}

/**
 * Alliance selections for an FTC event. Reads from Supabase first (stored in
 * events.raw_data by ftc_event_sync); falls back to the FTC Events API.
 * ftc_event_service.py:890.
 */
export async function getAlliances(eventKey: string): Promise<Obj[]> {
  const [year, eventCode] = parseFtcKey(eventKey);

  // ── Try Supabase first ──────────────────────────────────
  try {
    const evRow = await readEvent(eventKey);
    if (evRow) {
      const evRaw = asObject(evRow.raw_data);
      const stored = evRaw.alliances;
      if (stored && Array.isArray(stored) && stored.length) {
        return normaliseAlliances(stored);
      }
    }
  } catch (e) {
    console.debug(`Supabase alliances read failed for ${eventKey}: ${String(e)}`);
  }

  // ── Fallback: FTC Events API ─────────────────────────────
  const client = getFtcClient();
  const raw = await client.getAlliances(year, eventCode);
  return normaliseAlliances(raw);
}

// ── Season event listing (ftc_event_service.py:get_season_events) ──

/**
 * FTC events for a season, normalised to the frontend format.
 * FTC Events API type codes are string integers:
 *   0=Scrimmage 1=LeagueMeet 2=Qualifier 3=LeagueTournament 4=Championship
 *   6=FIRSTChampionship 7=SuperQualifier 10=OffSeason 12=Kickoff
 *   14=PracticeDay 15=VolunteerEvent 17=Premier
 */
export async function getSeasonEvents(year: number, includeOffseason = false): Promise<Obj[]> {
  const client = getFtcClient();
  const rawEvents = await client.getEvents(year);

  const NON_COMPETITION_TYPES = new Set(['0', '12', '14', '15']);
  const OFFSEASON_TYPES = new Set(['10']);

  const results: Obj[] = [];
  for (const ev of rawEvents) {
    const typeCode = String(pyGet(ev, 'type', ''));
    if (NON_COMPETITION_TYPES.has(typeCode)) continue;
    if (!includeOffseason && OFFSEASON_TYPES.has(typeCode)) continue;
    results.push(normaliseEvent(ev, year));
  }

  // Python sorts by `e.get("start_date", "")` — plain string comparison.
  results.sort((a, b) => {
    const av = (pyGet(a, 'start_date', '') ?? '') as string;
    const bv = (pyGet(b, 'start_date', '') ?? '') as string;
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  return results;
}

/** Lightweight FTC rankings from the FTC Events API. ftc_event_service.py:get_fast_rankings. */
export async function getFastRankings(eventKey: string): Promise<Obj[]> {
  const [year, eventCode] = parseFtcKey(eventKey);
  const rankings = await getFtcClient().getRankings(year, eventCode);

  return rankings.map((r) => {
    const so = (pyGet(r, 'sortOrders', [null]) ?? [null]) as unknown[];
    // Python: `r.get("sortOrders", [None])[0] if r.get("sortOrders") else None`
    // — a present-but-empty list is falsy, so it yields None, not an index error.
    const rp = pyTruthy(r.sortOrders) ? (so[0] ?? null) : null;
    return {
      team_key: `ftc${r.teamNumber}`,
      team_number: r.teamNumber,
      rank: r.rank ?? null,
      wins: pyGet(r, 'wins', 0),
      losses: pyGet(r, 'losses', 0),
      ties: pyGet(r, 'ties', 0),
      qual_average: r.qualAverage ?? null,
      matches_played: pyGet(r, 'matchesPlayed', 0),
      ranking_points: rp,
      rp,
    };
  });
}

// ── World record + OPR history (ftc_event_service.py) ───────

/** FTC world-record match from FTC Scout, with the event name resolved. */
export async function getFtcWorldRecord(season?: number | null): Promise<Obj | null> {
  const scout = getFtcscoutClient();
  const client = getFtcClient();
  const year = season ?? currentFtcSeason();
  const rec = await scout.getWorldRecord(year);
  if (!rec) return null;

  // FTC Scout's WR query returns no event name, so event_name starts equal to
  // event_code — resolve it against the season's event list when so.
  const ec = pyGet(rec, 'event_code', '') as string;
  if (ec && rec.event_name === ec) {
    try {
      const events = await client.getEvents(year);
      for (const ev of events) {
        if (pyGet(ev, 'code', '') === ec) {
          rec.event_name = pyGet(ev, 'name', ec);
          break;
        }
      }
    } catch {
      /* name resolution is best-effort */
    }
  }
  return rec;
}

/** OPR history across seasons for an FTC team. */
export async function getTeamOprHistory(teamNumber: number, season: number): Promise<Obj[]> {
  return getFtcscoutClient().getTeamOprHistory(teamNumber, season);
}

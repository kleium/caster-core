/**
 * Event read layer — port of the info + teams paths of
 * backend/app/services/event_service.py (M3a/M3b).
 *
 * Parity notes (must match FastAPI byte-for-byte):
 *  - Object key order mirrors the Python dict literals exactly.
 *  - Python emits `null` for None; here every nullable field is `?? null`
 *    (a bare `undefined` would be dropped by JSON.stringify).
 *  - Numeric rounding uses pyRound (round-half-to-even) to match Python round().
 */
import { getTbaClient } from './tbaClient.js';
import { getFrcClient } from './frcClient.js';
import { getEpaMap } from './statboticsClient.js';
import { getAvatarsFromCache, prefetchAvatars } from './avatarCache.js';
import {
  getSupabase,
  mergeEventTeams,
  readEvent,
  readEventTeamsFull,
  readEventsByYear,
  readTeamAvatars,
  type MergeRow,
} from './supabase.js';
import { coalesce } from '../lib/inflight.js';
import { pyRound } from '../lib/pyround.js';

// ── Region resolution (event_service.py:47-124) ─────────────
const REGION_MAP: Record<string, Set<string>> = {
  'New England': new Set(['NH', 'MA', 'CT', 'RI', 'VT', 'ME']),
  'New York': new Set(['NY']),
  'Mid-Atlantic': new Set(['NJ', 'PA', 'DE']),
  Chesapeake: new Set(['VA', 'MD', 'DC']),
  'North Carolina': new Set(['NC']),
  'South Carolina': new Set(['SC']),
  Georgia: new Set(['GA']),
  Southeast: new Set(['FL', 'AL', 'MS', 'TN', 'KY', 'WV', 'LA', 'AR']),
  Indiana: new Set(['IN']),
  Michigan: new Set(['MI']),
  Midwest: new Set(['OH', 'IL', 'MN', 'IA', 'MO', 'ND', 'SD', 'NE', 'KS']),
  Wisconsin: new Set(['WI']),
  Texas: new Set(['TX']),
  Mountain: new Set(['MT', 'WY', 'CO', 'NM', 'AZ', 'UT', 'ID', 'NV']),
  California: new Set(['CA']),
  'Pacific Northwest': new Set(['WA', 'OR']),
  Pacific: new Set(['HI', 'AK']),
};

const REGION_MERGE: Record<string, string> = {
  Israel: 'FIRST Israel',
  Texas: 'FIRST In Texas',
  California: 'FIRST California',
  Wisconsin: 'FIRST Wisconsin',
  Indiana: 'FIRST Indiana Robotics',
  Michigan: 'FIRST in Michigan',
  'North Carolina': 'FIRST North Carolina',
  'South Carolina': 'FIRST South Carolina',
  Georgia: 'Peachtree',
  Chesapeake: 'FIRST Chesapeake',
  'Mid-Atlantic': 'FIRST Mid-Atlantic',
};

const CANADA_PROVINCE_DISTRICT: Record<string, string> = {
  ON: 'FIRST Canada - Ontario',
  Ontario: 'FIRST Canada - Ontario',
};

const COUNTRY_LABELS = [
  'Türkiye', 'Israel', 'China', 'Australia', 'Brazil', 'Mexico', 'Chinese Taipei',
  'India', 'Japan', 'Chile', 'Colombia', 'Egypt', 'Poland',
];

interface District {
  abbreviation?: string;
  display_name?: string;
}

function resolveRegion(
  country: string,
  stateProv: string,
  district: District | null | undefined,
): string {
  if (district && district.abbreviation) {
    return district.display_name || district.abbreviation.toUpperCase();
  }
  if (country && country !== 'USA' && country !== '') {
    if (country.includes('Canada') || country.toLowerCase().includes('canada')) {
      const dist = CANADA_PROVINCE_DISTRICT[stateProv];
      if (dist) return dist;
      return 'Canada';
    }
    for (const label of COUNTRY_LABELS) {
      const cl = country.toLowerCase();
      if (cl.includes(label.toLowerCase()) || label.toLowerCase().includes(cl)) {
        return REGION_MERGE[label] ?? label;
      }
    }
    return country;
  }
  for (const [region, states] of Object.entries(REGION_MAP)) {
    if (states.has(stateProv)) return REGION_MERGE[region] ?? region;
  }
  return 'Other';
}

// ── Season event listing (event_service.py:127) ─────────────

const EXCLUDE_TYPES = new Set([99, 100, -1]);

/**
 * Lightweight event list for a season — Supabase first, TBA fallback.
 * Off-season/preseason (type 99) excluded unless includeOffseason.
 * event_service.py:127.
 */
export async function getSeasonEvents(
  year: number,
  includeOffseason = false,
): Promise<Record<string, unknown>[]> {
  // When including offseason, only exclude truly junk types (-1, 100).
  const exclude = includeOffseason ? new Set([100, -1]) : EXCLUDE_TYPES;

  const build = (
    key: string,
    name: string,
    shortName: unknown,
    week: unknown,
    startDate: string,
    endDate: string,
    city: unknown,
    stateProv: unknown,
    country: unknown,
    etype: number,
    etypeString: unknown,
    district: unknown,
  ) => ({
    key,
    name,
    short_name: pyOr(shortName, name),
    week: week ?? null,
    start_date: startDate,
    end_date: endDate,
    city: city ?? '',
    state_prov: stateProv ?? '',
    country: country ?? '',
    event_type: etype,
    event_type_string: etypeString ?? '',
    district: district ?? null,
    region:
      etype === 3 || etype === 4 || etype === 6
        ? 'FIRST Championship'
        : resolveRegion(
            (country ?? '') as string,
            (stateProv ?? '') as string,
            (district ?? null) as Record<string, unknown> | null,
          ),
  });

  // Python sorts by `(e["name"] or "").lower()`. localeCompare would apply
  // locale collation (e.g. accents, case folding) that Python's plain string
  // comparison does not — compare raw lowercased strings instead.
  const byName = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const an = ((a.name as string) || '').toLowerCase();
    const bn = ((b.name as string) || '').toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  };

  // ── Supabase first ────────────────────────────────────────
  let sbRows: Record<string, unknown>[] = [];
  try {
    sbRows = await readEventsByYear(year);
  } catch (e) {
    console.warn(`Supabase events read failed for ${year}: ${String(e)}`);
    sbRows = [];
  }

  if (sbRows.length) {
    const events: Record<string, unknown>[] = [];
    for (const row of sbRows) {
      let raw = pyOr(row.raw_data, {}) as Record<string, unknown>;
      if (typeof raw === 'string') raw = JSON.parse(raw);
      const etype = pyGet(raw, 'event_type', -1) as number;
      if (exclude.has(etype)) continue;
      events.push(
        build(
          row.event_key as string,
          pyGet(row, 'name', '') as string,
          raw.short_name,
          raw.week,
          String(pyGet(row, 'start_date', '')),
          String(pyGet(row, 'end_date', '')),
          pyGet(raw, 'city', ''),
          pyGet(raw, 'state_prov', ''),
          pyGet(raw, 'country', ''),
          etype,
          pyGet(raw, 'event_type_string', ''),
          raw.district,
        ),
      );
    }
    events.sort(byName);
    return events;
  }

  // ── Fallback: TBA ─────────────────────────────────────────
  const raw = await getTbaClient().getEventsByYear<Record<string, unknown>[]>(year);
  const events: Record<string, unknown>[] = [];
  for (const ev of raw) {
    const etype = pyGet(ev, 'event_type', -1) as number;
    if (exclude.has(etype)) continue;
    events.push(
      build(
        ev.key as string,
        pyGet(ev, 'name', '') as string,
        ev.short_name,
        ev.week,
        pyGet(ev, 'start_date', '') as string,
        pyGet(ev, 'end_date', '') as string,
        pyGet(ev, 'city', ''),
        pyGet(ev, 'state_prov', ''),
        pyGet(ev, 'country', ''),
        etype,
        pyGet(ev, 'event_type_string', ''),
        ev.district,
      ),
    );
  }
  events.sort(byName);
  return events;
}

// ── Fast rankings (event_service.py) ────────────────────────

/** Single-flight coalesced lightweight rankings lookup. */
export async function getFastRankings(eventKey: string): Promise<Record<string, unknown>[]> {
  return coalesce(`fast_rankings:${eventKey}`, getFastRankingsImpl as never, eventKey as never);
}

/** Python sorts by `x["rank"] if isinstance(x["rank"], int) else 999`. */
function byRank(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const ra = typeof a.rank === 'number' && Number.isInteger(a.rank) ? (a.rank as number) : 999;
  const rb = typeof b.rank === 'number' && Number.isInteger(b.rank) ? (b.rank as number) : 999;
  return ra - rb;
}

async function getFastRankingsImpl(eventKey: string): Promise<Record<string, unknown>[]> {
  // ── Supabase first (match_poller refreshes every 15s) ─────
  let sbRows: Record<string, unknown>[] = [];
  try {
    sbRows = await readEventTeamsFull(eventKey);
  } catch {
    sbRows = [];
  }

  const parseRaw = (v: unknown): Record<string, unknown> | null => {
    let rd = pyOr(v, {}) as unknown;
    if (typeof rd === 'string') rd = JSON.parse(rd);
    if (typeof rd !== 'object' || rd === null || Array.isArray(rd)) return null;
    return rd as Record<string, unknown>;
  };

  if (sbRows.length) {
    let hasRanks = false;
    for (const r of sbRows) {
      const rd = parseRaw(r.raw_data);
      if (!rd) continue;
      if (rd.rank !== null && rd.rank !== undefined) {
        hasRanks = true;
        break;
      }
    }

    if (hasRanks) {
      const result: Record<string, unknown>[] = [];
      for (const r of sbRows) {
        // Python does NOT re-guard non-dict here (only in the has_ranks probe),
        // so a string raw_data would raise; parseRaw returning {} keeps us on
        // the same path for the dict case, which is all that occurs in practice.
        const raw = parseRaw(r.raw_data) ?? {};
        if (raw.rank === null || raw.rank === undefined) continue;
        const sortOrders = (pyOr(raw.sort_orders, []) ?? []) as unknown[];
        const mp = pyGet(raw, 'matches_played', 0) as number;
        const rankingPoints =
          sortOrders.length && typeof sortOrders[0] === 'number'
            ? mp
              ? pyRound((sortOrders[0] as number) * mp, 1)
              : null
            : null;
        result.push({
          team_key: r.team_key,
          rank: pyGet(raw, 'rank', '-'),
          wins: pyGet(raw, 'wins', 0),
          losses: pyGet(raw, 'losses', 0),
          ties: pyGet(raw, 'ties', 0),
          qual_average: pyGet(raw, 'qual_average', 0),
          ranking_points: rankingPoints,
        });
      }
      result.sort(byRank);
      return result;
    }
  }

  // ── Fallback: FRC API → TBA ───────────────────────────────
  const yearPrefix = eventKey.slice(0, 4);
  const year = /^\d+$/.test(yearPrefix) ? Number(yearPrefix) : new Date().getFullYear();
  const eventCode = eventKey.slice(4);

  let frcRankings: Record<string, unknown>[] | null = null;
  try {
    frcRankings = await getFrcClient().getRankings(year, eventCode);
  } catch {
    frcRankings = null;
  }

  if (!frcRankings || !frcRankings.length) {
    const tba = getTbaClient();
    tba.clearCacheEntry(`/event/${eventKey}/rankings`);
    let tbaRankings: Record<string, any> | null = null;
    try {
      tbaRankings = await tba.getEventRankings<Record<string, any>>(eventKey);
    } catch {
      tbaRankings = null;
    }
    if (!tbaRankings || !pyTruthy(tbaRankings.rankings)) return [];
    const result: Record<string, unknown>[] = [];
    for (const r of tbaRankings.rankings as Record<string, any>[]) {
      const rec = (pyGet(r, 'record', {}) ?? {}) as Record<string, unknown>;
      const extra = (pyGet(r, 'extra_stats', []) ?? []) as unknown[];
      const sortOrders = (pyGet(r, 'sort_orders', []) ?? []) as unknown[];
      let rankingPoints: number | null;
      if (extra.length && typeof extra[0] === 'number') {
        rankingPoints = pyRound(extra[0] as number, 1);
      } else if (sortOrders.length && typeof sortOrders[0] === 'number') {
        const mp = pyGet(r, 'matches_played', 0) as number;
        rankingPoints = mp ? pyRound((sortOrders[0] as number) * mp, 1) : null;
      } else {
        rankingPoints = null;
      }
      result.push({
        team_key: r.team_key,
        rank: pyGet(r, 'rank', '-'),
        wins: pyGet(rec, 'wins', 0),
        losses: pyGet(rec, 'losses', 0),
        ties: pyGet(rec, 'ties', 0),
        qual_average: pyGet(r, 'qual_average', 0),
        ranking_points: rankingPoints,
      });
    }
    result.sort(byRank);
    return result;
  }

  const result: Record<string, unknown>[] = [];
  for (const r of frcRankings as Record<string, any>[]) {
    const matchesPlayed = pyGet(r, 'matchesPlayed', 0) as number;
    const qualAverage = pyGet(r, 'qualAverage', 0) as number;
    // FRC sortOrder1 is average RP; total RP = avg * matches played.
    const sort1 = (pyOr(pyGet(r, 'sortOrder1', 0), 0) ?? 0) as number;
    result.push({
      team_key: `frc${r.teamNumber}`,
      rank: pyGet(r, 'rank', '-'),
      wins: pyGet(r, 'wins', 0),
      losses: pyGet(r, 'losses', 0),
      ties: pyGet(r, 'ties', 0),
      qual_average: qualAverage ? pyRound(qualAverage, 2) : 0,
      ranking_points: matchesPlayed ? pyRound(sort1 * matchesPlayed, 1) : null,
    });
  }
  result.sort(byRank);
  return result;
}

// ── Status (event_service.py:314) ───────────────────────────
function parseDate(s: string): number {
  const t = Date.parse(`${s}T00:00:00`);
  return t;
}

function eventStatus(startDate: string, endDate: string): string {
  const sd = parseDate(startDate);
  const ed = parseDate(endDate);
  if (Number.isNaN(sd) || Number.isNaN(ed)) return 'unknown';
  const today = parseDate(new Date().toISOString().slice(0, 10));
  if (today > ed + 86_400_000) return 'completed';
  if (today >= sd) return 'ongoing';
  return 'upcoming';
}

// ── event_teams cache-validity (event_service.py:29) ────────
function asObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

// ── Python semantics helpers ────────────────────────────────
// Python `x or y` falls through on ANY falsy x (None/0/""/False), and
// dict.get(k, default) returns the stored value even when it's None — the
// default applies ONLY when the key is absent. JS `??`/`||` don't match both,
// so replicate them explicitly to preserve byte/semantic parity.
function pyTruthy(v: unknown): boolean {
  return !(v == null || v === 0 || v === '' || v === false);
}

/** dict.get(key, default): present-null returns null; absent returns default. */
function pyGet(obj: Record<string, unknown>, key: string, dflt: unknown = undefined): unknown {
  return key in obj ? obj[key] : dflt;
}

/** Python `a or b or … or z`: first truthy value, else the last value verbatim. */
function pyOr(...vals: unknown[]): unknown {
  for (let i = 0; i < vals.length - 1; i += 1) {
    if (pyTruthy(vals[i])) return vals[i];
  }
  return vals[vals.length - 1];
}

function sbTeamsValid(sbRows: Record<string, unknown>[]): boolean {
  for (const r of sbRows) {
    const rd = asObject(r.raw_data);
    if (rd.rank != null || rd.opr != null) return true;
  }
  return false;
}

// ── TIMS overrides (event_service.py:227-311) ───────────────
const TIMS_FIELDS = [
  'custom_nickname', 'custom_sponsor_read', 'custom_robot_name', 'custom_motto',
  'custom_organization', 'custom_location', 'custom_top_sponsors', 'custom_pronunciation',
  'custom_hardware', 'custom_auto_strategy', 'custom_teleop_strategy', 'custom_number_display',
  'author_name', 'author_event_key', 'updated_at',
] as const;

async function loadTimsOverrides(
  teamKeys: string[],
): Promise<Record<string, Record<string, unknown>>> {
  if (teamKeys.length === 0) return {};
  try {
    const { data } = await getSupabase()
      .from('tims_overrides')
      .select(
        'team_key, custom_nickname, custom_sponsor_read, custom_robot_name, custom_motto, ' +
          'custom_organization, custom_location, custom_top_sponsors, custom_pronunciation, ' +
          'custom_hardware, custom_auto_strategy, custom_teleop_strategy, custom_number_display, ' +
          'author_name, author_event_key, updated_at',
      )
      .in('team_key', teamKeys)
      .eq('is_deleted', false);
    const result: Record<string, Record<string, unknown>> = {};
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const overrides: Record<string, unknown> = {};
      for (const field of TIMS_FIELDS) {
        if (row[field] != null) overrides[field] = row[field];
      }
      if (Object.keys(overrides).length) result[row.team_key as string] = overrides;
    }
    return result;
  } catch (e) {
    console.warn(`Failed to load TIMS overrides: ${String(e)}`);
    return {};
  }
}

function applyTimsOverrides(team: Record<string, unknown>, o: Record<string, unknown>): void {
  if ('custom_nickname' in o) team.nickname = o.custom_nickname;
  if ('custom_sponsor_read' in o) team.sponsor_read = o.custom_sponsor_read;
  if ('custom_robot_name' in o) team.robot_name = o.custom_robot_name;
  if ('custom_motto' in o) team.motto = o.custom_motto;
  if ('custom_organization' in o) team.school_name = o.custom_organization;
  if ('custom_location' in o) {
    const parts = String(o.custom_location).split(/,(.*)/s).slice(0, 2).map((p) => p.trim());
    if (parts.length >= 2 && parts[1] !== undefined && parts[1] !== '') {
      team.city = parts[0];
      team.state_prov = parts[1];
    } else {
      team.city = o.custom_location;
    }
  }
  if ('custom_top_sponsors' in o) team.top_sponsors = o.custom_top_sponsors;
  if ('custom_pronunciation' in o) team.name_pronounce = o.custom_pronunciation;
  if ('custom_hardware' in o) team.hardware = o.custom_hardware;
  if ('custom_auto_strategy' in o) team.auto_strategy = o.custom_auto_strategy;
  if ('custom_teleop_strategy' in o) team.teleop_strategy = o.custom_teleop_strategy;
  if ('custom_number_display' in o) {
    const nd = o.custom_number_display;
    if (nd && /\d/.test(String(nd))) team.number_display = nd;
  }
  if ('author_name' in o) team.tims_author = o.author_name;
  if ('author_event_key' in o) team.tims_event_key = o.author_event_key;
  if ('updated_at' in o) team.tims_updated_at = o.updated_at;
  team.has_tims_overrides = true;
}

// ── get_event_info (event_service.py:331) ───────────────────
export function getEventInfo(eventKey: string): Promise<Record<string, unknown>> {
  return coalesce(`event_info:${eventKey}`, getEventInfoImpl as never, eventKey as never);
}

async function getEventInfoImpl(eventKey: string): Promise<Record<string, unknown>> {
  let row: Record<string, unknown> | null = null;
  try {
    row = await readEvent(eventKey);
  } catch {
    row = null;
  }

  const yearFromKey = /^\d{4}/.test(eventKey) ? Number(eventKey.slice(0, 4)) : null;

  if (row) {
    const raw = asObject(row.raw_data);
    const start = String(row.start_date ?? '');
    const end = String(row.end_date ?? '');
    const etype = (raw.event_type ?? -1) as number;
    const region =
      etype === 3 || etype === 4
        ? ''
        : resolveRegion(
            (raw.country as string) ?? '',
            (raw.state_prov as string) ?? '',
            raw.district as District | null,
          );
    return {
      key: row.event_key,
      name: row.name ?? '',
      year: yearFromKey,
      city: raw.city ?? '',
      state_prov: raw.state_prov ?? '',
      country: raw.country ?? '',
      event_type_string: raw.event_type_string ?? '',
      event_type: etype,
      start_date: start,
      end_date: end,
      status: eventStatus(start, end),
      region,
    };
  }

  // Fallback: TBA.
  const client = getTbaClient();
  const ev = await client.getEvent<Record<string, unknown>>(eventKey);
  const start = String(ev.start_date ?? '');
  const end = String(ev.end_date ?? '');
  const etype = (ev.event_type ?? -1) as number;
  const region =
    etype === 3 || etype === 4
      ? ''
      : resolveRegion(
          (ev.country as string) ?? '',
          (ev.state_prov as string) ?? '',
          ev.district as District | null,
        );
  return {
    key: ev.key,
    name: ev.name ?? '',
    year: ev.year ?? null,
    city: ev.city ?? '',
    state_prov: ev.state_prov ?? '',
    country: ev.country ?? '',
    event_type_string: ev.event_type_string ?? '',
    event_type: etype,
    start_date: start,
    end_date: end,
    status: eventStatus(start, end),
    region,
  };
}

// ── get_event_teams_with_stats (event_service.py:398) ───────
export function getEventTeamsWithStats(eventKey: string): Promise<Record<string, unknown>[]> {
  return coalesce(`event_teams:${eventKey}`, getEventTeamsImpl as never, eventKey as never);
}

/** Total RP from extra_stats[0] or sort_orders[0]*matchesPlayed (shared logic). */
function computeRankingPoints(
  extra: unknown[],
  sortOrders: unknown[],
  matchesPlayed: number,
): number | null {
  if (extra.length && typeof extra[0] === 'number') return pyRound(extra[0], 1);
  if (sortOrders.length && typeof sortOrders[0] === 'number') {
    return matchesPlayed ? pyRound(sortOrders[0] * matchesPlayed, 1) : null;
  }
  return null;
}

async function getEventTeamsImpl(eventKey: string): Promise<Record<string, unknown>[]> {
  const year = /^\d{4}/.test(eventKey) ? Number(eventKey.slice(0, 4)) : new Date().getFullYear();

  let sbRows: Record<string, unknown>[] = [];
  try {
    sbRows = await readEventTeamsFull(eventKey);
  } catch (e) {
    console.warn(`Supabase event_teams read failed for ${eventKey}: ${String(e)}`);
    sbRows = [];
  }

  if (sbRows.length && sbTeamsValid(sbRows)) {
    const allKeys = sbRows.map((r) => r.team_key as string);
    let avatarMap: Record<string, string> = {};
    try {
      avatarMap = await readTeamAvatars(allKeys, year);
    } catch {
      avatarMap = {};
    }

    const missingAvatarKeys = allKeys.filter((k) => !(k in avatarMap));
    if (missingAvatarKeys.length) {
      let diskExtra: Record<string, string> = {};
      try {
        diskExtra = await getAvatarsFromCache(missingAvatarKeys, year);
        Object.assign(avatarMap, diskExtra);
      } catch {
        /* ignore */
      }
      const stillMissing = missingAvatarKeys.filter((k) => !(k in diskExtra));
      if (stillMissing.length) void prefetchAvatars(stillMissing, year).catch(() => undefined);
    }

    // Backfill rankings from TBA if Supabase has no rank data.
    let hasRanks = false;
    for (const r of sbRows) {
      if (asObject(r.raw_data).rank != null) {
        hasRanks = true;
        break;
      }
    }
    const rankMap: Record<string, Record<string, any>> = {};
    if (!hasRanks) {
      try {
        const rankings = await getTbaClient().getEventRankings<{ rankings?: Record<string, any>[] }>(
          eventKey,
        );
        if (rankings && rankings.rankings) {
          for (const rk of rankings.rankings) rankMap[rk.team_key] = rk;
        }
      } catch {
        /* ignore */
      }
    }

    const result: Record<string, unknown>[] = [];
    for (const r of sbRows) {
      const tk = r.team_key as string;
      const raw = asObject(r.raw_data);
      const tims = asObject(r.tims_data);
      const frcD = asObject(r.frc_data);
      const epaBlock = asObject(raw.epa);

      const tbaRk = rankMap[tk] ?? {};
      const tbaRec = tbaRk.record ?? {};

      const sortOrders = (raw.sort_orders ?? tbaRk.sort_orders ?? []) as unknown[];
      const mp = (raw.matches_played ?? tbaRk.matches_played ?? 0) as number;
      const extra = (tbaRk.extra_stats ?? []) as unknown[];
      const rankingPoints = computeRankingPoints(extra, sortOrders, mp);

      const oprRaw = raw.opr as number | undefined;
      result.push({
        team_key: tk,
        team_number: r.team_number ?? 0,
        nickname: r.nickname ?? '',
        school_name: frcD.schoolName || tims.school_name || '',
        city: frcD.city || tims.city || '',
        state_prov: frcD.stateProv || tims.state_prov || '',
        country: frcD.country || tims.country || '',
        rookie_year: tims.rookie_year ?? frcD.rookieYear ?? null,
        avatar: avatarMap[tk] ?? null,
        rank: raw.rank ?? tbaRk.rank ?? '-',
        wins: raw.wins ?? tbaRec.wins ?? 0,
        losses: raw.losses ?? tbaRec.losses ?? 0,
        ties: raw.ties ?? tbaRec.ties ?? 0,
        qual_average: pyOr(pyGet(raw, 'qual_average'), pyGet(tbaRk, 'qual_average', 0)),
        ranking_points: rankingPoints,
        opr: oprRaw ? pyRound(oprRaw, 2) : 0,
        epa: epaBlock.epa ?? null,
        epa_auto: epaBlock.epa_auto ?? null,
        epa_teleop: epaBlock.epa_teleop ?? null,
        epa_endgame: epaBlock.epa_endgame ?? null,
      });
    }

    sortByRank(result);

    const allTeamKeys = result.map((t) => t.team_key as string);
    const timsMap = await loadTimsOverrides(allTeamKeys);
    for (const t of result) {
      const overrides = timsMap[t.team_key as string];
      if (overrides) applyTimsOverrides(t, overrides);
    }

    // EPA backfill from Statbotics if none present.
    if (!result.some((t) => t.epa)) {
      try {
        const epaMap = await getEpaMap(eventKey);
        if (Object.keys(epaMap).length) {
          for (const t of result) {
            const epaBlock = epaMap[t.team_key as string] ?? {};
            t.epa = epaBlock.epa ?? null;
            t.epa_auto = epaBlock.epa_auto ?? null;
            t.epa_teleop = epaBlock.epa_teleop ?? null;
            t.epa_endgame = epaBlock.epa_endgame ?? null;
          }
          const mergeRows: MergeRow[] = Object.entries(epaMap)
            .filter(([, epa]) => epa != null)
            .map(([tk, epa]) => ({ event_key: eventKey, team_key: tk, data: { epa } }));
          if (mergeRows.length) void mergeEventTeams(mergeRows).catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
    }

    return result;
  }

  // ── Fallback: TBA + Statbotics ────────────────────────────
  const client = getTbaClient();
  const [teamsR, rankingsR, oprsR, epaR] = await Promise.all([
    client.getEventTeamsFull<Record<string, any>[]>(eventKey).catch(() => null),
    client.getEventRankings<{ rankings?: Record<string, any>[] }>(eventKey).catch(() => null),
    client.getEventOprs<{ oprs?: Record<string, number> }>(eventKey).catch(() => null),
    getEpaMap(eventKey).catch(() => null),
  ]);

  const teams = teamsR ?? [];
  const epaData = epaR ?? {};

  const allTeamKeys0 = teams.map((t) => t.key as string);
  const avatarMap = await getAvatarsFromCache(allTeamKeys0, year);
  const missingAvatarKeys = allTeamKeys0.filter((k) => !(k in avatarMap));
  if (missingAvatarKeys.length) void prefetchAvatars(missingAvatarKeys, year).catch(() => undefined);

  const rankMap: Record<string, Record<string, any>> = {};
  if (rankingsR && rankingsR.rankings) {
    for (const r of rankingsR.rankings) rankMap[r.team_key] = r;
  }
  const oprMap: Record<string, { opr: number }> = {};
  if (oprsR && oprsR.oprs) {
    for (const tk of Object.keys(oprsR.oprs)) oprMap[tk] = { opr: pyRound(oprsR.oprs[tk] ?? 0, 2) };
  }

  const result: Record<string, unknown>[] = [];
  for (const t of teams) {
    const tk = t.key as string;
    const r = rankMap[tk] ?? {};
    const rec = r.record ?? {};
    const o = oprMap[tk] ?? { opr: 0 };
    const epa = (epaData as Record<string, any>)[tk] ?? {};
    const extra = (r.extra_stats ?? []) as unknown[];
    const sortOrders = (r.sort_orders ?? []) as unknown[];
    const rankingPoints = computeRankingPoints(extra, sortOrders, (r.matches_played ?? 0) as number);
    result.push({
      team_key: tk,
      team_number: t.team_number,
      nickname: t.nickname ?? '',
      school_name: t.school_name ?? '',
      city: t.city ?? '',
      state_prov: t.state_prov ?? '',
      country: t.country ?? '',
      rookie_year: t.rookie_year ?? null,
      avatar: avatarMap[tk] ?? null,
      rank: r.rank ?? '-',
      wins: rec.wins ?? 0,
      losses: rec.losses ?? 0,
      ties: rec.ties ?? 0,
      qual_average: pyGet(r, 'qual_average', 0),
      ranking_points: rankingPoints,
      opr: o.opr,
      epa: epa.epa ?? null,
      epa_auto: epa.epa_auto ?? null,
      epa_teleop: epa.epa_teleop ?? null,
      epa_endgame: epa.epa_endgame ?? null,
    });
  }

  sortByRank(result);

  const allTeamKeys = result.map((t) => t.team_key as string);
  const timsMap = await loadTimsOverrides(allTeamKeys);
  for (const t of result) {
    const overrides = timsMap[t.team_key as string];
    if (overrides) applyTimsOverrides(t, overrides);
  }

  return result;
}

/** Stable sort by rank (ints first, non-ints treated as 999) — matches Python. */
function sortByRank(rows: Record<string, unknown>[]): void {
  rows.sort((a, b) => {
    const ra = typeof a.rank === 'number' ? a.rank : 999;
    const rb = typeof b.rank === 'number' ? b.rank : 999;
    return ra - rb;
  });
}

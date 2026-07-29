/**
 * Async Supabase client singleton — port of
 * backend/app/services/supabase_client.py.
 *
 * Uses the service-role key (bypasses RLS). Strictly server-side — never
 * expose the service key to browsers or native apps.
 *
 * Ports: the internal 5xx circuit breaker, retry-on-deadlock (40P01), and the
 * per-event serialisation locks around merge_event_teams_batch.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from '../config.js';

// ── Singleton ───────────────────────────────────────────────
let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client === null) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_KEY must be set. Add them to your .env file.',
      );
    }
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    console.info(`Supabase client initialized (${SUPABASE_URL})`);
  }
  return _client;
}

// ── Circuit breaker for Supabase outages (5xx) ──────────────
let _cbFailures = 0;
let _cbOpenUntil = 0;
const CB_THRESHOLD = 3;
const CB_COOLDOWN = 30_000; // ms

function monotonicMs(): number {
  return performance.now();
}

function isCircuitOpen(): boolean {
  if (_cbFailures < CB_THRESHOLD) return false;
  return monotonicMs() < _cbOpenUntil;
}

function recordSuccess(): void {
  _cbFailures = 0;
}

function record5xx(): void {
  _cbFailures += 1;
  if (_cbFailures >= CB_THRESHOLD) {
    _cbOpenUntil = monotonicMs() + CB_COOLDOWN;
    console.warn(
      `Supabase circuit breaker OPEN — pausing writes for ${CB_COOLDOWN / 1000}s ` +
        `after ${_cbFailures} consecutive 5xx failures`,
    );
  }
}

/** A supabase-js query result carries { error: { code, message } | null }. */
interface QueryError {
  code?: string | number | null;
  message?: string | null;
}

function isServerError(err: QueryError): boolean {
  const raw = err.code;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(numeric) && numeric >= 500 && numeric < 600) return true;
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('web server is down') || msg.includes('521');
}

function isDeadlock(err: QueryError): boolean {
  return String(err.code) === '40P01' || (err.message ?? '').includes('40P01');
}

// ── Retry-on-deadlock wrapper ───────────────────────────────
const RETRY_MAX = 3;
const RETRY_BASE_MS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute a Supabase write, retrying on Postgres deadlock (40P01) up to 3×,
 * bailing out on 5xx outages and tripping the internal breaker. `fn` returns a
 * supabase-js result `{ error }`; a truthy `error` is thrown-equivalent.
 */
async function retryOnDeadlock(
  label: string,
  fn: () => Promise<{ error: QueryError | null }>,
): Promise<void> {
  if (isCircuitOpen()) {
    console.debug(`Supabase circuit open — skipping ${label}`);
    return;
  }

  for (let attempt = 1; attempt <= RETRY_MAX; attempt += 1) {
    const { error } = await fn();
    if (!error) {
      recordSuccess();
      return;
    }
    if (isServerError(error)) {
      record5xx();
      console.warn(`Supabase 5xx during ${label}: ${error.message ?? error.code}`);
      return; // don't retry on server outage
    }
    if (isDeadlock(error) && attempt < RETRY_MAX) {
      const wait = RETRY_BASE_MS * 2 ** (attempt - 1) + Math.random() * 100;
      console.info(
        `Deadlock on ${label} (attempt ${attempt}/${RETRY_MAX}) — retrying in ${Math.round(wait)}ms`,
      );
      await sleep(wait);
      continue;
    }
    // non-retryable or final attempt
    throw new Error(`Supabase error during ${label}: ${error.message ?? error.code}`);
  }
}

// ── Per-event serialisation locks for mergeEventTeams ───────
// Mirrors supabase_client.py:_merge_locks. A "lock" here is the tail of a
// promise chain per event_key: awaiting it serialises writes for the same
// event while letting different events proceed in parallel.
const _mergeChains = new Map<string, Promise<unknown>>();
const MERGE_LOCKS_MAX = 256;

async function withEventLock<T>(eventKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = _mergeChains.get(eventKey) ?? Promise.resolve();
  // Chain onto the previous op regardless of whether it resolved or rejected.
  const run = prev.catch(() => undefined).then(fn);
  _mergeChains.set(eventKey, run);
  try {
    return await run;
  } finally {
    // GC: only clear if nothing newer was chained after us.
    if (_mergeChains.get(eventKey) === run) {
      _mergeChains.delete(eventKey);
    }
    if (_mergeChains.size > MERGE_LOCKS_MAX) {
      // Opportunistically drop settled chains.
      for (const [k, chain] of _mergeChains) {
        if (chain === _mergeChains.get(k)) _mergeChains.delete(k);
        if (_mergeChains.size <= MERGE_LOCKS_MAX) break;
      }
    }
  }
}

// ── Write helpers ───────────────────────────────────────────

/** Bulk upsert rows into a table (on conflict = PK). supabase_client.py:184. */
export async function upsertRows(
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  await retryOnDeadlock(`upsert:${table}(${rows.length} rows)`, async () => {
    return await getSupabase().from(table).upsert(rows);
  });
}

export interface MergeRow {
  event_key: string;
  team_key: string;
  data: Record<string, unknown>;
}

/**
 * Atomically merge data into event_teams.raw_data via the
 * merge_event_teams_batch RPC, serialised per-event. supabase_client.py:259.
 */
export async function mergeEventTeams(rows: MergeRow[]): Promise<void> {
  if (rows.length === 0) return;

  const eventKeys = new Set(rows.map((r) => r.event_key).filter(Boolean));
  const lockKey = eventKeys.size === 1 ? [...eventKeys][0]! : '__multi__';

  await withEventLock(lockKey, async () => {
    await retryOnDeadlock(`merge_event_teams(${rows.length} rows)`, async () => {
      return await getSupabase().rpc('merge_event_teams_batch', { p_rows: rows });
    });
  });
}

/**
 * Delete matches no longer in the live schedule (ghost purge).
 * Returns the number of deleted rows. supabase_client.py:381.
 */
export async function deleteOrphanedMatches(
  eventKey: string,
  validMatchKeys: Set<string>,
): Promise<number> {
  if (validMatchKeys.size === 0) return 0;
  const sb = getSupabase();
  const { data: existing, error } = await sb
    .from('matches')
    .select('match_key')
    .eq('event_key', eventKey);
  if (error) {
    console.warn(`Orphan sweep read failed for ${eventKey}: ${error.message}`);
    return 0;
  }
  const existingKeys = new Set((existing ?? []).map((r) => r.match_key as string));
  const orphans = [...existingKeys].filter((k) => !validMatchKeys.has(k));
  if (orphans.length === 0) return 0;
  const { error: delErr } = await sb.from('matches').delete().in('match_key', orphans);
  if (delErr) {
    console.warn(`Orphan delete failed for ${eventKey}: ${delErr.message}`);
    return 0;
  }
  return orphans.length;
}

// ── Read helpers ────────────────────────────────────────────

/** All matches for an event, ordered like read_matches (supabase_client.py:366). */
export async function readMatches(eventKey: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await getSupabase()
    .from('matches')
    .select('*')
    .eq('event_key', eventKey)
    .order('comp_level')
    .order('set_number')
    .order('match_number');
  if (error) throw new Error(`readMatches(${eventKey}): ${error.message}`);
  return data ?? [];
}

// ── Event Summary Cache ─────────────────────────────────────

/** Read cached event summary from Supabase. Returns null on miss. supabase_client.py:222. */
export async function getCachedSummary(
  eventKey: string,
): Promise<{ summary?: unknown; awards?: unknown; updated_at?: string } | null> {
  try {
    const { data, error } = await getSupabase()
      .from('event_summary_cache')
      .select('summary, awards, updated_at')
      .eq('event_key', eventKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  } catch (exc) {
    console.warn(`Supabase summary cache read failed for ${eventKey}: ${String(exc)}`);
    return null;
  }
}

/** Upsert event summary / awards into the Supabase cache. supabase_client.py:239. */
export async function setCachedSummary(
  eventKey: string,
  summary?: unknown,
  awards?: unknown,
): Promise<void> {
  try {
    const row: Record<string, unknown> = { event_key: eventKey };
    if (summary !== undefined) row.summary = summary;
    if (awards !== undefined) row.awards = awards;
    const { error } = await getSupabase().from('event_summary_cache').upsert(row);
    if (error) throw new Error(error.message);
  } catch (exc) {
    console.warn(`Supabase summary cache write failed for ${eventKey}: ${String(exc)}`);
  }
}

/** A single event row, or null. supabase_client.py:344. */
export async function readEvent(eventKey: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await getSupabase()
    .from('events')
    .select('*')
    .eq('event_key', eventKey)
    .maybeSingle();
  if (error) throw new Error(`readEvent(${eventKey}): ${error.message}`);
  return data ?? null;
}

/** event_teams joined with teams via the Postgres function. supabase_client.py:357. */
export async function readEventTeamsFull(eventKey: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await getSupabase().rpc('get_event_teams_full', {
    p_event_key: eventKey,
  });
  if (error) throw new Error(`readEventTeamsFull(${eventKey}): ${error.message}`);
  return (data as Record<string, unknown>[]) ?? [];
}

/** { team_key: avatar_base64 } for teams that have avatars. supabase_client.py:415. */
export async function readTeamAvatars(
  teamKeys: string[],
  year: number,
): Promise<Record<string, string>> {
  if (teamKeys.length === 0) return {};
  const { data, error } = await getSupabase()
    .from('team_avatars')
    .select('team_key, avatar_base64')
    .in('team_key', teamKeys)
    .eq('year', year);
  if (error) throw new Error(`readTeamAvatars: ${error.message}`);
  const out: Record<string, string> = {};
  for (const r of data ?? []) {
    if (r.avatar_base64) out[r.team_key as string] = r.avatar_base64 as string;
  }
  return out;
}

/**
 * Raw FRC API playoff match objects for an event (comp_level sf/f), via the
 * get_frc_playoff_matches Postgres function. supabase_client.py:438.
 */
export async function readFrcPlayoffMatches(eventKey: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await getSupabase().rpc('get_frc_playoff_matches', {
    p_event_key: eventKey,
  });
  if (error) throw new Error(`readFrcPlayoffMatches(${eventKey}): ${error.message}`);
  return (data as Record<string, unknown>[]) ?? [];
}

/** Per-event regional advancement detail from Supabase. supabase_client.py:453. */
export async function readRegionalPoolEvent(
  year: number,
  eventKey: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await getSupabase()
    .from('regional_pool')
    .select('payload')
    .eq('year', year)
    .eq('event_key', eventKey)
    .maybeSingle();
  if (error) throw new Error(`readRegionalPoolEvent(${eventKey}): ${error.message}`);
  if (!data?.payload) return null;
  return typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
}

/** Global regional pool (qualified teams) from Supabase. supabase_client.py:473. */
export async function readRegionalPoolGlobal(
  year: number,
): Promise<Record<string, unknown>[] | null> {
  const { data, error } = await getSupabase()
    .from('regional_pool')
    .select('payload')
    .eq('year', year)
    .is('event_key', null)
    .maybeSingle();
  if (error) throw new Error(`readRegionalPoolGlobal(${year}): ${error.message}`);
  if (!data?.payload) return null;
  return typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;
}

/** All events for a given year from the events table. supabase_client.py:329. */
export async function readEventsByYear(year: number): Promise<Record<string, unknown>[]> {
  const { data, error } = await getSupabase()
    .from('events')
    .select('*')
    .gte('start_date', `${year}-01-01`)
    .lte('start_date', `${year}-12-31`);
  if (error) throw new Error(`readEventsByYear(${year}): ${error.message}`);
  return data ?? [];
}

/** Read a season_records row by primary key; null on miss. supabase_client.py:293. */
export async function getSeasonRecord(
  recordKey: string,
): Promise<{ payload?: unknown; updated_at?: string } | null> {
  try {
    const { data, error } = await getSupabase()
      .from('season_records')
      .select('payload, updated_at')
      .eq('record_key', recordKey)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  } catch (exc) {
    console.warn(`Supabase season_records read failed for ${recordKey}: ${String(exc)}`);
    return null;
  }
}

/** Upsert a season_records row. supabase_client.py:310. */
export async function setSeasonRecord(
  recordKey: string,
  year: number,
  recordType: string,
  payload: unknown,
): Promise<void> {
  try {
    const { error } = await getSupabase().from('season_records').upsert({
      record_key: recordKey,
      year,
      record_type: recordType,
      payload,
    });
    if (error) throw new Error(error.message);
  } catch (exc) {
    console.warn(`Supabase season_records write failed for ${recordKey}: ${String(exc)}`);
  }
}

/** Rows where updated_at > since, optionally narrowed. supabase_client.py:200. */
export async function fetchChanged(
  table: string,
  since: string,
  eqFilters?: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  let query = getSupabase().from(table).select('*').gt('updated_at', since);
  if (eqFilters) {
    for (const [col, val] of Object.entries(eqFilters)) {
      query = query.eq(col, val);
    }
  }
  const { data, error } = await query;
  if (error) throw new Error(`fetchChanged(${table}): ${error.message}`);
  return data ?? [];
}

/**
 * Statbotics API client (EPA data) — port of the subset of
 * backend/app/services/statbotics_client.py used by ingestion.
 *
 * Public API, no key. Be conservative: 1 concurrent outbound HTTP call with a
 * 0.5s floor between calls, plus in-flight coalescing so duplicate concurrent
 * requests for the same endpoint share one HTTP call.
 */
import { statboticsBreaker } from '../lib/circuitBreaker.js';
import { getJson, HttpStatusError } from '../lib/http.js';
import { pyRound } from '../lib/pyround.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

const STATBOTICS_BASE = 'https://api.statbotics.io/v3';
const CACHE_TTL = 300_000; // ms
const MIN_INTERVAL_MS = 500; // floor between outbound calls

/**
 * Only 503 counts as a breaker failure — Statbotics returns 404/500 for events
 * it hasn't indexed yet (data gaps, not outages). statbotics_client.py:20-29.
 */
function isServiceFailure(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.statusCode === 503;
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StatboticsClient {
  private readonly cache = new Map<string, { ts: number; data: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  // Serialise outbound calls (Semaphore(1)) via a promise chain, enforcing the
  // min interval between them.
  private gate: Promise<void> = Promise.resolve();
  private lastCall = 0;

  private async rateLimited<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      const wait = MIN_INTERVAL_MS - (performance.now() - this.lastCall);
      if (wait > 0) await sleep(wait);
      this.lastCall = performance.now();
      return fn();
    });
    // Keep the gate chain alive regardless of success/failure.
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async get<T = unknown>(endpoint: string, opts: { bypassCache?: boolean } = {}): Promise<T> {
    const now = Date.now();
    if (!opts.bypassCache) {
      const hit = this.cache.get(endpoint);
      if (hit && now - hit.ts < CACHE_TTL) return hit.data as T;
    }

    const existing = this.inFlight.get(endpoint);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      const data = await statboticsBreaker.call(
        () => this.rateLimited(() => getJson<T>(`${STATBOTICS_BASE}${endpoint}`)),
        isServiceFailure,
      );
      this.cache.set(endpoint, { ts: Date.now(), data });
      return data;
    })();

    this.inFlight.set(endpoint, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(endpoint);
    }
  }

  /** EPA for every team at an event (statbotics_client.py:114). */
  getTeamEventsForEvent<T = unknown>(eventKey: string): Promise<T> {
    return this.get<T>(`/team_events?event=${eventKey}`);
  }

  /** All match records for an event (includes predictions); [] on error (statbotics_client.py:128). */
  async getEventMatches<T = unknown>(eventKey: string): Promise<T[]> {
    try {
      return await this.get<T[]>(`/matches?event=${eventKey}&limit=500`);
    } catch {
      return [];
    }
  }

  /** Season-level EPA for a single team; null on error. statbotics_client.py:121. */
  async getTeamYear(teamNumber: number, year: number): Promise<Obj | null> {
    try {
      return await this.get<Obj>(`/team_year/${teamNumber}/${year}`);
    } catch {
      return null;
    }
  }

  /**
   * Raw fetch that checks the TTL cache and rate limiter but SKIPS the circuit
   * breaker — the caller wraps a batch in one `breaker.call()` so a brief
   * Statbotics outage counts as one failure, not N. statbotics_client.py:152.
   */
  private async raw<T>(endpoint: string): Promise<T> {
    const hit = this.cache.get(endpoint);
    if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data as T;
    const data = await this.rateLimited(() => getJson<T>(`${STATBOTICS_BASE}${endpoint}`));
    this.cache.set(endpoint, { ts: Date.now(), data });
    return data;
  }

  /** Top match scores + top EPA teams for a season. statbotics_client.py:135. */
  async getSeasonHighScores(year: number, limit = 5): Promise<Obj> {
    const fetchSeasonData = async (): Promise<[unknown, unknown, unknown]> => {
      const settled = await Promise.allSettled([
        this.raw<Obj[]>(`/matches?year=${year}&metric=red_score&ascending=false&limit=${limit * 2}`),
        this.raw<Obj[]>(`/matches?year=${year}&metric=blue_score&ascending=false&limit=${limit * 2}`),
        this.raw<Obj[]>(`/team_years?year=${year}&metric=epa&ascending=false&limit=50`),
      ]);
      // All three failed → propagate so the breaker counts one failure and the
      // caller falls back to stale data instead of caching an empty payload.
      if (settled.every((r) => r.status === 'rejected')) {
        throw (settled[0] as PromiseRejectedResult).reason;
      }
      return settled.map((r) => (r.status === 'fulfilled' ? r.value : r.reason)) as [
        unknown,
        unknown,
        unknown,
      ];
    };

    const [redRaw, blueRaw, epaRaw] = await statboticsBreaker.call(
      fetchSeasonData,
      isServiceFailure,
    );

    const redMatches: Obj[] = Array.isArray(redRaw) ? redRaw : [];
    const blueMatches: Obj[] = Array.isArray(blueRaw) ? blueRaw : [];
    const epaTeams: Obj[] = Array.isArray(epaRaw) ? epaRaw : [];

    const seen = new Map<string, Obj>();
    const collect = (matches: Obj[], color: 'red' | 'blue') => {
      for (const m of matches) {
        const key = pyGet(m, 'key', '') as string;
        const result = (pyOr(m.result, {}) ?? {}) as Obj;
        const score = pyOr(result[`${color}_score`], 0) as number;
        // {color}_no_foul can be null in the API — fall back to the raw score.
        const noFoulRaw = result[`${color}_no_foul`];
        const noFoul = (noFoulRaw === null || noFoulRaw === undefined ? score : noFoulRaw) as number;
        const teams = ((m.alliances?.[color]?.team_keys ?? []) as unknown[]).map((k) =>
          String(k).replace('frc', ''),
        );
        const row = {
          key,
          event_key: pyGet(m, 'event', '') as string,
          score,
          no_foul: noFoul,
          teams,
          color,
        };
        const prev = seen.get(key);
        if (!prev || noFoul > (prev.no_foul as number)) seen.set(key, row);
      }
    };
    collect(redMatches, 'red');
    collect(blueMatches, 'blue');

    const topMatches = [...seen.values()]
      .sort((a, b) => (b.no_foul as number) - (a.no_foul as number))
      .slice(0, limit);

    const teamNames: Record<string, string> = {};
    const topEpa: Obj[] = [];
    epaTeams.forEach((te, idx) => {
      const teamNum = te.team;
      const name = pyGet(te, 'name', '') as string;
      if (teamNum) teamNames[String(teamNum)] = name;
      if (idx < limit) {
        const epaBlock = (pyOr(te.epa, {}) ?? {}) as Obj;
        const total = (pyGet(epaBlock, 'total_points', {}) ?? {}) as Obj;
        topEpa.push({ team: teamNum, name, epa: round(pyGet(total, 'mean', 0) as number, 1) });
      }
    });

    // Fill in names for match teams outside the top-50 EPA list.
    const missing = new Set<string>();
    for (const m of topMatches) {
      for (const t of m.teams as string[]) if (!(t in teamNames)) missing.add(t);
    }
    if (missing.size) {
      const missingList = [...missing];
      const lookups = await Promise.allSettled(
        missingList.map((t) => this.getTeamYear(Number(t), year)),
      );
      missingList.forEach((tNum, i) => {
        const r = lookups[i]!;
        if (r.status !== 'fulfilled' || r.value === null) return;
        teamNames[tNum] = pyGet(r.value, 'name', '') as string;
      });
    }

    return { matches: topMatches, epa_teams: topEpa, team_names: teamNames };
  }

  /** Top teams by win count for a season. statbotics_client.py:258. */
  async getMostWins(year: number, limit = 10): Promise<Obj[]> {
    const raw = await this.get<unknown>(
      `/team_years?year=${year}&metric=wins&ascending=false&limit=${limit}`,
    );
    const rows = Array.isArray(raw) ? (raw as Obj[]) : [];
    return rows.map((te) => {
      const record = (pyOr(te.record, {}) ?? {}) as Obj;
      const epaBlock = (pyOr(te.epa, {}) ?? {}) as Obj;
      const total = (pyGet(epaBlock, 'total_points', {}) ?? {}) as Obj;
      return {
        team: te.team,
        name: pyGet(te, 'name', ''),
        country: pyGet(te, 'country', ''),
        state: pyGet(te, 'state', ''),
        wins: pyGet(record, 'wins', 0),
        losses: pyGet(record, 'losses', 0),
        ties: pyGet(record, 'ties', 0),
        count: pyGet(record, 'count', 0),
        winrate: round(pyGet(record, 'winrate', 0) as number, 4),
        epa: round(pyGet(total, 'mean', 0) as number, 1),
      };
    });
  }
}

// ── Singleton ───────────────────────────────────────────────
let _instance: StatboticsClient | null = null;

export function getStatboticsClient(): StatboticsClient {
  if (_instance === null) _instance = new StatboticsClient();
  return _instance;
}

const round = pyRound; // Python-compatible round-half-to-even

interface TeamEventEpa {
  team?: number;
  epa?: {
    total_points?: { mean?: number };
    breakdown?: { auto_points?: number; teleop_points?: number; endgame_points?: number };
  };
}

/**
 * Build `{ team_key: {epa, epa_auto, epa_teleop, epa_endgame} }` for an event.
 * team_key is TBA `frcNNNN` format. statbotics_client.py:298.
 */
export async function getEpaMap(
  eventKey: string,
): Promise<Record<string, Record<string, number>>> {
  const sb = getStatboticsClient();
  let teamEvents: TeamEventEpa[];
  try {
    teamEvents = await sb.getTeamEventsForEvent<TeamEventEpa[]>(eventKey);
  } catch {
    return {};
  }
  if (!Array.isArray(teamEvents)) return {};

  const epaMap: Record<string, Record<string, number>> = {};
  for (const te of teamEvents) {
    const teamNum = te.team;
    const epaBlock = te.epa ?? {};
    const total = epaBlock.total_points ?? {};
    const breakdown = epaBlock.breakdown ?? {};
    epaMap[`frc${teamNum}`] = {
      epa: round(total.mean ?? 0, 2),
      epa_auto: round(breakdown.auto_points ?? 0, 2),
      epa_teleop: round(breakdown.teleop_points ?? 0, 2),
      epa_endgame: round(breakdown.endgame_points ?? 0, 2),
    };
  }
  return epaMap;
}

interface StatboticsMatch {
  key?: string;
  pred?: {
    winner?: string;
    red_win_prob?: number | null;
    red_score?: number;
    blue_score?: number;
  };
}

/**
 * Build `{ match_key: {winner, red_win_prob, red_score, blue_score} }` for an
 * event. match_key is TBA format. Empty on error. statbotics_client.py:328.
 */
export async function getMatchPredictions(
  eventKey: string,
): Promise<Record<string, Record<string, unknown>>> {
  const sb = getStatboticsClient();
  let matches: StatboticsMatch[];
  try {
    matches = await sb.getEventMatches<StatboticsMatch>(eventKey);
  } catch {
    return {};
  }

  const predMap: Record<string, Record<string, unknown>> = {};
  for (const m of matches) {
    const key = m.key ?? '';
    const pred = m.pred ?? {};
    if (!pred || Object.keys(pred).length === 0) continue;
    const redWin = pred.red_win_prob;
    predMap[key] = {
      winner: pred.winner ?? '',
      red_win_prob: redWin != null ? round(redWin, 3) : null,
      red_score: round(pred.red_score ?? 0, 1),
      blue_score: round(pred.blue_score ?? 0, 1),
    };
  }
  return predMap;
}

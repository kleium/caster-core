/**
 * The Blue Alliance API v3 client with in-memory TTL cache — port of
 * backend/app/services/tba_client.py.
 */
import { BLUE_ALLIANCE_API_KEY } from '../config.js';
import { tbaBreaker } from '../lib/circuitBreaker.js';
import { getJson, HttpStatusError } from '../lib/http.js';

const TBA_BASE = 'https://www.thebluealliance.com/api/v3';
const CACHE_TTL = 120_000; // ms — reduced for faster live updates (tba_client.py:25)
const MAX_CACHE_ENTRIES = 500;

/**
 * Only count network/server (5xx) errors toward the breaker threshold.
 * 4xx (e.g. 404 for a team without media) are valid TBA responses.
 * tba_client.py:13-22.
 */
function isTbaFailure(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    return err.statusCode >= 500;
  }
  return true; // timeouts, connection errors, etc.
}

class TBAClient {
  private readonly headers = { 'X-TBA-Auth-Key': BLUE_ALLIANCE_API_KEY };
  private readonly cache = new Map<string, { ts: number; data: unknown }>();

  private evictCache(): void {
    const now = Date.now();
    for (const [k, { ts }] of this.cache) {
      if (now - ts >= CACHE_TTL) this.cache.delete(k);
    }
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const byAge = [...this.cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      const drop = this.cache.size - MAX_CACHE_ENTRIES;
      for (let i = 0; i < drop; i += 1) this.cache.delete(byAge[i]![0]);
    }
  }

  async get<T = unknown>(endpoint: string, opts: { bypassCache?: boolean } = {}): Promise<T> {
    const now = Date.now();
    if (!opts.bypassCache) {
      const hit = this.cache.get(endpoint);
      if (hit && now - hit.ts < CACHE_TTL) return hit.data as T;
    }
    this.evictCache();

    const data = await tbaBreaker.call(
      () => getJson<T>(`${TBA_BASE}${endpoint}`, { headers: this.headers }),
      isTbaFailure,
    );
    this.cache.set(endpoint, { ts: now, data });
    return data;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Remove a single cached endpoint (tba_client.py's `del client._cache[endpoint]` pattern). */
  clearCacheEntry(endpoint: string): void {
    this.cache.delete(endpoint);
  }

  // ── Event endpoints (mirrors tba_client.py) ──────────────
  getEventsByYear<T = unknown>(year: number) {
    return this.get<T>(`/events/${year}`);
  }
  getEvent<T = unknown>(eventKey: string) {
    return this.get<T>(`/event/${eventKey}`);
  }
  getEventTeamsFull<T = unknown>(eventKey: string) {
    return this.get<T>(`/event/${eventKey}/teams`);
  }
  getEventTeams<T = unknown>(eventKey: string) {
    return this.get<T>(`/event/${eventKey}/teams/simple`);
  }
  getEventRankings<T = unknown>(eventKey: string) {
    return this.get<T>(`/event/${eventKey}/rankings`);
  }
  getEventOprs<T = unknown>(eventKey: string) {
    return this.get<T>(`/event/${eventKey}/oprs`);
  }
  getEventMatches<T = unknown>(eventKey: string) {
    return this.get<T>(`/event/${eventKey}/matches`);
  }
  getEventAlliances<T = unknown>(eventKey: string) {
    return this.get<T>(`/event/${eventKey}/alliances`);
  }
  getTeamMedia<T = unknown>(teamKey: string, year: number) {
    return this.get<T>(`/team/${teamKey}/media/${year}`);
  }
  getTeam<T = unknown>(teamKey: string) {
    return this.get<T>(`/team/${teamKey}`);
  }
  getTeamYearsParticipated<T = unknown>(teamKey: string) {
    return this.get<T>(`/team/${teamKey}/years_participated`);
  }
  getTeamEvents<T = unknown>(teamKey: string, year: number) {
    return this.get<T>(`/team/${teamKey}/events/${year}`);
  }
  getTeamEventsStatuses<T = unknown>(teamKey: string, year: number) {
    return this.get<T>(`/team/${teamKey}/events/${year}/statuses`);
  }
  getTeamEventMatches<T = unknown>(teamKey: string, eventKey: string) {
    return this.get<T>(`/team/${teamKey}/event/${eventKey}/matches`);
  }
  getTeamAwards<T = unknown>(teamKey: string) {
    return this.get<T>(`/team/${teamKey}/awards`);
  }
  getTeamAwardsYear<T = unknown>(teamKey: string, year: number) {
    return this.get<T>(`/team/${teamKey}/awards/${year}`);
  }
  getTeamEventsSimple<T = unknown>(teamKey: string) {
    return this.get<T>(`/team/${teamKey}/events/simple`);
  }
  getMatch<T = unknown>(matchKey: string) {
    return this.get<T>(`/match/${matchKey}`);
  }
  getStatus<T = unknown>() {
    return this.get<T>('/status');
  }
}

// ── Singleton ───────────────────────────────────────────────
let _client: TBAClient | null = null;

export function getTbaClient(): TBAClient {
  if (_client === null) _client = new TBAClient();
  return _client;
}

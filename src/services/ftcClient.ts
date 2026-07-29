/**
 * FIRST FTC Events API v2.0 client with in-memory TTL cache — port of
 * backend/app/services/ftc_client.py.
 *
 * Docs: https://ftc-events.firstinspires.org/api-docs/index.html
 * Auth: Basic <base64(username:authkey)>
 */
import { FTC_EVENTS_API_TOKEN } from '../config.js';
import { ftcBreaker } from '../lib/circuitBreaker.js';
import { getJson } from '../lib/http.js';

const FTC_BASE = 'https://ftc-api.firstinspires.org/v2.0';
const CACHE_TTL = 120_000; // ms (ftc_client.py:18)
const RANKINGS_TTL = 15_000; // ms — fast refresh during events (ftc_client.py:137)

type Obj = Record<string, any>;

interface GetOptions {
  bypassCache?: boolean;
  ttlOverrideMs?: number;
  bypassBreaker?: boolean;
}

class FTCClient {
  private readonly headers = {
    Authorization: `Basic ${FTC_EVENTS_API_TOKEN}`,
    Accept: 'application/json',
  };
  private readonly cache = new Map<string, { ts: number; data: unknown }>();

  async get<T = unknown>(endpoint: string, opts: GetOptions = {}): Promise<T> {
    const now = Date.now();
    const ttl = opts.ttlOverrideMs ?? CACHE_TTL;
    if (!opts.bypassCache) {
      const hit = this.cache.get(endpoint);
      if (hit && now - hit.ts < ttl) return hit.data as T;
    }

    const doRequest = () => getJson<T>(`${FTC_BASE}${endpoint}`, { headers: this.headers });
    const data = opts.bypassBreaker ? await doRequest() : await ftcBreaker.call(doRequest);
    this.cache.set(endpoint, { ts: now, data });
    return data;
  }

  clearCache(): void {
    this.cache.clear();
  }

  clearCacheFor(...endpoints: string[]): void {
    for (const ep of endpoints) this.cache.delete(ep);
  }

  // ── Season Summary ────────────────────────────────────
  getSeasonSummary(season: number): Promise<Obj> {
    return this.get<Obj>(`/${season}`);
  }

  // ── Events ─────────────────────────────────────────────
  async getEvents(season: number): Promise<Obj[]> {
    const data = await this.get<{ events?: Obj[] }>(`/${season}/events`);
    return data.events ?? [];
  }

  async getTeamEvents(season: number, teamNumber: number): Promise<Obj[]> {
    const data = await this.get<{ events?: Obj[] }>(`/${season}/events?teamNumber=${teamNumber}`);
    return data.events ?? [];
  }

  async getEvent(season: number, eventCode: string): Promise<Obj | null> {
    const data = await this.get<{ events?: Obj[] }>(`/${season}/events?eventCode=${eventCode}`);
    const events = data.events ?? [];
    return events.length ? events[0]! : null;
  }

  // ── Teams ──────────────────────────────────────────────
  async getTeams(
    season: number,
    opts: { eventCode?: string; teamNumber?: number; page?: number } = {},
  ): Promise<Obj> {
    let url = `/${season}/teams`;
    const params: string[] = [];
    if (opts.eventCode) params.push(`eventCode=${opts.eventCode}`);
    if (opts.teamNumber) params.push(`teamNumber=${opts.teamNumber}`);
    params.push(`page=${opts.page ?? 1}`);
    url += `?${params.join('&')}`;
    return this.get<Obj>(url);
  }

  /** All teams at an event, handling pagination. ftc_client.py:117. */
  async getEventTeams(season: number, eventCode: string): Promise<Obj[]> {
    const allTeams: Obj[] = [];
    let page = 1;
    for (;;) {
      const data = await this.getTeams(season, { eventCode, page });
      allTeams.push(...((data.teams ?? []) as Obj[]));
      if (page >= (data.pageTotal ?? 1)) break;
      page += 1;
    }
    return allTeams;
  }

  async getTeamInfo(season: number, teamNumber: number): Promise<Obj | null> {
    const data = await this.getTeams(season, { teamNumber });
    const teams = (data.teams ?? []) as Obj[];
    return teams.length ? teams[0]! : null;
  }

  // ── Rankings ───────────────────────────────────────────
  async getRankings(season: number, eventCode: string): Promise<Obj[]> {
    const data = await this.get<{ rankings?: Obj[] }>(`/${season}/rankings/${eventCode}`, {
      ttlOverrideMs: RANKINGS_TTL,
    });
    return data.rankings ?? [];
  }

  // ── Matches / Schedule ─────────────────────────────────
  /** Hybrid schedule (results for played, schedule for upcoming). ftc_client.py:147. */
  async getScheduleHybrid(
    season: number,
    eventCode: string,
    level = 'qual',
    opts: { bypassCache?: boolean } = {},
  ): Promise<Obj[]> {
    const data = await this.get<{ schedule?: Obj[] }>(
      `/${season}/schedule/${eventCode}/${level}/hybrid`,
      { bypassCache: opts.bypassCache },
    );
    return data.schedule ?? [];
  }

  async getMatches(
    season: number,
    eventCode: string,
    opts: { level?: string; teamNumber?: number; bypassCache?: boolean } = {},
  ): Promise<Obj[]> {
    let url = `/${season}/matches/${eventCode}`;
    const params: string[] = [];
    if (opts.level) params.push(`tournamentLevel=${opts.level}`);
    if (opts.teamNumber !== undefined) params.push(`teamNumber=${opts.teamNumber}`);
    if (params.length) url += `?${params.join('&')}`;
    const data = await this.get<{ matches?: Obj[] }>(url, { bypassCache: opts.bypassCache });
    return data.matches ?? [];
  }

  // ── Score Details ──────────────────────────────────────
  async getScores(
    season: number,
    eventCode: string,
    level = 'qual',
    opts: { matchNumber?: number } = {},
  ): Promise<Obj[]> {
    let url = `/${season}/scores/${eventCode}/${level}`;
    if (opts.matchNumber !== undefined) url += `?matchNumber=${opts.matchNumber}`;
    const data = await this.get<{ matchScores?: Obj[] }>(url);
    return data.matchScores ?? [];
  }

  // ── Alliances ──────────────────────────────────────────
  async getAlliances(season: number, eventCode: string): Promise<Obj[]> {
    const data = await this.get<{ alliances?: Obj[] }>(`/${season}/alliances/${eventCode}`);
    return data.alliances ?? [];
  }

  async getAllianceSelection(season: number, eventCode: string): Promise<Obj[]> {
    const data = await this.get<{ selections?: Obj[] }>(`/${season}/alliances/${eventCode}/selection`);
    return data.selections ?? [];
  }

  // ── Awards ─────────────────────────────────────────────
  async getEventAwards(season: number, eventCode: string): Promise<Obj[]> {
    const data = await this.get<{ awards?: Obj[] }>(`/${season}/awards/${eventCode}`);
    return data.awards ?? [];
  }

  async getTeamAwards(season: number, teamNumber: number, eventCode?: string): Promise<Obj[]> {
    let url = `/${season}/awards/${teamNumber}`;
    if (eventCode) url += `?eventCode=${eventCode}`;
    const data = await this.get<{ awards?: Obj[] }>(url);
    return data.awards ?? [];
  }

  // ── Avatars ────────────────────────────────────────────
  /** Base64-encoded PNG avatar for a team, or null. ftc_client.py:223. */
  async getTeamAvatar(season: number, teamNumber: number): Promise<string | null> {
    const cacheKey = `avatar:${season}:${teamNumber}`;
    const now = Date.now();
    const hit = this.cache.get(cacheKey);
    if (hit && now - hit.ts < CACHE_TTL) {
      return (hit.data as string) || null;
    }
    try {
      const data = await this.get<{ teams?: Obj[] }>(`/${season}/avatars?teamNumber=${teamNumber}`, {
        bypassBreaker: true,
      });
      const teams = data.teams ?? [];
      if (teams.length && teams[0]!.encodedAvatar) {
        const avatar = `data:image/png;base64,${teams[0]!.encodedAvatar}`;
        this.cache.set(cacheKey, { ts: now, data: avatar });
        return avatar;
      }
    } catch {
      /* fall through to cache-and-return-null */
    }
    this.cache.set(cacheKey, { ts: now, data: '' });
    return null;
  }

  // ── Advancement ────────────────────────────────────────
  getAdvancement(season: number, eventCode: string): Promise<Obj> {
    return this.get<Obj>(`/${season}/advancement/${eventCode}`);
  }

  // ── Leagues ────────────────────────────────────────────
  async getLeagues(season: number, regionCode?: string): Promise<Obj[]> {
    let url = `/${season}/leagues`;
    if (regionCode) url += `?regionCode=${regionCode}`;
    const data = await this.get<{ leagues?: Obj[] }>(url);
    return data.leagues ?? [];
  }
}

// ── Singleton ───────────────────────────────────────────────
let _client: FTCClient | null = null;

export function getFtcClient(): FTCClient {
  if (_client === null) _client = new FTCClient();
  return _client;
}

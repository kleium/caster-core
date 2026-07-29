/**
 * FIRST FRC Events API v3 client with in-memory TTL cache — port of
 * backend/app/services/frc_client.py (Milestone 1 subset: matches + rankings).
 */
import { FRC_EVENTS_API_TOKEN } from '../config.js';
import { frcBreaker } from '../lib/circuitBreaker.js';
import { getJson } from '../lib/http.js';

const FRC_BASE = 'https://frc-api.firstinspires.org/v3.0';
const FRC_BASE_V32 = 'https://frc-api.firstinspires.org/v3.2';
const CACHE_TTL = 120_000; // ms (frc_client.py:15)
const RANKINGS_TTL = 15_000; // ms — near-instant ranking updates (frc_client.py:112)
const REGIONAL_POOL_TTL = 300_000; // ms — 5 min (frc_client.py:142)

// Public credentials for the Regional Pool page, embedded in the FIRST
// frontend bundle (frc_client.py:19-21).
const RA_AUTH = Buffer.from(
  'FRC_RegionalPool:F2057EBA-2E07-40C4-A1A3-D66CDFCA6326',
).toString('base64');

class FRCClient {
  private readonly headers = {
    Authorization: `Basic ${FRC_EVENTS_API_TOKEN}`,
    Accept: 'application/json',
  };
  private readonly headersV32 = {
    Authorization: `Basic ${RA_AUTH}`,
    Accept: 'application/json',
  };
  private readonly cache = new Map<string, { ts: number; data: unknown }>();

  async get<T = unknown>(
    endpoint: string,
    opts: { bypassCache?: boolean; ttlOverrideMs?: number } = {},
  ): Promise<T> {
    const now = Date.now();
    const ttl = opts.ttlOverrideMs ?? CACHE_TTL;
    if (!opts.bypassCache) {
      const hit = this.cache.get(endpoint);
      if (hit && now - hit.ts < ttl) return hit.data as T;
    }

    const data = await frcBreaker.call(() =>
      getJson<T>(`${FRC_BASE}${endpoint}`, { headers: this.headers }),
    );
    this.cache.set(endpoint, { ts: now, data });
    return data;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Match results array (frc_client.py:93). */
  async getMatches(
    season: number,
    eventCode: string,
    opts: { level?: string; teamNumber?: number; bypassCache?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    let url = `/${season}/matches/${eventCode}`;
    const params: string[] = [];
    if (opts.level) params.push(`tournamentLevel=${opts.level}`);
    if (opts.teamNumber !== undefined) params.push(`teamNumber=${opts.teamNumber}`);
    if (params.length) url += `?${params.join('&')}`;
    const data = await this.get<{ Matches?: Record<string, unknown>[] }>(url, {
      bypassCache: opts.bypassCache,
    });
    return data.Matches ?? [];
  }

  /** MatchScores array from the score-details endpoint. frc_client.py:78. */
  async getScores(
    season: number,
    eventCode: string,
    level = 'Qualification',
    opts: { matchNumber?: number | null; bypassCache?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    let url = `/${season}/scores/${eventCode}/${level}`;
    if (opts.matchNumber !== undefined && opts.matchNumber !== null) {
      url += `?matchNumber=${opts.matchNumber}`;
    }
    const data = await this.get<{ MatchScores?: Record<string, unknown>[] }>(url, {
      bypassCache: opts.bypassCache,
    });
    return data.MatchScores ?? [];
  }

  /** Rankings array with a short 15s TTL (frc_client.py:114). */
  async getRankings(season: number, eventCode: string): Promise<Record<string, unknown>[]> {
    const data = await this.get<{ Rankings?: Record<string, unknown>[] }>(
      `/${season}/rankings/${eventCode}`,
      { ttlOverrideMs: RANKINGS_TTL },
    );
    return data.Rankings ?? [];
  }

  /** Teams at an event with organization/school info (frc_client.py:134). */
  async getEventTeams(season: number, eventCode: string): Promise<Record<string, unknown>[]> {
    const data = await this.get<{ teams?: Record<string, unknown>[] }>(
      `/${season}/teams?eventCode=${eventCode}`,
    );
    return data.teams ?? [];
  }

  /**
   * Qualified regional-advancement-pool teams (v3.2, paginated). Returns only
   * teams that have qualified for the Championship (frc_client.py:144).
   */
  async getRegionalPool(season: number): Promise<Record<string, unknown>[]> {
    const cacheKey = `v32:/${season}/rankings/regional/teamdetail:qualified`;
    const now = Date.now();
    const hit = this.cache.get(cacheKey);
    if (hit && now - hit.ts < REGIONAL_POOL_TTL) {
      return hit.data as Record<string, unknown>[];
    }

    const teams = await frcBreaker.call(async () => {
      const qualified: Record<string, unknown>[] = [];
      let page = 1;
      for (;;) {
        const data = await getJson<{ teams?: Record<string, unknown>[]; pageTotal?: number }>(
          `${FRC_BASE_V32}/${season}/rankings/regional/teamdetail?page=${page}`,
          { headers: this.headersV32 },
        );
        for (const t of data.teams ?? []) {
          if (t['qualifiedFirstCmp']) qualified.push(t);
        }
        const pageTotal = data.pageTotal ?? 1;
        if (page >= pageTotal) break;
        page += 1;
      }
      return qualified;
    });

    this.cache.set(cacheKey, { ts: now, data: teams });
    return teams;
  }

  /** Per-event regional advancement detail (v3.2, frc_client.py:177). */
  async getRegionalPoolEvent(season: number, eventCode: string): Promise<Record<string, unknown>> {
    const endpoint = `/${season}/rankings/regional/eventdetail/${eventCode}`;
    const cacheKey = `v32:${endpoint}`;
    const now = Date.now();
    const hit = this.cache.get(cacheKey);
    if (hit && now - hit.ts < REGIONAL_POOL_TTL) {
      return hit.data as Record<string, unknown>;
    }
    const data = await frcBreaker.call(() =>
      getJson<Record<string, unknown>>(`${FRC_BASE_V32}${endpoint}`, {
        headers: this.headersV32,
      }),
    );
    this.cache.set(cacheKey, { ts: now, data });
    return data;
  }

  /** Lightweight connectivity probe used by /api/status. */
  async ping(): Promise<boolean> {
    try {
      await getJson(`${FRC_BASE}/`, { headers: this.headers });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Singleton ───────────────────────────────────────────────
let _client: FRCClient | null = null;

export function getFrcClient(): FRCClient {
  if (_client === null) _client = new FRCClient();
  return _client;
}

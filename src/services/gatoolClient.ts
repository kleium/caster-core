/**
 * GATool API client — community-edited team data from gatool.org.
 * Port of backend/app/services/gatool_client.py.
 */
import { gatoolBreaker } from '../lib/circuitBreaker.js';
import { HttpStatusError } from '../lib/http.js';

type Obj = Record<string, any>;

const GATOOL_BASE = 'https://api.gatool.org';
const CACHE_TTL = 300_000; // ms — 5 min; cloud data changes infrequently
const TIMEOUT_MS = 15_000;

class GAToolClient {
  private readonly cache = new Map<string, { ts: number; data: unknown }>();

  async get<T = unknown>(endpoint: string, opts: { bypassCache?: boolean } = {}): Promise<T> {
    const now = Date.now();
    if (!opts.bypassCache) {
      const hit = this.cache.get(endpoint);
      if (hit && now - hit.ts < CACHE_TTL) return hit.data as T;
    }

    const doRequest = async (): Promise<T> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const resp = await fetch(`${GATOOL_BASE}${endpoint}`, { signal: controller.signal });
        if (!resp.ok) {
          let body = '';
          try {
            body = await resp.text();
          } catch {
            /* ignore */
          }
          throw new HttpStatusError(resp.status, `${GATOOL_BASE}${endpoint}`, body);
        }
        // 204 No Content / empty body → null so callers degrade gracefully.
        if (resp.status === 204) return null as T;
        const text = await resp.text();
        if (!text) return null as T;
        return JSON.parse(text) as T;
      } finally {
        clearTimeout(timer);
      }
    };

    const data = await gatoolBreaker.call(doRequest);
    this.cache.set(endpoint, { ts: now, data });
    return data;
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Extract `{teamNumber: updates}` from a GATool communityUpdates payload. */
  private static collect(raw: unknown): Record<number, Obj> {
    if (!Array.isArray(raw)) return {};
    const result: Record<number, Obj> = {};
    for (const entry of raw as Obj[]) {
      // Mirrors Python's int(...) guarded by ValueError/TypeError.
      const rawNum = entry?.teamNumber ?? 0;
      const num =
        typeof rawNum === 'number'
          ? Math.trunc(rawNum)
          : /^[+-]?\d+$/.test(String(rawNum))
            ? Number(rawNum)
            : NaN;
      if (Number.isNaN(num)) continue;
      if (num && entry && 'updates' in entry) result[num] = entry.updates;
    }
    return result;
  }

  /** Community updates for all teams at an FRC event. gatool_client.py:52. */
  async getEventCommunityUpdates(year: number, eventCode: string): Promise<Record<number, Obj>> {
    let raw: unknown;
    try {
      raw = await this.get(`/v3/${year}/communityUpdates/${eventCode}`);
    } catch (e) {
      // Python catches only HTTPStatusError here — other errors propagate.
      if (e instanceof HttpStatusError) return {};
      throw e;
    }
    return GAToolClient.collect(raw);
  }

  /** Community updates for all teams at an FTC event. gatool_client.py:77. */
  async getFtcEventCommunityUpdates(year: number, eventCode: string): Promise<Record<number, Obj>> {
    let raw: unknown;
    try {
      raw = await this.get(`/ftc/v2/${year}/communityUpdates/${eventCode}`);
    } catch (e) {
      if (e instanceof HttpStatusError) return {};
      throw e;
    }
    return GAToolClient.collect(raw);
  }
}

// ── Singleton ───────────────────────────────────────────────
let _instance: GAToolClient | null = null;

export function getGatoolClient(): GAToolClient {
  if (_instance === null) _instance = new GAToolClient();
  return _instance;
}

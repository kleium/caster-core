/**
 * Minimal HTTP helper mirroring httpx semantics used by the Python clients:
 * a JSON GET that raises on non-2xx (like resp.raise_for_status()).
 *
 * Node 20+ ships fetch (undici) natively, so no extra dependency is needed.
 */

/** Raised on a non-2xx response — the analogue of httpx.HTTPStatusError. */
export class HttpStatusError extends Error {
  readonly statusCode: number;
  readonly url: string;
  constructor(statusCode: number, url: string, body?: string) {
    super(`HTTP ${statusCode} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpStatusError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000; // matches httpx timeout=30.0

export interface GetJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * GET `url` and return true iff the response status is exactly 200 — never
 * throws, never parses the body. Mirrors FastAPI's `resp.status_code == 200`
 * connectivity probes in main.py:332-363 (which only check status).
 */
export async function probeStatus(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = 8_000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    return resp.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// undici's global fetch can intermittently drop keep-alive connections under
// concurrent bursts (TypeError "fetch failed" with cause ECONNRESET /
// UND_ERR_SOCKET), where httpx's pool would not. Retry ONLY those transient
// network errors so the Node backend's reliability matches the FastAPI one.
// HTTP status errors (4xx/5xx) and timeouts are NOT retried — they propagate.
const NETWORK_RETRIES = 2;

interface RequestJsonOptions extends GetJsonOptions {
  method?: 'GET' | 'POST';
  body?: string;
}

async function requestJson<T>(url: string, opts: RequestJsonOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      });
      if (!resp.ok) {
        let body = '';
        try {
          body = await resp.text();
        } catch {
          /* ignore */
        }
        throw new HttpStatusError(resp.status, url, body);
      }
      return (await resp.json()) as T;
    } catch (err) {
      // Never retry a real HTTP status error or a timeout abort.
      if (err instanceof HttpStatusError) throw err;
      if (err instanceof Error && err.name === 'AbortError') throw err;
      lastErr = err;
      if (attempt < NETWORK_RETRIES) {
        await sleep(150 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** GET `url`, raise HttpStatusError on non-2xx, return parsed JSON. */
export function getJson<T = unknown>(url: string, opts: GetJsonOptions = {}): Promise<T> {
  return requestJson<T>(url, { ...opts, method: 'GET' });
}

/** POST `body` (already-serialized JSON) to `url`, return parsed JSON response. */
export function postJson<T = unknown>(
  url: string,
  body: string,
  opts: GetJsonOptions = {},
): Promise<T> {
  return requestJson<T>(url, { ...opts, method: 'POST', body });
}

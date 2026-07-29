/**
 * In-memory per-IP/API-key rate limiter — port of RateLimitMiddleware in
 * backend/app/main.py:96-207.
 *
 * Sliding 60s window, two buckets (general 300/min, heavy 60/min; trusted keys
 * 600/300). Only applies to /api/*. Returns 429 with the {detail, retry_after}
 * envelope plus X-RateLimit-* / Retry-After headers.
 *
 * ⚠️ Process-local, like the Python original — resets per restart and is not
 * shared across processes. Deploy as a single process.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { TRUSTED_API_KEYS } from '../config.js';

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_GENERAL = 300;
const RATE_LIMIT_HEAVY = 60;
const RATE_LIMIT_TRUSTED_GENERAL = 600;
const RATE_LIMIT_TRUSTED_HEAVY = 300;

// Heavy patterns kept specific to FRC paths so FTC routes aren't mis-bucketed
// (main.py:113-116).
const HEAVY_PATTERNS = [
  '/summary/awards',
  '/tims-overrides/history',
  '/api/events/world-record',
  '/api/alliances/',
  '/storylines/',
];
const RATE_EXEMPT_PATHS = new Set(['/api/health', '/api/status']);

const bucketsGeneral = new Map<string, number[]>();
const bucketsHeavy = new Map<string, number[]>();

function isHeavy(path: string): boolean {
  return HEAVY_PATTERNS.some((p) => path.includes(p));
}

function prune(map: Map<string, number[]>, key: string, cutoff: number): number[] {
  const kept = (map.get(key) ?? []).filter((t) => t > cutoff);
  if (kept.length === 0) map.delete(key);
  else map.set(key, kept);
  return kept;
}

export function registerRateLimit(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (!path.startsWith('/api/')) return;
    if (request.method === 'OPTIONS' || RATE_EXEMPT_PATHS.has(path)) return;

    const apiKey = (request.headers['x-api-key'] as string) ?? '';
    const trusted = Boolean(apiKey) && TRUSTED_API_KEYS.has(apiKey);
    if (apiKey && !trusted) {
      request.log.warn(`Unrecognized API key from ${request.ip}: ${apiKey.slice(0, 8)}…`);
    }

    const key = trusted ? `trusted:${apiKey}` : request.ip;
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    const heavy = isHeavy(path);

    const limitGeneral = trusted ? RATE_LIMIT_TRUSTED_GENERAL : RATE_LIMIT_GENERAL;
    const limitHeavy = trusted ? RATE_LIMIT_TRUSTED_HEAVY : RATE_LIMIT_HEAVY;

    // Prune both buckets (mirrors main.py:159-166).
    prune(bucketsGeneral, key, cutoff);
    prune(bucketsHeavy, key, cutoff);

    const map = heavy ? bucketsHeavy : bucketsGeneral;
    const bucket = map.get(key) ?? [];
    const limit = heavy ? limitHeavy : limitGeneral;
    const bucketName = heavy ? 'heavy' : 'general';

    if (bucket.length >= limit) {
      const retryAfter = Math.max(1, Math.trunc((bucket[0]! + RATE_WINDOW_MS - now) / 1000) + 1);
      request.log.warn(
        `Rate limit hit: client=${key} trusted=${trusted} bucket=${bucketName} ` +
          `limit=${limit} path=${path} retry_after=${retryAfter}s`,
      );
      reply
        .code(429)
        .headers({
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(retryAfter),
        })
        .send({
          detail: 'Too many requests — please slow down and try again in a moment.',
          retry_after: retryAfter,
          limit,
          bucket: bucketName,
        });
      return reply; // short-circuit — handler never runs
    }

    bucket.push(now);
    map.set(key, bucket);
    const remaining = Math.max(0, limit - bucket.length);
    const reset = Math.max(1, Math.trunc((bucket[0]! + RATE_WINDOW_MS - now) / 1000));
    reply.headers({
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String(reset),
    });
  });
}

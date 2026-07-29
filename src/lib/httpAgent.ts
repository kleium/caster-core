/**
 * Global undici dispatcher tuning.
 *
 * With FRC + FTC hot pollers (5s) and warm syncs (120s) running concurrently
 * across several active events, a single sweep can fire dozens of simultaneous
 * requests to a handful of hosts (TBA, FRC Events, FTC Events, Statbotics,
 * FTC Scout). Node's default global Agent caps connections per origin low
 * enough that this burst causes `TypeError: fetch failed` under load — a
 * failure mode httpx's connection pool doesn't hit at the same concurrency.
 *
 * Import this once, early, before any fetch() calls (server.ts does this).
 */
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(
  new Agent({
    connections: 64, // per-origin connection pool (undici default: 10)
    pipelining: 1,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
    connectTimeout: 10_000,
  }),
);

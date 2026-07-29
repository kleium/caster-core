/**
 * Fastify application — Node.js port of the FRC Caster's Tool BFF.
 * Mirrors the wiring of backend/app/main.py.
 *
 * Milestone 1 (strangler-fig): this process owns /api/health and /api/status
 * and runs the FRC match poller. Every other route is proxied unchanged to the
 * existing FastAPI backend, so clients cannot tell a migration is underway.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import httpProxy from '@fastify/http-proxy';

import './lib/httpAgent.js'; // must run before any fetch() call — see file header

import {
  FASTAPI_UPSTREAM,
  HOST,
  PORT,
  POLL_EVENTS,
  POLL_FTC_EVENTS,
  WORKERS_ENABLED,
} from './config.js';
import { registerRateLimit } from './plugins/rateLimit.js';
import { registerTimeout } from './plugins/timeout.js';
import { registerErrorEnvelope } from './plugins/errorEnvelope.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerEventRoutes } from './routes/events.js';
import { registerMatchRoutes } from './routes/matches.js';
import { registerAllianceRoutes } from './routes/alliances.js';
import { registerFtcEventRoutes } from './routes/ftcEvents.js';
import { registerFtcMatchRoutes } from './routes/ftcMatches.js';
import { registerFtcAllianceRoutes } from './routes/ftcAlliances.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerTeamWriteRoutes } from './routes/teams.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPasskeyRoutes } from './routes/passkey.js';
import { registerStorylineRoutes } from './routes/storylines.js';
import { addWatchedEvent } from './workers/pollerState.js';
import { startMatchPoller } from './workers/matchPoller.js';
import { startEventSync } from './workers/eventSync.js';
import { addWatchedFtcEvent } from './workers/ftcPollerState.js';
import { startFtcMatchPoller } from './workers/ftcMatchPoller.js';
import { startFtcEventSync } from './workers/ftcEventSync.js';

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true, // honor X-Forwarded-For so request.ip is the real client
  });

  // ── CORS (main.py:82-94): reflect origin, expose rate-limit headers ──
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    exposedHeaders: [
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
  });

  // ── Cross-cutting middleware (order mirrors main.py) ──
  registerRateLimit(app);
  registerTimeout(app);
  registerErrorEnvelope(app);

  // ── Owned routes ──
  registerSystemRoutes(app);
  registerEventRoutes(app);
  registerMatchRoutes(app);
  registerAllianceRoutes(app);
  registerFtcEventRoutes(app);
  registerFtcMatchRoutes(app);
  registerFtcAllianceRoutes(app);
  registerSyncRoutes(app);
  registerTeamWriteRoutes(app);
  registerAuthRoutes(app);
  registerPasskeyRoutes(app);
  registerStorylineRoutes(app);

  // ── Strangler-fig fallback: proxy everything else to FastAPI ──
  // Explicit static routes above take precedence over this wildcard.
  await app.register(httpProxy, {
    upstream: FASTAPI_UPSTREAM,
    // Forward the raw path unchanged (same-origin contract).
    proxyPayloads: true,
    // Exclude OPTIONS — @fastify/cors owns the wildcard preflight route, so
    // the proxy must not also claim OPTIONS on '/*' (would be a duplicate route).
    httpMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
  });

  // ── Background workers (main.py lifespan) ──
  const stoppers: Array<() => Promise<void>> = [];

  app.addHook('onReady', async () => {
    if (!WORKERS_ENABLED) {
      app.log.info('SUPABASE_URL not set (or DISABLE_WORKERS) — workers disabled');
      return;
    }
    if (POLL_EVENTS.length) {
      // Register as *watched* (not active) so event_sync's per-sweep
      // setActiveEvents() doesn't clobber the seed — watched events are unioned
      // in getActiveEvents() and survive with a 2h TTL.
      for (const ek of POLL_EVENTS) addWatchedEvent(ek);
      app.log.info(`Seeded watched events from POLL_EVENTS: ${POLL_EVENTS.join(', ')}`);
    }
    if (POLL_FTC_EVENTS.length) {
      for (const ek of POLL_FTC_EVENTS) addWatchedFtcEvent(ek);
      app.log.info(`Seeded watched FTC events from POLL_FTC_EVENTS: ${POLL_FTC_EVENTS.join(', ')}`);
    }
    // event_sync discovers ongoing events + ingests metadata/OPR/EPA/etc.;
    // match_poller polls live scores/rankings for active + watched events.
    // Same pattern on the FTC side (ftc_event_sync + ftc_match_poller).
    stoppers.push(startEventSync());
    stoppers.push(startMatchPoller());
    stoppers.push(startFtcEventSync());
    stoppers.push(startFtcMatchPoller());
    app.log.info(
      'Ingestion workers started (event-sync, match-poller, ftc-event-sync, ftc-match-poller)',
    );
  });

  app.addHook('onClose', async () => {
    if (stoppers.length) {
      await Promise.all(stoppers.map((stop) => stop()));
      app.log.info('Ingestion workers stopped');
    }
  });

  return app;
}

// ── Entrypoint ──────────────────────────────────────────────
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.ts');

if (isMain) {
  const app = await buildServer();

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`Node BFF listening on http://${HOST}:${PORT} (proxying → ${FASTAPI_UPSTREAM})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

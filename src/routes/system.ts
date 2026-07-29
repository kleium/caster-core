/**
 * System routes — /api/health and /api/status, faithful to
 * backend/app/main.py:316-380. These are the Milestone-1 "owned" routes: thin,
 * dependency-free enough to prove the Fastify stack, clients, and breakers are
 * wired correctly. Everything else proxies to FastAPI.
 */
import type { FastifyInstance } from 'fastify';

import {
  BLUE_ALLIANCE_API_KEY,
  FRC_EVENTS_API_TOKEN,
  FTC_EVENTS_API_TOKEN,
} from '../config.js';
import {
  tbaBreaker,
  frcBreaker,
  ftcBreaker,
  statboticsBreaker,
  gatoolBreaker,
} from '../lib/circuitBreaker.js';
import { probeStatus } from '../lib/http.js';
import { getSupabase } from '../services/supabase.js';
import { ApiError } from '../plugins/errorEnvelope.js';

export function registerSystemRoutes(app: FastifyInstance): void {
  // main.py:316 — {"status":"ok"}, rate-limit exempt.
  app.get('/api/health', async () => ({ status: 'ok' }));

  // main.py:321 — upstream connectivity + circuit-breaker states.
  // The probes hit the SAME effective URLs FastAPI does: its httpx clients have
  // a versioned base_url (e.g. .../v3.0) but call `.get("/")`, and httpx treats
  // a leading-"/" path as absolute — so it actually pings each host's ROOT.
  // We only check `status === 200` (no body parse), exactly like FastAPI.
  app.get('/api/status', async () => {
    const [tbaOk, frcOk, sbOk, ftcOk] = await Promise.all([
      probeStatus('https://www.thebluealliance.com/api/v3/status', {
        'X-TBA-Auth-Key': BLUE_ALLIANCE_API_KEY,
      }),
      probeStatus('https://frc-api.firstinspires.org/', {
        Authorization: `Basic ${FRC_EVENTS_API_TOKEN}`,
        Accept: 'application/json',
      }),
      probeStatus('https://api.statbotics.io/'),
      // DELIBERATE DIVERGENCE: FastAPI's probe calls `.get("/v2.0")` on an
      // httpx client whose base_url ALREADY ends in /v2.0, so it requests
      // /v2.0/v2.0 → 401 and reports `ftc: false` even when FTC is healthy.
      // Same class as the unimported-HTTPException bug the plan says not to
      // replicate; a health endpoint that lies is worse than useless during a
      // cutover, and nothing in the frontend consumes /api/status.
      probeStatus('https://ftc-api.firstinspires.org/v2.0', {
        Authorization: `Basic ${FTC_EVENTS_API_TOKEN}`,
        Accept: 'application/json',
      }),
    ]);

    return {
      tba: tbaOk,
      frc: frcOk,
      ftc: ftcOk,
      statbotics: sbOk,
      circuit_breakers: {
        tba: tbaBreaker.state,
        frc: frcBreaker.state,
        ftc: ftcBreaker.state,
        statbotics: statboticsBreaker.state,
        gatool: gatoolBreaker.state,
      },
    };
  });

  /**
   * main.py:233 — GET /live-event-status/{event_key} (Nexus live match status).
   *
   * DELIBERATE DIVERGENCE (pre-agreed in the migration plan): FastAPI raises
   * `HTTPException` here but never imports it in main.py, so a missing row
   * yields `NameError` → 500 instead of a 404. Node returns the intended
   * 404 `{detail}` rather than replicating the bug.
   */
  app.get<{ Params: { event_key: string } }>('/live-event-status/:event_key', async (req) => {
    const { event_key } = req.params;
    const { data, error } = await getSupabase()
      .from('live_event_status')
      .select('*')
      .eq('event_key', event_key)
      .maybeSingle();
    if (error) throw new ApiError(500, 'Could not load live event status.');
    if (data === null) throw new ApiError(404, `No live status for event: ${event_key}`);
    return data;
  });
}

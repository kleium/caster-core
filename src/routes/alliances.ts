/**
 * FRC alliance route — port of backend/app/routers/alliances.py.
 */
import type { FastifyInstance } from 'fastify';

import { getAlliancesWithStats } from '../services/allianceService.js';
import { raiseApiError } from '../lib/apiError.js';

interface EventKeyParams {
  event_key: string;
}

export function registerAllianceRoutes(app: FastifyInstance): void {
  // alliances.py:9 — GET /api/alliances/{event_key}
  app.get<{ Params: EventKeyParams }>('/api/alliances/:event_key', async (req) => {
    const { event_key } = req.params;
    try {
      return await getAlliancesWithStats(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load alliances for event '${event_key}'.`);
    }
  });
}

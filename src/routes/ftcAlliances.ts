/**
 * FTC alliance route — port of backend/app/routers/ftc_alliances.py.
 */
import type { FastifyInstance } from 'fastify';

import { getAlliances } from '../services/ftcEventService.js';
import { raiseApiError } from '../lib/apiError.js';

interface EventKeyParams {
  event_key: string;
}

export function registerFtcAllianceRoutes(app: FastifyInstance): void {
  // ftc_alliances.py:9 — GET /api/ftc/alliances/{event_key}
  app.get<{ Params: EventKeyParams }>('/api/ftc/alliances/:event_key', async (req) => {
    const { event_key } = req.params;
    try {
      return await getAlliances(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load FTC alliances for '${event_key}'.`);
    }
  });
}

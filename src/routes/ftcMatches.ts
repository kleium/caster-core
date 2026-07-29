/**
 * FTC match read routes — port of the corresponding handlers in
 * backend/app/routers/ftc_matches.py (mounted at /api/ftc/matches).
 */
import type { FastifyInstance } from 'fastify';

import { getAllMatches, getPlayoffMatches } from '../services/ftcMatchesService.js';
import { raiseApiError } from '../lib/apiError.js';
import { getMatchScores, getScoreBreakdown } from '../services/ftcScoresService.js';
import { ApiError } from '../plugins/errorEnvelope.js';
import { getFtcHeadToHead } from '../services/ftcHeadToHeadService.js';

interface EventKeyParams {
  event_key: string;
}

export function registerFtcMatchRoutes(app: FastifyInstance): void {
  // ftc_matches.py:31 — GET /api/ftc/matches/{event_key}/all
  app.get<{ Params: EventKeyParams }>('/api/ftc/matches/:event_key/all', async (req) => {
    const { event_key } = req.params;
    try {
      return await getAllMatches(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load FTC matches for '${event_key}'.`);
    }
  });

  // ftc_matches.py:42 — GET /api/ftc/matches/{event_key}/playoffs
  app.get<{ Params: EventKeyParams }>('/api/ftc/matches/:event_key/playoffs', async (req) => {
    const { event_key } = req.params;
    try {
      return await getPlayoffMatches(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load FTC playoff matches for '${event_key}'.`);
    }
  });

  // ftc_matches.py — GET /api/ftc/matches/{event_key}/scores
  app.get<{ Params: EventKeyParams }>('/api/ftc/matches/:event_key/scores', async (req) => {
    const { event_key } = req.params;
    try {
      return await getMatchScores(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load FTC scores for '${event_key}'.`);
    }
  });

  // ftc_matches.py — GET /api/ftc/matches/match/{event_key}/{level}/{match_number}/breakdown
  app.get<{ Params: { event_key: string; level: string; match_number: string } }>(
    '/api/ftc/matches/match/:event_key/:level/:match_number/breakdown',
    async (req) => {
      const { event_key, level } = req.params;
      const matchNumber = Number(req.params.match_number);
      if (!Number.isInteger(matchNumber)) throw new ApiError(400, 'Invalid match number');
      try {
        const result = await getScoreBreakdown(event_key, level, matchNumber);
        // Python: `if not result` — an empty/falsy payload also 404s.
        if (!result || !Object.keys(result).length) {
          throw new ApiError(404, 'Score breakdown not available.');
        }
        return result;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, 'Could not load FTC score breakdown.');
      }
    },
  );

  // ftc_matches.py — GET /api/ftc/matches/head-to-head/{team_a}/{team_b}
  app.get<{ Params: { team_a: string; team_b: string }; Querystring: { all_time?: string } }>(
    '/api/ftc/matches/head-to-head/:team_a/:team_b',
    async (req) => {
      const a = Number(req.params.team_a);
      const b = Number(req.params.team_b);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new ApiError(400, 'Invalid team numbers');
      }
      const allTime = ['true', '1'].includes((req.query.all_time ?? '').toLowerCase());
      try {
        return await getFtcHeadToHead(a, b, allTime);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load FTC head-to-head for ${a} vs ${b}.`);
      }
    },
  );
}

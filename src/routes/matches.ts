/**
 * FRC match read routes — port of the corresponding handlers in
 * backend/app/routers/matches.py (mounted at /api/matches).
 */
import type { FastifyInstance } from 'fastify';

import { getAllMatches, getPlayoffMatches } from '../services/matchesService.js';
import { getFastScores } from '../services/matchScoresService.js';
import { getMatchBreakdown } from '../services/matchBreakdownService.js';
import { getPlayoffFirsts } from '../services/playoffFirstsService.js';
import { getTeamPerformance } from '../services/teamPerfService.js';
import { raiseApiError } from '../lib/apiError.js';
import { ApiError } from '../plugins/errorEnvelope.js';

interface EventKeyParams {
  event_key: string;
}

export function registerMatchRoutes(app: FastifyInstance): void {
  // matches.py:34 — GET /api/matches/{event_key}/all
  app.get<{ Params: EventKeyParams }>('/api/matches/:event_key/all', async (req) => {
    const { event_key } = req.params;
    try {
      return await getAllMatches(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load matches for event '${event_key}'.`);
    }
  });

  // matches.py:1062 — GET /api/matches/{event_key}/playoffs
  app.get<{ Params: EventKeyParams }>('/api/matches/:event_key/playoffs', async (req) => {
    const { event_key } = req.params;
    try {
      return await getPlayoffMatches(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load playoff data for event '${event_key}'.`);
    }
  });

  // matches.py — GET /api/matches/{event_key}/scores
  app.get<{ Params: EventKeyParams }>('/api/matches/:event_key/scores', async (req) => {
    const { event_key } = req.params;
    try {
      return await getFastScores(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load scores for event '${event_key}'.`);
    }
  });

  // matches.py — GET /api/matches/match/{match_key}/breakdown
  app.get<{ Params: { match_key: string } }>(
    '/api/matches/match/:match_key/breakdown',
    async (req) => {
      const { match_key } = req.params;
      try {
        return await getMatchBreakdown(match_key);
      } catch (e) {
        raiseApiError(e, `Could not load breakdown for match '${match_key}'.`);
      }
    },
  );

  // matches.py — GET /api/matches/{event_key}/playoff-firsts
  app.get<{ Params: EventKeyParams }>('/api/matches/:event_key/playoff-firsts', async (req) => {
    const { event_key } = req.params;
    try {
      return await getPlayoffFirsts(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load playoff firsts for event '${event_key}'.`);
    }
  });

  // matches.py — GET /api/matches/team-perf/{event_key}/{team_number}
  app.get<{ Params: { event_key: string; team_number: string } }>(
    '/api/matches/team-perf/:event_key/:team_number',
    async (req) => {
      const { event_key } = req.params;
      const teamNumber = Number(req.params.team_number);
      if (!Number.isInteger(teamNumber)) throw new ApiError(400, 'Invalid team number');
      try {
        return await getTeamPerformance(event_key, teamNumber);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load team performance for '${event_key}'.`);
      }
    },
  );
}

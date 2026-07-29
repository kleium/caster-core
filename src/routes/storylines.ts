/**
 * Storylines router — AI-generated broadcast narratives. Port of
 * backend/app/routers/storylines.py.
 */
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

import {
  isAvailable,
  generateStoryline,
  generateStorylineStream,
  type StorylineParams,
} from '../services/storylineService.js';
import { raiseApiError } from '../lib/apiError.js';
import { ApiError } from '../plugins/errorEnvelope.js';

interface StorylineBody {
  mode?: unknown;
  event_key?: unknown;
  match_key?: unknown;
  team_number?: unknown;
}

function validateBody(body: StorylineBody): StorylineParams {
  const mode = body.mode;
  const eventKey = body.event_key;
  if (typeof eventKey !== 'string' || !eventKey) {
    throw new ApiError(400, 'event_key is required.');
  }
  if (mode !== 'match' && mode !== 'team') {
    throw new ApiError(400, "Mode must be 'match' or 'team'.");
  }
  const matchKey = typeof body.match_key === 'string' ? body.match_key : null;
  const teamNumber = typeof body.team_number === 'number' ? body.team_number : null;

  if (mode === 'match' && !matchKey) {
    throw new ApiError(400, 'match_key is required for match mode.');
  }
  if (mode === 'team' && !teamNumber) {
    throw new ApiError(400, 'team_number is required for team mode.');
  }

  return { mode, event_key: eventKey, match_key: matchKey, team_number: teamNumber };
}

export function registerStorylineRoutes(app: FastifyInstance): void {
  // storylines.py:20 — GET /api/storylines/status
  app.get('/api/storylines/status', async () => {
    return { available: isAvailable() };
  });

  // storylines.py:26 — POST /api/storylines/generate
  app.post<{ Body: StorylineBody }>('/api/storylines/generate', async (req) => {
    const params = validateBody(req.body ?? {});
    if (!isAvailable()) {
      throw new ApiError(503, 'AI Storylines are not available — no Anthropic API key configured.');
    }
    try {
      return await generateStoryline(params);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof RangeError) throw new ApiError(400, e.message);
      if (e instanceof Error && e.message === 'Anthropic API key not configured') {
        throw new ApiError(503, 'AI Storylines are not available — no Anthropic API key configured.');
      }
      if (e instanceof Error && e.message.startsWith('AI service error')) {
        throw new ApiError(502, e.message);
      }
      raiseApiError(e, 'Could not generate storyline.');
    }
  });

  // storylines.py:60 — POST /api/storylines/generate/stream (SSE)
  app.post<{ Body: StorylineBody }>('/api/storylines/generate/stream', async (req, reply) => {
    const params = validateBody(req.body ?? {});
    if (!isAvailable()) {
      throw new ApiError(503, 'AI Storylines are not available — no Anthropic API key configured.');
    }

    reply.header('Cache-Control', 'no-cache');
    reply.header('X-Accel-Buffering', 'no');
    reply.type('text/event-stream');
    return Readable.from(generateStorylineStream(params));
  });
}

/**
 * FTC/FRC-shared team write routes — port of the write portion of
 * backend/app/routers/teams.py (TIMS overrides + notes CRUD). The read-only
 * team_service.py endpoints (awards-summary, stats, head-to-head) are NOT
 * ported here — they stay proxied to FastAPI; Fastify's router lets these
 * explicit routes win while everything else under /api/teams still proxies.
 */
import type { FastifyInstance } from 'fastify';

import {
  getTimsOverrides,
  upsertTimsOverrides,
  getTimsOverridesHistory,
  resetTimsOverrides,
  getTeamNotes,
  createNote,
  updateNote,
  deleteNote,
  type TimsOverrideBody,
  type NoteCreateBody,
  type NoteUpdateBody,
} from '../services/teamWriteService.js';
import { getTeamStats } from '../services/teamStatsService.js';
import { getAwardsSummary, getHeadToHead } from '../services/teamLookupService.js';
import { raiseApiError } from '../lib/apiError.js';
import { ApiError } from '../plugins/errorEnvelope.js';
import { verifySessionToken } from '../lib/sessionToken.js';

interface TeamKeyParams {
  team_key: string;
}

interface NoteIdParams {
  note_id: string;
}

interface NotesQuery {
  event_key?: string;
  sort?: string;
}

function validateTimsBody(body: unknown): TimsOverrideBody {
  if (!body || typeof body !== 'object' || typeof (body as TimsOverrideBody).author_device_id !== 'string') {
    throw new ApiError(400, 'author_device_id is required.');
  }
  return body as TimsOverrideBody;
}

function validateNoteCreateBody(body: unknown): NoteCreateBody {
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as NoteCreateBody).content !== 'string' ||
    typeof (body as NoteCreateBody).author_device_id !== 'string'
  ) {
    throw new ApiError(400, 'content and author_device_id are required.');
  }
  return body as NoteCreateBody;
}

export function registerTeamWriteRoutes(app: FastifyInstance): void {
  // ── Read-only team lookups (team_service.py) ──────────────
  // Registered on this router because find-my-way allows only ONE parameter
  // name per tree node: `/api/teams/:team_key/...` already exists here, so
  // Python's `{team_number}` must reuse `:team_key` rather than introduce a
  // second name (which throws at registration time).

  // teams.py:51 — GET /api/teams/awards-summary
  app.get<{ Querystring: { teams?: string } }>('/api/teams/awards-summary', async (req) => {
    const teamsParam = req.query.teams;
    if (typeof teamsParam !== 'string') {
      throw new ApiError(400, 'Provide 1-12 team numbers');
    }
    const parts = teamsParam.split(',').map((t) => t.trim()).filter(Boolean);
    const nums: number[] = [];
    for (const p of parts) {
      // Mirrors Python int(): reject anything non-integral rather than coercing.
      if (!/^[+-]?\d+$/.test(p)) throw new ApiError(400, 'Invalid team numbers');
      nums.push(Number(p));
    }
    if (!nums.length || nums.length > 12) {
      throw new ApiError(400, 'Provide 1-12 team numbers');
    }
    try {
      return await getAwardsSummary(nums);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, 'Could not load awards summary.');
    }
  });

  // teams.py:78 — GET /api/teams/head-to-head/{team_a}/{team_b}
  app.get<{
    Params: { team_a: string; team_b: string };
    Querystring: { year?: string; all_time?: string };
  }>('/api/teams/head-to-head/:team_a/:team_b', async (req) => {
    const a = Number(req.params.team_a);
    const b = Number(req.params.team_b);
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      throw new ApiError(400, 'Invalid team numbers');
    }
    const year = req.query.year !== undefined ? Number(req.query.year) : null;
    const allTime = ['true', '1'].includes((req.query.all_time ?? '').toLowerCase());
    try {
      return await getHeadToHead(a, b, year, allTime);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, `Could not load head-to-head for teams ${a} vs ${b}.`);
    }
  });

  // teams.py:68 — GET /api/teams/{team_number}/stats
  app.get<{ Params: TeamKeyParams; Querystring: { year?: string } }>(
    '/api/teams/:team_key/stats',
    async (req) => {
      const teamNumber = Number(req.params.team_key);
      if (!Number.isInteger(teamNumber)) {
        throw new ApiError(400, 'Invalid team number');
      }
      const year = req.query.year !== undefined ? Number(req.query.year) : null;
      try {
        return await getTeamStats(teamNumber, year);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load stats for team ${teamNumber}.`);
      }
    },
  );

  // teams.py:97 — GET /api/teams/{team_key}/tims-overrides
  app.get<{ Params: TeamKeyParams }>('/api/teams/:team_key/tims-overrides', async (req) => {
    const { team_key } = req.params;
    try {
      return await getTimsOverrides(team_key);
    } catch (e) {
      raiseApiError(e, `Could not load TIMS overrides for ${team_key}.`);
    }
  });

  // teams.py:117 — PUT /api/teams/{team_key}/tims-overrides
  app.put<{ Params: TeamKeyParams; Body: unknown }>(
    '/api/teams/:team_key/tims-overrides',
    async (req) => {
      const { team_key } = req.params;
      const body = validateTimsBody(req.body);
      try {
        return await upsertTimsOverrides(team_key, body);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not save TIMS overrides for ${team_key}.`);
      }
    },
  );

  // teams.py:196 — GET /api/teams/{team_key}/tims-overrides/history
  app.get<{ Params: TeamKeyParams }>(
    '/api/teams/:team_key/tims-overrides/history',
    async (req) => {
      const { team_key } = req.params;
      try {
        return await getTimsOverridesHistory(team_key);
      } catch (e) {
        raiseApiError(e, `Could not load TIMS history for ${team_key}.`);
      }
    },
  );

  // teams.py:214 — DELETE /api/teams/{team_key}/tims-overrides
  app.delete<{ Params: TeamKeyParams }>('/api/teams/:team_key/tims-overrides', async (req) => {
    const { team_key } = req.params;
    try {
      return await resetTimsOverrides(team_key);
    } catch (e) {
      raiseApiError(e, `Could not reset TIMS overrides for ${team_key}.`);
    }
  });

  // teams.py:235 — GET /api/teams/{team_key}/notes
  app.get<{ Params: TeamKeyParams; Querystring: NotesQuery }>(
    '/api/teams/:team_key/notes',
    async (req) => {
      const { team_key } = req.params;
      const sortParam = req.query.sort;
      const sort: 'asc' | 'desc' = sortParam === 'asc' ? 'asc' : 'desc';
      if (sortParam !== undefined && sortParam !== 'asc' && sortParam !== 'desc') {
        throw new ApiError(400, "sort must be 'asc' or 'desc'.");
      }
      try {
        return await getTeamNotes(team_key, req.query.event_key, sort);
      } catch (e) {
        raiseApiError(e, `Could not load notes for ${team_key}.`);
      }
    },
  );

  // teams.py:264 — POST /api/teams/notes
  app.post<{ Body: unknown }>('/api/teams/notes', async (req, reply) => {
    const body = validateNoteCreateBody(req.body);
    try {
      const result = await createNote(body, verifySessionToken(req.headers.authorization));
      reply.code(201);
      return result;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, 'Could not create note.');
    }
  });

  // teams.py:286 — PUT /api/teams/notes/{note_id}
  app.put<{ Params: NoteIdParams; Body: unknown }>(
    '/api/teams/notes/:note_id',
    async (req) => {
      const { note_id } = req.params;
      const body = (req.body ?? {}) as NoteUpdateBody;
      try {
        return await updateNote(note_id, body);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, 'Could not update note.');
      }
    },
  );

  // teams.py:310 — DELETE /api/teams/notes/{note_id}
  app.delete<{ Params: NoteIdParams }>('/api/teams/notes/:note_id', async (req) => {
    const { note_id } = req.params;
    try {
      return await deleteNote(note_id);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, 'Could not delete note.');
    }
  });
}

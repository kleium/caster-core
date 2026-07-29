/**
 * POST /api/sync — port of backend/app/routers/sync.py.
 */
import type { FastifyInstance } from 'fastify';

import { runSync, type PendingEdit } from '../services/syncService.js';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from '../config.js';
import { ApiError } from '../plugins/errorEnvelope.js';

interface SyncBody {
  event_key?: unknown;
  last_sync?: unknown;
  pending_edits?: unknown;
}

function validateBody(body: SyncBody): { event_key: string; last_sync: string | null; pending_edits: PendingEdit[] } {
  const eventKey = body.event_key;
  if (typeof eventKey !== 'string' || eventKey.length < 3 || eventKey.length > 32) {
    throw new ApiError(400, 'event_key is required and must be 3-32 characters.');
  }

  const lastSync = body.last_sync;
  if (lastSync !== undefined && lastSync !== null && typeof lastSync !== 'string') {
    throw new ApiError(400, 'last_sync must be a string or null.');
  }

  const rawEdits = body.pending_edits;
  const pendingEdits: PendingEdit[] = [];
  if (rawEdits !== undefined) {
    if (!Array.isArray(rawEdits)) {
      throw new ApiError(400, 'pending_edits must be a list.');
    }
    for (const e of rawEdits) {
      if (
        !e ||
        typeof e !== 'object' ||
        (e.table !== 'notes' && e.table !== 'tims_overrides') ||
        typeof e.row !== 'object' ||
        e.row === null
      ) {
        throw new ApiError(400, "pending_edits entries must have table in ('notes','tims_overrides') and a row object.");
      }
      pendingEdits.push({ table: e.table, row: e.row as Record<string, unknown> });
    }
  }

  return { event_key: eventKey, last_sync: (lastSync as string | null) ?? null, pending_edits: pendingEdits };
}

export function registerSyncRoutes(app: FastifyInstance): void {
  // sync.py:194 — POST /api/sync
  app.post<{ Body: SyncBody }>('/api/sync', async (req) => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new ApiError(503, 'Sync service unavailable — Supabase not configured');
    }

    const parsed = validateBody(req.body ?? {});

    try {
      return await runSync(parsed);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      console.error(`Delta fetch failed for ${parsed.event_key}: ${String(e)}`);
      throw new ApiError(500, 'Sync delta fetch failed');
    }
  });
}

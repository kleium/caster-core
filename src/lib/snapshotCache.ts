/**
 * Shared disk cache for full-event snapshot payloads — the read/write/TTL
 * mechanics behind both `snapshotService.ts` (FRC) and `ftcSnapshotService.ts`
 * (FTC). Both competition types write the same `snap_{event_key}.json` file
 * naming scheme in the same CACHE_DIR that FastAPI uses (event keys never
 * collide between FRC `2026xxx` and FTC `2025ftcxxx`), so this one module is
 * the single source of truth for that disk format — mirrors
 * backend/app/routers/snapshot.py's `_read_snapshot`/`_write_snapshot`,
 * shared as-is by its own FRC and FTC route handlers.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CACHE_DIR } from './cachePaths.js';

type Obj = Record<string, any>;

const SNAPSHOT_TTL = 1800; // seconds — 30 min, serve from cache (snapshot.py:38)
const SNAPSHOT_STALE = 7200; // seconds — 2 hr, serve stale while rebuilding (snapshot.py:39)

function snapshotPath(eventKey: string): string {
  return path.join(CACHE_DIR, `snap_${eventKey}.json`);
}

/** Invalidate a cached snapshot (called by workers when data changes). snapshot.py:50. */
export async function invalidateSnapshot(eventKey: string): Promise<void> {
  try {
    await fs.unlink(snapshotPath(eventKey));
  } catch {
    /* already absent */
  }
}

export interface SnapshotReadResult {
  data: Obj | null;
  fresh: boolean;
}

/** Read snapshot from disk. snapshot.py:57. */
export async function readSnapshot(eventKey: string): Promise<SnapshotReadResult> {
  try {
    const raw = JSON.parse(await fs.readFile(snapshotPath(eventKey), 'utf-8')) as Obj;
    const age = Date.now() / 1000 - (raw._ts ?? 0);
    if (age <= SNAPSHOT_TTL) return { data: raw, fresh: true };
    if (age <= SNAPSHOT_STALE) return { data: raw, fresh: false };
    return { data: null, fresh: false };
  } catch {
    return { data: null, fresh: false };
  }
}

/** Write snapshot to disk. snapshot.py:79. */
export async function writeSnapshot(eventKey: string, payload: Obj): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  payload._ts = Date.now() / 1000;
  await fs.writeFile(snapshotPath(eventKey), JSON.stringify(payload), 'utf-8');
}

/**
 * Filesystem locations for runtime cache and bundled static data.
 *
 * This service is self-contained: everything it reads or writes lives inside
 * the package. (It previously reached three levels up into the monorepo for
 * `data/saved_events` and `docs/data/*.json` — that only worked while the Node
 * backend lived beside the FastAPI one and the web app.)
 *
 * Both locations are env-overridable, which matters on Render: the default
 * filesystem is ephemeral, so `CACHE_DIR` should point at a mounted disk if you
 * want the payload cache to survive deploys. It is only a cache — losing it
 * costs a rebuild on first request, never correctness.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// this file: <pkg>/src/lib/paths.ts → package root is three up.
// After `tsc` it is <pkg>/dist/lib/paths.js → still three up. Same either way.
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..');

/** Writable disk cache for payloads (snapshots, summaries, connections, avatars). */
export const CACHE_DIR = process.env.CACHE_DIR
  ? path.resolve(process.env.CACHE_DIR)
  : path.join(packageRoot, 'data', 'saved_events');

/** Read-only static data bundled with the service. */
export const STATIC_DATA_DIR = process.env.STATIC_DATA_DIR
  ? path.resolve(process.env.STATIC_DATA_DIR)
  : path.join(packageRoot, 'data', 'static');

export const REGION_STATS_PATH = path.join(STATIC_DATA_DIR, 'region_stats.json');
export const EINSTEIN_HISTORY_PATH = path.join(STATIC_DATA_DIR, 'einstein_history.json');

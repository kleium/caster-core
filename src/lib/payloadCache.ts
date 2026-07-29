/**
 * Disk-backed cache for expensive computed payloads — port of
 * backend/app/services/payload_cache.py.
 *
 * Stores JSON files in CACHE_DIR (shared with the FastAPI backend) with a
 * configurable TTL. Each entry carries a `_ts` timestamp; reads check age
 * against the supplied TTL.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CACHE_DIR } from './cachePaths.js';

function filePath(prefix: string, key: string): string {
  return path.join(CACHE_DIR, `${prefix}_${key}.json`);
}

/** Return cached payload if fresh (age <= ttlSeconds), else null. */
export async function readPayload(
  prefix: string,
  key: string,
  ttlSeconds: number,
): Promise<Record<string, unknown> | null> {
  try {
    const data = JSON.parse(await fs.readFile(filePath(prefix, key), 'utf-8')) as Record<
      string,
      unknown
    >;
    const age = Date.now() / 1000 - ((data._ts as number) ?? 0);
    if (age <= ttlSeconds) return data;
  } catch {
    /* absent or malformed */
  }
  return null;
}

/** Return cached payload regardless of age (stale-read fallback). */
export async function readStale(prefix: string, key: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath(prefix, key), 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Write payload to disk with the current timestamp (mutates in place, like the Python original). */
export async function writePayload(
  prefix: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  payload._ts = Date.now() / 1000;
  await fs.writeFile(filePath(prefix, key), JSON.stringify(payload), 'utf-8');
}

/** Delete a cached payload. */
export async function invalidate(prefix: string, key: string): Promise<void> {
  try {
    await fs.unlink(filePath(prefix, key));
  } catch {
    /* already absent */
  }
}

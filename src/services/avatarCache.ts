/**
 * Team avatar cache — port of backend/app/services/avatar_cache.py.
 *
 * Avatars are cached per-year in a single JSON file on disk (shared with the
 * FastAPI backend). Missing avatars are fetched from TBA (with an FRC Events
 * API fallback) in parallel, then persisted.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CACHE_DIR } from '../lib/cachePaths.js';
import { getTbaClient } from './tbaClient.js';
import { getFrcClient } from './frcClient.js';

const FETCH_CONCURRENCY = 12;

function cachePath(year: number): string {
  return path.join(CACHE_DIR, `avatars_${year}.json`);
}

async function loadCache(year: number): Promise<Record<string, string | null>> {
  try {
    const raw = await fs.readFile(cachePath(year), 'utf-8');
    return JSON.parse(raw) as Record<string, string | null>;
  } catch {
    return {};
  }
}

async function saveCache(year: number, data: Record<string, string | null>): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath(year), JSON.stringify(data), 'utf-8');
}

/** Run `tasks` with a bounded concurrency (Semaphore analogue). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface TbaMediaItem {
  type?: string;
  details?: { base64Image?: string };
}

async function fetchOne(teamKey: string, year: number): Promise<[string, string | null]> {
  const tba = getTbaClient();
  let media: TbaMediaItem[];
  try {
    media = await tba.getTeamMedia<TbaMediaItem[]>(teamKey, year);
  } catch {
    return [teamKey, null];
  }
  for (const item of media ?? []) {
    if (item.type === 'avatar') {
      const b64 = item.details?.base64Image;
      if (b64) return [teamKey, `data:image/png;base64,${b64}`];
    }
  }
  return [teamKey, null];
}

/** FRC Events API fallback for teams TBA didn't cover (avatar_cache.py:63). */
async function fetchFrcAvatars(teamKeys: string[], year: number): Promise<Record<string, string>> {
  const frc = getFrcClient();
  const result: Record<string, string> = {};
  for (const tk of teamKeys) {
    const num = tk.replace('frc', '');
    try {
      const data = await frc.get<{ teams?: { encodedAvatar?: string }[] }>(
        `/${year}/avatars?teamNumber=${num}`,
      );
      const b64 = data.teams?.[0]?.encodedAvatar;
      if (b64) result[tk] = `data:image/png;base64,${b64}`;
    } catch {
      /* skip */
    }
  }
  return result;
}

/**
 * Return `{ team_key: data_uri }` for teams that have an avatar. Reads disk
 * cache first; missing keys are fetched in parallel and the cache updated.
 * avatar_cache.py:86.
 */
export async function getAvatars(
  teamKeys: string[],
  year: number,
): Promise<Record<string, string>> {
  if (teamKeys.length === 0) return {};

  const cache = await loadCache(year);
  const result: Record<string, string> = {};
  const missing: string[] = [];
  for (const tk of teamKeys) {
    if (tk in cache) {
      const v = cache[tk];
      if (v) result[tk] = v;
    } else {
      missing.push(tk);
    }
  }
  if (missing.length === 0) return result;

  const fetched = await mapLimit(missing, FETCH_CONCURRENCY, (tk) => fetchOne(tk, year));
  for (const [tk, uri] of fetched) {
    cache[tk] = uri; // persist even null ("no avatar")
    if (uri) result[tk] = uri;
  }

  // FRC Events API fallback for teams TBA didn't have.
  const stillMissing = missing.filter((tk) => cache[tk] == null);
  if (stillMissing.length) {
    const frcFound = await fetchFrcAvatars(stillMissing, year);
    for (const [tk, uri] of Object.entries(frcFound)) {
      cache[tk] = uri;
      result[tk] = uri;
    }
  }

  await saveCache(year, cache);
  return result;
}

/**
 * Avatars already in the disk cache (no network I/O) — avatar_cache.py:134.
 * (Async here because Node file reads are async; the Python original is sync.)
 */
export async function getAvatarsFromCache(
  teamKeys: string[],
  year: number,
): Promise<Record<string, string>> {
  if (teamKeys.length === 0) return {};
  const cache = await loadCache(year);
  const out: Record<string, string> = {};
  for (const tk of teamKeys) {
    const v = cache[tk];
    if (v) out[tk] = v;
  }
  return out;
}

/** Pre-warm the avatar cache (fire-and-forget) — avatar_cache.py:147. */
export async function prefetchAvatars(teamKeys: string[], year: number): Promise<void> {
  await getAvatars(teamKeys, year);
}

/**
 * Season-wide world high score — full port of
 * backend/app/services/world_record_service.py.
 *
 * The record is held in memory (resets on restart) and mirrored to a disk file
 * shared with the FastAPI backend (world_record_<year>.json in CACHE_DIR), so
 * both stay converged. `seedFromTba` does a one-time (per process lifetime)
 * active scan of every started TBA event for the season to find the true
 * global high, since `checkEventHigh` alone only sees events the UI happens
 * to load.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { CACHE_DIR } from '../lib/cachePaths.js';
import { getTbaClient } from './tbaClient.js';
import { Semaphore } from '../lib/semaphore.js';

const CURRENT_YEAR = 2026;

export interface WorldRecord {
  score: number;
  event_key: string;
  event_name: string;
  match: string;
  teams: number[];
  updated_at: number;
}

let _worldRecord: WorldRecord | null = null;

function diskPath(): string {
  return path.join(CACHE_DIR, `world_record_${CURRENT_YEAR}.json`);
}

async function loadFromDisk(): Promise<boolean> {
  try {
    const data = JSON.parse(await fs.readFile(diskPath(), 'utf-8')) as WorldRecord;
    if ((data.score ?? 0) > 0) {
      _worldRecord = data;
      return true;
    }
  } catch {
    /* absent or malformed */
  }
  return false;
}

async function saveToDisk(): Promise<void> {
  if (!_worldRecord) return;
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(diskPath(), JSON.stringify(_worldRecord), 'utf-8');
}

export interface EventHigh {
  score: number;
  match?: string;
  teams?: number[];
}

/**
 * Compare an event's high score to the world record; returns true if a new
 * record was set (and persists it). world_record_service.py:74.
 */
export async function checkEventHigh(
  eventKey: string,
  eventName: string,
  high: EventHigh | null | undefined,
): Promise<boolean> {
  if (!high || (high.score ?? 0) <= 0) return false;
  if (_worldRecord === null) await loadFromDisk();
  if (_worldRecord && high.score <= _worldRecord.score) return false;
  _worldRecord = {
    score: high.score,
    event_key: eventKey,
    event_name: eventName,
    match: high.match ?? '',
    teams: high.teams ?? [],
    updated_at: Date.now() / 1000,
  };
  await saveToDisk();
  return true;
}

/** Return the current world record (may be null if not yet seeded). world_record_service.py:69. */
export function getWorldRecord(): WorldRecord | null {
  return _worldRecord;
}

// ── seed_from_tba (world_record_service.py:100) ───────────────
const SEED_CONCURRENCY = 6;
let _seeded = false;
let _seedPromise: Promise<void> | null = null;

/** Convert a TBA match key like '2026tuis_qm42' to 'Qualification 42'. world_record_service.py:222. */
function matchLabelFromKey(key: string): string {
  if (!key.includes('_')) return key;
  const suffix = key.split('_').slice(1).join('_');
  const m = /^(qm|ef|qf|sf|f)(\d+)(?:m(\d+))?/.exec(suffix);
  if (!m) return suffix;
  const level = m[1]!;
  const num1 = Number(m[2]);
  const num2 = m[3] ? Number(m[3]) : undefined;
  const labels: Record<string, string> = {
    qm: 'Qualification', ef: 'Eighths', qf: 'Quarterfinal', sf: 'Semifinal', f: 'Final',
  };
  const label = labels[level] ?? level;
  if (level === 'qm' || level === 'f') return `${label} ${num1}`;
  if (num2 && num2 > 1) return `${label} ${num1} (Match ${num2})`;
  return `${label} ${num1}`;
}

/**
 * Scan all started TBA events for the season and find the global high.
 * Runs the full TBA scan at most ONCE per process lifetime (idempotent for
 * subsequent calls). Loads the disk cache first so the caller gets a fast
 * initial value even while the scan is in flight.
 */
export async function seedFromTba(): Promise<void> {
  if (_seeded) return;
  if (_seedPromise) return _seedPromise;

  _seedPromise = (async () => {
    if (_worldRecord === null) await loadFromDisk();
    _seeded = true;

    try {
      const tba = getTbaClient();
      const events = await tba.getEventsByYear<Record<string, any>[]>(CURRENT_YEAR);
      if (!events || events.length === 0) return;

      // Events that have actually started (real competition types, start_date <= today).
      const todayStr = new Date().toISOString().slice(0, 10);
      const started = events.filter((ev) => {
        const etype = ev.event_type ?? 99;
        if (etype > 5) return false;
        const startDate = ev.start_date ?? '';
        if (!startDate) return false;
        return startDate <= todayStr;
      });
      if (started.length === 0) return;

      const sem = new Semaphore(SEED_CONCURRENCY);
      let bestScore = 0;
      let bestMatchKey = '';
      let bestColor = '';
      let bestEvent: Record<string, any> | null = null;
      let bestAlliances: Record<string, any> | null = null;

      const scanResults = await Promise.allSettled(
        started.map((ev) =>
          sem.run(async () => {
            const matches = await tba.getEventMatches<Record<string, any>[]>(ev.key as string);
            let top = 0;
            let topKey = '';
            let topColor = '';
            let topAlliances: Record<string, any> = {};
            for (const m of matches ?? []) {
              const alliances = m.alliances ?? {};
              for (const color of ['red', 'blue'] as const) {
                const s = (alliances[color] ?? {}).score ?? -1;
                if (s > top) {
                  top = s;
                  topKey = m.key ?? '';
                  topColor = color;
                  topAlliances = alliances;
                }
              }
            }
            return { score: top, matchKey: topKey, color: topColor, ev, alliances: topAlliances };
          }),
        ),
      );

      for (const r of scanResults) {
        if (r.status !== 'fulfilled') continue;
        const { score, matchKey, color, ev, alliances } = r.value;
        if (score > bestScore) {
          bestScore = score;
          bestMatchKey = matchKey;
          bestColor = color;
          bestEvent = ev;
          bestAlliances = alliances;
        }
      }

      if (bestScore > 0 && bestEvent && bestAlliances) {
        const eventKey = bestEvent.key as string;
        const eventName = (bestEvent.short_name || bestEvent.name || eventKey) as string;
        const matchLabel = matchLabelFromKey(bestMatchKey);

        const teamKeys = (bestAlliances[bestColor] ?? {}).team_keys ?? [];
        const teamNums: number[] = [];
        for (const tk of teamKeys) {
          const n = Number(String(tk).replace('frc', ''));
          if (Number.isFinite(n)) teamNums.push(n);
        }

        await checkEventHigh(eventKey, eventName, {
          score: bestScore,
          match: matchLabel,
          teams: teamNums,
        });
      }
    } catch {
      /* non-critical — seeding failure shouldn't break the endpoint */
    }
  })();

  return _seedPromise;
}

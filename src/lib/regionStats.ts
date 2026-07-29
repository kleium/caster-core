/**
 * Static region facts loader — port of the `_load_region_stats` /
 * `_ensure_award_lookups` pieces of region_service.py + summary_service.py.
 *
 * Loads the bundled region_stats.json (pre-generated, checked into this repo
 * under data/static/) once and caches it in memory; flattens Hall-of-Fame /
 * Impact-finalist entries into lookups keyed by team_number.
 */
import { promises as fs } from 'node:fs';

import { REGION_STATS_PATH } from './paths.js';

interface RegionEntry {
  team_number: number;
  years?: number[];
  [key: string]: unknown;
}

interface RegionStats {
  hof_teams?: RegionEntry[];
  impact_finalists?: RegionEntry[];
  [key: string]: unknown;
}

let _regionStats: Record<string, RegionStats> | null = null;

export async function loadRegionStats(): Promise<Record<string, RegionStats>> {
  if (_regionStats !== null) return _regionStats;
  try {
    _regionStats = JSON.parse(await fs.readFile(REGION_STATS_PATH, 'utf-8')) as Record<
      string,
      RegionStats
    >;
  } catch {
    _regionStats = {};
  }
  return _regionStats;
}

export async function getRegionFacts(regionName: string): Promise<RegionStats | null> {
  const stats = await loadRegionStats();
  return stats[regionName] ?? null;
}

export async function listRegions(): Promise<string[]> {
  const stats = await loadRegionStats();
  return Object.keys(stats).sort();
}

let _hofByNum: Map<number, RegionEntry> | null = null;
let _impactByNum: Map<number, RegionEntry> | null = null;

/** Flatten region_stats.json into HoF / Impact-finalist lookups keyed by team_number. */
export async function ensureAwardLookups(): Promise<{
  hofByNum: Map<number, RegionEntry>;
  impactByNum: Map<number, RegionEntry>;
}> {
  if (_hofByNum && _impactByNum) return { hofByNum: _hofByNum, impactByNum: _impactByNum };

  _hofByNum = new Map();
  _impactByNum = new Map();
  const stats = await loadRegionStats();

  for (const data of Object.values(stats)) {
    for (const entry of data.hof_teams ?? []) {
      const num = entry.team_number;
      const existing = _hofByNum.get(num);
      if (!existing) {
        _hofByNum.set(num, { ...entry, years: [...(entry.years ?? [])] });
      } else {
        existing.years = [...new Set([...(existing.years ?? []), ...(entry.years ?? [])])].sort(
          (a, b) => a - b,
        );
      }
    }
    for (const entry of data.impact_finalists ?? []) {
      const num = entry.team_number;
      const existing = _impactByNum.get(num);
      if (!existing) {
        _impactByNum.set(num, { ...entry, years: [...(entry.years ?? [])] });
      } else {
        existing.years = [...new Set([...(existing.years ?? []), ...(entry.years ?? [])])].sort(
          (a, b) => a - b,
        );
      }
    }
  }

  return { hofByNum: _hofByNum, impactByNum: _impactByNum };
}

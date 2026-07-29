/**
 * Static Einstein (Championship Finals) history lookup — port of
 * `_ensure_einstein_lookup` in summary_service.py.
 *
 * Loads the bundled data/static/einstein_history.json once, keyed by team number.
 */
import { promises as fs } from 'node:fs';

import { EINSTEIN_HISTORY_PATH } from './paths.js';

export interface EinsteinEntry {
  nickname?: string;
  contender_years?: number[];
  winner_years?: number[];
}

let _einsteinByNum: Map<number, EinsteinEntry> | null = null;

export async function ensureEinsteinLookup(): Promise<Map<number, EinsteinEntry>> {
  if (_einsteinByNum !== null) return _einsteinByNum;
  _einsteinByNum = new Map();
  try {
    const raw = JSON.parse(await fs.readFile(EINSTEIN_HISTORY_PATH, 'utf-8')) as Record<
      string,
      EinsteinEntry
    >;
    for (const [teamStr, data] of Object.entries(raw)) {
      const num = Number(teamStr);
      if (Number.isFinite(num)) _einsteinByNum.set(num, data);
    }
  } catch {
    /* file missing — empty lookup */
  }
  return _einsteinByNum;
}

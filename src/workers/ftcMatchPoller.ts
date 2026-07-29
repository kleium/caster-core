/**
 * Hot-path FTC worker — port of backend/app/workers/ftc_match_poller.py.
 *
 * Polls the FIRST FTC Events API every 5s for live match scores (via the
 * hybrid qual+playoff schedule endpoints, so upcoming matches appear as soon
 * as the schedule is published) and every 15s for rankings, upserting changed
 * rows into Supabase. Mirrors the FRC match_poller architecture exactly,
 * except FTC has no TBA-offseason routing branch and its match_key includes
 * a `series` component (`{event_key}_{comp_level}{series}m{match_num}`).
 */
import { CircuitOpenError } from '../lib/circuitBreaker.js';
import { deleteOrphanedMatches, mergeEventTeams, upsertRows, type MergeRow } from '../services/supabase.js';
import { getFtcClient } from '../services/ftcClient.js';
import { FTCMatch, FTCRanking, validateList } from './schemas.js';
import { getFtcPollEvents } from './ftcPollerState.js';
import * as payloadCache from '../lib/payloadCache.js';
import { parseFtcKey } from '../lib/ftcKey.js';

const POLL_INTERVAL_MS = 5_000; // between match sweeps (ftc_match_poller.py:21)
const RANKINGS_INTERVAL_MS = 15_000; // between ranking refreshes (ftc_match_poller.py:22)

let _lastRankingsPoll = 0;

function stripNulls(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** Invalidate the disk-cached summary payload so it rebuilds (ftc_match_poller.py:30). */
function invalidateSnapshot(eventKey: string): void {
  void payloadCache.invalidate('summary', eventKey).catch(() => undefined);
}

// ── Match polling ────────────────────────────────────────────
/** Exported for reuse by ftcIngestionService's one-shot initial match poll. */
export async function pollFtcMatches(eventKey: string): Promise<void> {
  const client = getFtcClient();
  const [year, eventCode] = parseFtcKey(eventKey);

  let qualMatches: Record<string, unknown>[];
  let playoffMatches: Record<string, unknown>[];
  try {
    const results = await Promise.allSettled([
      client.getScheduleHybrid(year, eventCode, 'qual', { bypassCache: true }),
      client.getScheduleHybrid(year, eventCode, 'playoff', { bypassCache: true }),
    ]);
    const [qualResult, playoffResult] = results;

    if (qualResult!.status === 'rejected' && qualResult!.reason instanceof CircuitOpenError) return;
    if (playoffResult!.status === 'rejected' && playoffResult!.reason instanceof CircuitOpenError) return;

    qualMatches = qualResult!.status === 'fulfilled' ? qualResult!.value : [];
    if (qualResult!.status === 'rejected') {
      console.warn(`FTC qual schedule fetch failed for ${eventKey}: ${String(qualResult!.reason)}`);
    }
    playoffMatches = playoffResult!.status === 'fulfilled' ? playoffResult!.value : [];
    if (playoffResult!.status === 'rejected') {
      console.warn(`FTC playoff schedule fetch failed for ${eventKey}: ${String(playoffResult!.reason)}`);
    }
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`FTC match poll failed for ${eventKey}: ${String(err)}`);
    return;
  }

  const rawMatches = [...(qualMatches ?? []), ...(playoffMatches ?? [])];
  if (rawMatches.length === 0) return;

  const valid = validateList(FTCMatch, rawMatches, `ftc_matches:${eventKey}`);
  if (valid.length === 0) return;

  const rows: Record<string, unknown>[] = [];
  for (const m of valid) {
    const matchNum = m.matchNumber ?? 0;
    const series = m.series ?? 1;
    const level = (m.tournamentLevel ?? 'Qualification').toLowerCase();

    // Skip practice/scrimmage matches — no competition value.
    if (level.includes('practice') || level.includes('scrimmage')) continue;

    let compLevel: string;
    if (level.includes('qual')) compLevel = 'qm';
    else if (level.includes('playoff') || level.includes('elim')) compLevel = 'sf';
    else if (level.includes('final')) compLevel = 'f';
    else compLevel = level ? level.slice(0, 2) : 'qm';

    const matchKey = `${eventKey}_${compLevel}${series}m${matchNum}`;

    const scoreRed = (m.scoreRedFinal ?? m.scoreTotalRed) as number | null;
    const scoreBlue = (m.scoreBlueFinal ?? m.scoreTotalBlue) as number | null;
    let status: string;
    if (scoreRed != null && scoreRed >= 0 && scoreBlue != null && scoreBlue >= 0) status = 'completed';
    else if (m.actualStartTime) status = 'in_progress';
    else status = 'upcoming';

    const teamsList = m.teams ?? [];
    const redKeys = teamsList
      .filter((t) => (t.station ?? '').startsWith('Red') && t.teamNumber)
      .map((t) => `ftc${t.teamNumber}`)
      .sort();
    const blueKeys = teamsList
      .filter((t) => (t.station ?? '').startsWith('Blue') && t.teamNumber)
      .map((t) => `ftc${t.teamNumber}`)
      .sort();

    const alliances = {
      red: { score: scoreRed ?? -1, teams: teamsList, team_keys: redKeys },
      blue: { score: scoreBlue ?? -1, teams: teamsList, team_keys: blueKeys },
    };

    const raw = m as Record<string, unknown>;
    const scheduled = raw['startTime'] ?? raw['actualStartTime'] ?? null;

    rows.push({
      match_key: matchKey,
      event_key: eventKey,
      comp_level: compLevel,
      match_number: matchNum,
      set_number: series,
      status,
      alliances,
      score_breakdown: raw['scoreBreakdown'] ?? {},
      scheduled_time: scheduled,
      raw_data: raw,
    });
  }

  if (rows.length === 0) return;

  try {
    await upsertRows('matches', rows);
    const validKeys = new Set(rows.map((r) => r['match_key'] as string));
    const orphanCount = await deleteOrphanedMatches(eventKey, validKeys);
    if (orphanCount) console.info(`Purged ${orphanCount} ghost FTC matches from ${eventKey}`);
    invalidateSnapshot(eventKey);
  } catch (err) {
    console.warn(`Supabase FTC match upsert failed for ${eventKey}: ${String(err)}`);
  }
}

// ── Rankings polling ─────────────────────────────────────────
async function pollFtcRankings(eventKey: string): Promise<void> {
  const client = getFtcClient();
  const [year, eventCode] = parseFtcKey(eventKey);

  let rankings: Record<string, unknown>[];
  try {
    rankings = await client.getRankings(year, eventCode);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`FTC rankings poll failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (rankings.length === 0) return;

  const valid = validateList(FTCRanking, rankings, `ftc_rankings:${eventKey}`);
  if (valid.length === 0) return;

  const rows: MergeRow[] = [];
  for (const r of valid) {
    const num = r.teamNumber;
    if (!num) continue;
    rows.push({
      event_key: eventKey,
      team_key: `ftc${num}`,
      data: stripNulls({
        rank: r.rank,
        wins: r.wins ?? 0,
        losses: r.losses ?? 0,
        ties: r.ties ?? 0,
        qual_average: r.qualAverage,
        sort_orders: r.sortOrders,
        matches_played: r.matchesPlayed ?? 0,
        dq: r.dq ?? 0,
      }),
    });
  }

  if (rows.length) {
    try {
      await mergeEventTeams(rows);
      invalidateSnapshot(eventKey);
    } catch (err) {
      console.warn(`Supabase FTC rankings merge failed for ${eventKey}: ${String(err)}`);
    }
  }
}

// ── Main loop ───────────────────────────────────────────────
let _running = false;
let _wakeup: (() => void) | null = null;

function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _wakeup = null;
      resolve();
    }, ms);
    _wakeup = () => {
      clearTimeout(timer);
      _wakeup = null;
      resolve();
    };
  });
}

async function loop(): Promise<void> {
  console.info(
    `FTC match poller started (interval=${POLL_INTERVAL_MS / 1000}s, ` +
      `rankings=${RANKINGS_INTERVAL_MS / 1000}s)`,
  );

  while (_running) {
    try {
      const events = [...getFtcPollEvents()];
      if (events.length) {
        const n = events.length;
        const stagger = n > 1 ? POLL_INTERVAL_MS / n : 0;
        await Promise.allSettled(
          events.map(async (ek, i) => {
            if (stagger) await new Promise((r) => setTimeout(r, i * stagger));
            await pollFtcMatches(ek);
          }),
        );

        const now = Date.now();
        if (now - _lastRankingsPoll >= RANKINGS_INTERVAL_MS) {
          _lastRankingsPoll = now;
          for (const ek of events) {
            try {
              await pollFtcRankings(ek);
            } catch (err) {
              console.warn(`FTC rankings poll failed for ${ek}: ${String(err)}`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`FTC match poller sweep error: ${String(err)}`);
    }

    if (_running) await interruptibleSleep(POLL_INTERVAL_MS);
  }
  console.info('FTC match poller stopped');
}

/** Start the FTC poller. Returns a stop function (cancel + drain). */
export function startFtcMatchPoller(): () => Promise<void> {
  if (_running) return stopFtcMatchPoller;
  _running = true;
  const done = loop();
  return async () => {
    await stopFtcMatchPoller();
    await done;
  };
}

async function stopFtcMatchPoller(): Promise<void> {
  _running = false;
  if (_wakeup) _wakeup();
}

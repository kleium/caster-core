/**
 * Hot-path worker — port of backend/app/workers/match_poller.py.
 *
 * Polls the FRC Events API every 5s for live match scores and rankings, then
 * upserts changed rows into Supabase. Only active + user-watched events are
 * polled. Offseason events (TBA event_type 99) are never in the FRC Events API,
 * so they are polled via TBA instead.
 *
 * The row shapes written to `matches` and `event_teams` are byte-for-byte
 * identical to the Python worker — Supabase Realtime pushes these to the
 * browser directly, so any drift would break the live UI contract.
 */
import { CircuitOpenError } from '../lib/circuitBreaker.js';
import {
  deleteOrphanedMatches,
  mergeEventTeams,
  upsertRows,
  type MergeRow,
} from '../services/supabase.js';
import { getFrcClient } from '../services/frcClient.js';
import { getTbaClient } from '../services/tbaClient.js';
import { FRCMatch, FRCRanking, validateList } from './schemas.js';
import { getActiveEvents, isOffseason } from './pollerState.js';
import * as payloadCache from '../lib/payloadCache.js';

const POLL_INTERVAL_MS = 5_000; // between sweeps (match_poller.py:21)
const RANKINGS_INTERVAL_MS = 15_000; // between ranking refreshes (match_poller.py:22)
const ORPHAN_SWEEP_INTERVAL_MS = 300_000; // ghost-match purge per event (match_poller.py:23)

let _lastRankingsPoll = 0;
const _lastOrphanSweep = new Map<string, number>(); // event_key → last purge ms

/** Remove keys whose value is null/undefined so JSONB || won't nuke good data (match_poller.py:32). */
function stripNulls(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/** Invalidate the disk-cached summary payload so it rebuilds (match_poller.py:37). */
function invalidateSnapshot(eventKey: string): void {
  void payloadCache.invalidate('summary', eventKey).catch(() => undefined);
}

// ── FRC-API match poll ──────────────────────────────────────
async function pollMatches(eventKey: string): Promise<void> {
  if (isOffseason(eventKey)) {
    await pollMatchesTba(eventKey);
    return;
  }

  const frc = getFrcClient();
  const year = Number(eventKey.slice(0, 4));
  const eventCode = eventKey.slice(4);

  let raw: Record<string, unknown>[];
  try {
    raw = await frc.getMatches(year, eventCode, { bypassCache: true });
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`Match poll failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (raw.length === 0) return;

  const valid = validateList(FRCMatch, raw, `frc_matches:${eventKey}`);
  if (valid.length === 0) return;

  const rows: Record<string, unknown>[] = [];
  for (const m of valid) {
    const matchNum = m.matchNumber ?? 0;
    const level = (m.tournamentLevel ?? 'Qualification').toLowerCase();

    // FRC's own API stopped reporting separate Quarterfinal/Semifinal/Final
    // tournamentLevel values for 2023+ events — everything playoff is just
    // "Playoff", with the actual round embedded in `description` ("Match 5
    // (R2)", "Final 1", "Final Tiebreaker"). The old three-way string match
    // below predates that change: it bucketed every 2023+ playoff match into
    // 'sf' and never produced 'f' at all, AND built match keys without the
    // "m{n}" suffix TBA-sourced ingestion uses (`sf5m1`, not `sf5`) — so the
    // hot poller's rows lived in a different key space than the correct ones,
    // making every correctly-keyed row look orphaned and get purged. Confirmed
    // against a live event's raw FRC API response and cross-checked against
    // TBA's own comp_level for the same matches — this mapping is exact for
    // the 2023+ unified double-elim bracket (matches 1-13 → 'sf', set = the
    // match's own sequential number; "Final N" → 'f', set 1).
    let compLevel: string;
    let setNumber: number;
    let withinSetNum: number;
    if (level === 'playoff') {
      const desc = String(m.description ?? '').trim();
      if (/^final/i.test(desc)) {
        compLevel = 'f';
        setNumber = 1;
        const digits = desc.match(/(\d+)/);
        withinSetNum = digits ? Number(digits[1]) : 3; // "Final Tiebreaker" has no digit — it's game 3
      } else {
        compLevel = 'sf';
        setNumber = matchNum;
        withinSetNum = 1;
      }
    } else {
      // Legacy pre-2023 events (distinct Quarterfinal/Semifinal/Final levels).
      // Unverified against live data — no legacy event is realistically still
      // being hot-polled — kept as a fallback rather than guessed at further.
      if (level.includes('qual')) compLevel = 'qm';
      else if (level.includes('elim')) compLevel = 'sf';
      else if (level.includes('final')) compLevel = 'f';
      else compLevel = level.slice(0, 2);
      setNumber = (m as unknown as Record<string, unknown>)['playNumber'] as number | undefined ?? 1;
      withinSetNum = matchNum;
    }

    // TBA's own key scheme, which the rest of the app (ingestion, reads,
    // Realtime subscribers) all key off: qm has no set component; everything
    // else is `{level}{set}m{withinSet}`.
    const matchKey =
      compLevel === 'qm' ? `${eventKey}_qm${matchNum}` : `${eventKey}_${compLevel}${setNumber}m${withinSetNum}`;

    const scoreRed = m.scoreRedFinal as number | null | undefined;
    const scoreBlue = m.scoreBlueFinal as number | null | undefined;
    let status: string;
    if (scoreRed !== null && scoreRed !== undefined && scoreRed >= 0) status = 'completed';
    else if (m.actualStartTime) status = 'in_progress';
    else status = 'upcoming';

    const frcTeams = m.teams ?? [];
    const redKeys = frcTeams
      .filter((t) => (t.station ?? '').includes('Red'))
      .map((t) => `frc${t.teamNumber}`)
      .sort();
    const blueKeys = frcTeams
      .filter((t) => (t.station ?? '').includes('Blue'))
      .map((t) => `frc${t.teamNumber}`)
      .sort();

    const alliances = {
      red: {
        score: scoreRed !== null && scoreRed !== undefined ? scoreRed : -1,
        teams: frcTeams,
        team_keys: redKeys,
      },
      blue: {
        score: scoreBlue !== null && scoreBlue !== undefined ? scoreBlue : -1,
        teams: frcTeams,
        team_keys: blueKeys,
      },
    };

    const raw_m = m as Record<string, unknown>;
    const scheduled = raw_m['startTime'] ?? raw_m['actualStartTime'] ?? null;

    rows.push({
      match_key: matchKey,
      event_key: eventKey,
      comp_level: compLevel,
      match_number: withinSetNum,
      set_number: setNumber,
      status,
      alliances,
      score_breakdown: raw_m['scoreBreakdown'] ?? {},
      scheduled_time: scheduled,
      raw_data: raw_m,
    });
  }

  if (rows.length) await upsertMatchRows(eventKey, rows);
}

async function upsertMatchRows(
  eventKey: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  try {
    await upsertRows('matches', rows);
    // Purge ghost matches, throttled to once per ORPHAN_SWEEP_INTERVAL per event.
    const now = Date.now();
    const last = _lastOrphanSweep.get(eventKey) ?? 0;
    if (now - last >= ORPHAN_SWEEP_INTERVAL_MS) {
      _lastOrphanSweep.set(eventKey, now);
      const validKeys = new Set(rows.map((r) => r['match_key'] as string));
      const orphanCount = await deleteOrphanedMatches(eventKey, validKeys);
      if (orphanCount) console.info(`Purged ${orphanCount} ghost matches from ${eventKey}`);
    }
    invalidateSnapshot(eventKey);
  } catch (err) {
    console.warn(`Supabase match upsert failed for ${eventKey}: ${String(err)}`);
  }
}

// ── TBA match poll (offseason events) ───────────────────────
async function pollMatchesTba(eventKey: string): Promise<void> {
  const tba = getTbaClient();
  let raw: Record<string, unknown>[];
  try {
    raw = await tba.getEventMatches<Record<string, unknown>[]>(eventKey);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`TBA match poll failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (!Array.isArray(raw) || raw.length === 0) return;

  const rows: Record<string, unknown>[] = [];
  for (const m of raw) {
    const matchKey = (m['key'] as string) ?? '';
    if (!matchKey) continue;

    const alliancesRaw = (m['alliances'] as Record<string, any>) ?? {};
    const red = alliancesRaw.red ?? {};
    const blue = alliancesRaw.blue ?? {};
    const rs = red.score as number | null | undefined;
    const bs = blue.score as number | null | undefined;

    let status: string;
    if (rs != null && rs >= 0 && bs != null && bs >= 0) status = 'completed';
    else if (m['actual_time']) status = 'in_progress';
    else status = 'upcoming';

    const rawTime = (m['time'] ?? m['predicted_time']) as number | null | undefined;
    let scheduled: string | null = null;
    if (rawTime != null && typeof rawTime === 'number') {
      scheduled = new Date(rawTime * 1000).toISOString();
    }

    rows.push({
      match_key: matchKey,
      event_key: eventKey,
      comp_level: m['comp_level'] ?? 'qm',
      match_number: m['match_number'] ?? 0,
      set_number: m['set_number'] ?? 1,
      status,
      alliances: {
        red: { score: rs != null ? rs : -1, team_keys: red.team_keys ?? [] },
        blue: { score: bs != null ? bs : -1, team_keys: blue.team_keys ?? [] },
      },
      score_breakdown: m['score_breakdown'] ?? {},
      scheduled_time: scheduled,
      raw_data: m,
    });
  }

  if (rows.length) await upsertMatchRows(eventKey, rows);
}

// ── Rankings ────────────────────────────────────────────────
async function pollRankings(eventKey: string): Promise<void> {
  if (isOffseason(eventKey)) {
    await pollRankingsTba(eventKey);
    return;
  }

  const frc = getFrcClient();
  const year = Number(eventKey.slice(0, 4));
  const eventCode = eventKey.slice(4);

  let rankings: Record<string, unknown>[];
  try {
    rankings = await frc.getRankings(year, eventCode);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`Rankings poll failed for ${eventKey}: ${String(err)}`);
    return;
  }
  if (rankings.length === 0) return;

  const valid = validateList(FRCRanking, rankings, `frc_rankings:${eventKey}`);
  if (valid.length === 0) return;

  const rows: MergeRow[] = [];
  for (const r of valid) {
    const teamNum = r.teamNumber;
    if (!teamNum) continue;
    const teamKey = `frc${teamNum}`;

    // FRC Events API returns sortOrder1..6 as individual fields rather than a
    // single sortOrders array; build the array from whichever form is present
    // (match_poller.py:324-335).
    let sortOrders: unknown[] | null = r.sortOrders ?? null;
    if (!sortOrders) {
      const raw = r as Record<string, unknown>;
      const so: unknown[] = [];
      for (let i = 1; i <= 6; i += 1) {
        const v = raw[`sortOrder${i}`];
        if (v !== null && v !== undefined) so.push(v);
      }
      sortOrders = so.length ? so : null;
    }

    rows.push({
      event_key: eventKey,
      team_key: teamKey,
      data: stripNulls({
        rank: r.rank,
        wins: r.wins ?? 0,
        losses: r.losses ?? 0,
        ties: r.ties ?? 0,
        qual_average: r.qualAverage,
        sort_orders: sortOrders,
        matches_played: r.matchesPlayed ?? 0,
        dq: r.dq ?? 0,
      }),
    });
  }

  if (rows.length) await mergeRankingRows(eventKey, rows);
}

async function pollRankingsTba(eventKey: string): Promise<void> {
  const tba = getTbaClient();
  let raw: { rankings?: Record<string, any>[] };
  try {
    raw = await tba.getEventRankings<{ rankings?: Record<string, any>[] }>(eventKey);
  } catch (err) {
    if (err instanceof CircuitOpenError) return;
    console.warn(`TBA rankings poll failed for ${eventKey}: ${String(err)}`);
    return;
  }
  const rankings = raw?.rankings ?? [];
  if (rankings.length === 0) return;

  const rows: MergeRow[] = [];
  for (const r of rankings) {
    const teamKey = r.team_key as string | undefined;
    if (!teamKey) continue;
    const record = r.record ?? {};
    rows.push({
      event_key: eventKey,
      team_key: teamKey,
      data: stripNulls({
        rank: r.rank,
        wins: record.wins ?? 0,
        losses: record.losses ?? 0,
        ties: record.ties ?? 0,
        qual_average: r.qual_average,
        sort_orders: r.sort_orders ?? null,
        matches_played: r.matches_played ?? 0,
        dq: r.dq ?? 0,
      }),
    });
  }

  if (rows.length) await mergeRankingRows(eventKey, rows);
}

async function mergeRankingRows(eventKey: string, rows: MergeRow[]): Promise<void> {
  try {
    await mergeEventTeams(rows);
    invalidateSnapshot(eventKey);
  } catch (err) {
    console.warn(`Supabase rankings upsert failed for ${eventKey}: ${String(err)}`);
  }
}

// ── Main loop ───────────────────────────────────────────────
let _running = false;
let _wakeup: (() => void) | null = null;

/** Sleep for `ms`, but resolve early if the worker is asked to stop. */
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
    `Match poller started (interval=${POLL_INTERVAL_MS / 1000}s, ` +
      `rankings=${RANKINGS_INTERVAL_MS / 1000}s)`,
  );

  while (_running) {
    try {
      const events = [...getActiveEvents()];
      if (events.length) {
        // Stagger polls across the interval window to avoid request bursts
        // when many events are active simultaneously (match_poller.py:421-428).
        const n = events.length;
        const stagger = n > 1 ? POLL_INTERVAL_MS / n : 0;
        await Promise.allSettled(
          events.map(async (ek, i) => {
            if (stagger) await new Promise((r) => setTimeout(r, i * stagger));
            await pollMatches(ek);
          }),
        );

        // Poll rankings less frequently (serialised to avoid deadlocks).
        const now = Date.now();
        if (now - _lastRankingsPoll >= RANKINGS_INTERVAL_MS) {
          _lastRankingsPoll = now;
          for (const ek of events) {
            try {
              await pollRankings(ek);
            } catch (err) {
              console.warn(`Rankings poll failed for ${ek}: ${String(err)}`);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Match poller sweep error: ${String(err)}`);
    }

    if (_running) await interruptibleSleep(POLL_INTERVAL_MS);
  }
  console.info('Match poller stopped');
}

/** Start the poller. Returns a stop function (cancel + drain) for shutdown. */
export function startMatchPoller(): () => Promise<void> {
  if (_running) return stopMatchPoller;
  _running = true;
  const done = loop();
  return async () => {
    await stopMatchPoller();
    await done;
  };
}

async function stopMatchPoller(): Promise<void> {
  _running = false;
  if (_wakeup) _wakeup(); // interrupt the sleep so shutdown is prompt
}

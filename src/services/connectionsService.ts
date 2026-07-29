/**
 * Prior playoff connections (partnerships + head-to-head history) between
 * teams at an event — port of get_event_connections / get_match_connections /
 * _find_playoff_connections from backend/app/services/summary_service.py.
 */
import { getTbaClient } from './tbaClient.js';
import { getCachedSummary, setCachedSummary } from './supabase.js';
import * as payloadCache from '../lib/payloadCache.js';
import { Semaphore } from '../lib/semaphore.js';

type Obj = Record<string, any>;

const API_SEMAPHORE = new Semaphore(10);
const CONNECTIONS_TTL = 3600; // seconds (summary_service.py:20)

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await API_SEMAPHORE.run(fn);
  } catch {
    return null;
  }
}

// ── Double-elim + comp-level labels (verbatim from summary_service.py:1400-1417) ──
const COMP_LEVEL_LABELS: Record<string, string> = {
  qm: 'Quals', ef: 'Eighths', qf: 'Quarters', sf: 'Semi-Finals', f: 'Finals',
};
const DOUBLE_ELIM_MAP: Record<number, [number, string]> = {
  1: [1, 'Upper'], 2: [1, 'Upper'], 3: [1, 'Upper'], 4: [1, 'Upper'],
  5: [2, 'Lower'], 6: [2, 'Lower'], 7: [2, 'Upper'], 8: [2, 'Upper'],
  9: [3, 'Lower'], 10: [3, 'Lower'],
  11: [4, 'Upper'], 12: [4, 'Lower'],
  13: [5, 'Lower'],
};
const DOUBLE_ELIM_ROUND_LABELS: Record<number, string> = {
  1: 'Round 1', 2: 'Round 2', 3: 'Round 3', 4: 'Semis', 5: 'Semis',
};
const COMP_LEVEL_ORDER: Record<string, number> = { ef: 1, qf: 2, sf: 3, f: 4 };

// ── _resolve_de_stage (summary_service.py:1419) ───────────────
function resolveDeStage(match: Obj): [number, string] {
  const cl = (match.comp_level ?? 'qm') as string;
  if (cl === 'f') return [10, 'Finals'];
  const sn = (match.set_number ?? 0) as number;
  if (cl === 'sf' && sn in DOUBLE_ELIM_MAP) {
    const [rnd, bracket] = DOUBLE_ELIM_MAP[sn]!;
    const label = DOUBLE_ELIM_ROUND_LABELS[rnd] ?? `Round ${rnd}`;
    return [rnd, `${label} (${bracket})`];
  }
  const order = COMP_LEVEL_ORDER[cl] ?? 0;
  return [order, COMP_LEVEL_LABELS[cl] ?? cl];
}

// ── get_event_connections (summary_service.py:1434) ───────────
function hasH2h(conns: Obj[]): boolean {
  for (const c of conns) {
    if (c.opponents_at && (c.opponents_at as unknown[]).length) return 'h2h_wins_a' in c;
  }
  return true; // no opponent pairs → nothing to check
}

export async function getEventConnections(eventKey: string, allTime = false): Promise<Obj[]> {
  const cacheKey = allTime ? `${eventKey}_all` : eventKey;

  // 1) Disk cache.
  const cached = await payloadCache.readPayload('connections', cacheKey, CONNECTIONS_TTL);
  if (cached) {
    const conns = (cached.connections ?? []) as Obj[];
    if (hasH2h(conns)) {
      if (!allTime) maybeWarmAlltimeConnections(eventKey);
      return conns;
    }
    await payloadCache.invalidate('connections', cacheKey);
  }

  // 2) Supabase cache.
  const sbKey = `conn_${cacheKey}`;
  const sbRow = await getCachedSummary(sbKey);
  if (sbRow && sbRow.summary) {
    const conns = ((sbRow.summary as Obj).connections ?? []) as Obj[];
    if (hasH2h(conns)) {
      await payloadCache.writePayload('connections', cacheKey, sbRow.summary as Obj);
      if (!allTime) maybeWarmAlltimeConnections(eventKey);
      return conns;
    }
    // stale Supabase entry — fall through to rebuild
  }

  // 3) Build from scratch.
  const client = getTbaClient();
  const year = Number(eventKey.slice(0, 4));
  const teams = await client.getEventTeamsFull<Obj[]>(eventKey);
  if (!teams || teams.length === 0) return [];

  const lookback = allTime ? null : 3;
  const result = await findPlayoffConnections(teams, eventKey, year, lookback);

  const payload = { connections: result };
  await payloadCache.writePayload('connections', cacheKey, payload);
  if (result.length) {
    await setCachedSummary(sbKey, payload, undefined);
  }

  if (!allTime) maybeWarmAlltimeConnections(eventKey);

  return result;
}

// ── background all-time warming (summary_service.py:1490-1512) ─
const alltimeWarmTasks = new Set<string>();

function maybeWarmAlltimeConnections(eventKey: string): void {
  const allKey = `${eventKey}_all`;
  if (alltimeWarmTasks.has(allKey)) return;
  // Fire-and-forget: check disk cache first (async), then build if still needed.
  void (async () => {
    const cached = await payloadCache.readPayload('connections', allKey, CONNECTIONS_TTL);
    if (cached) return;
    if (alltimeWarmTasks.has(allKey)) return;
    alltimeWarmTasks.add(allKey);
    try {
      await getEventConnections(eventKey, true);
    } catch {
      /* non-critical background warm */
    } finally {
      alltimeWarmTasks.delete(allKey);
    }
  })();
}

// ── get_match_connections (summary_service.py:1515) ───────────
export async function getMatchConnections(
  eventKey: string,
  teamNumbers: number[],
  allTime = false,
): Promise<Obj[]> {
  const allConns = await getEventConnections(eventKey, allTime);
  if (!allConns.length) return [];
  const teamSet = new Set(teamNumbers);
  return allConns.filter((c) => teamSet.has(c.team_a) && teamSet.has(c.team_b));
}

// ── _find_playoff_connections (summary_service.py:1531) ────────
async function findPlayoffConnections(
  teams: Obj[],
  eventKey: string,
  year: number,
  lookbackYears: number | null,
): Promise<Obj[]> {
  const client = getTbaClient();
  const teamKeys = teams.map((t) => t.key as string);
  const nameMap: Record<string, string> = {};
  for (const t of teams) nameMap[t.key as string] = t.nickname ?? '';

  let checkYears: number[];
  if (lookbackYears !== null) {
    const start = Math.max(2015, year - lookbackYears);
    checkYears = Array.from({ length: year - start + 1 }, (_, i) => start + i);
  } else {
    const rookieYears = teams.filter((t) => t.rookie_year).map((t) => t.rookie_year as number);
    const earliest = rookieYears.length ? Math.min(...rookieYears) : 2015;
    const start = Math.max(2000, earliest);
    checkYears = Array.from({ length: year - start + 1 }, (_, i) => start + i);
  }
  if (checkYears.length === 0) return [];

  // Fetch each team's events for every check year.
  const tasks: Array<{ tk: string; y: number; promise: Promise<Obj[] | null> }> = [];
  for (const tk of teamKeys) {
    for (const y of checkYears) {
      tasks.push({ tk, y, promise: safe(() => client.getTeamEvents<Obj[]>(tk, y)) });
    }
  }
  const results = await Promise.all(
    tasks.map(async (t) => ({ tk: t.tk, y: t.y, events: (await t.promise) ?? [] })),
  );

  const SKIP_EVENT_TYPES = new Set([99, 100, -1]);
  const teamEvents: Record<string, Set<string>> = {};
  const eventNameMap: Record<string, string> = {};
  for (const { tk, events } of results) {
    (teamEvents[tk] ??= new Set());
    for (const ev of events) {
      const ek = ev.key as string;
      if (SKIP_EVENT_TYPES.has(ev.event_type ?? -1)) continue;
      if (ek !== eventKey) teamEvents[tk]!.add(ek);
      if (!(ek in eventNameMap)) eventNameMap[ek] = ev.short_name || ev.name || ek;
    }
  }

  // Find pairs with common events.
  const commonEventsToFetch = new Set<string>();
  const pairCommon: Array<{ ta: string; tb: string; common: Set<string> }> = [];
  for (let i = 0; i < teamKeys.length; i += 1) {
    for (let j = i + 1; j < teamKeys.length; j += 1) {
      const ta = teamKeys[i]!;
      const tb = teamKeys[j]!;
      const common = new Set(
        [...(teamEvents[ta] ?? [])].filter((ek) => teamEvents[tb]?.has(ek)),
      );
      if (common.size) {
        pairCommon.push({ ta, tb, common });
        for (const ek of common) commonEventsToFetch.add(ek);
      }
    }
  }
  if (commonEventsToFetch.size === 0) return [];

  // Fetch alliances + matches for those events.
  const ekList = [...commonEventsToFetch];
  const [allianceResults, matchResults] = await Promise.all([
    Promise.all(ekList.map((ek) => safe(() => client.getEventAlliances<Obj[]>(ek)))),
    Promise.all(ekList.map((ek) => safe(() => client.getEventMatches<Obj[]>(ek)))),
  ]);
  const allianceCache: Record<string, Obj[]> = {};
  const matchCache: Record<string, Obj[]> = {};
  ekList.forEach((ek, i) => {
    if (allianceResults[i]) allianceCache[ek] = allianceResults[i]!;
    if (matchResults[i]) matchCache[ek] = matchResults[i]!;
  });

  function stageRank(stage: string): number {
    const STATIC: Record<string, number> = {
      Alliance: 0, Playoffs: 0, Eighths: 1, Quarters: 2, 'Semi-Finals': 3, Semis: 3, Finals: 4,
    };
    if (stage in STATIC) return STATIC[stage]!;
    if (stage.startsWith('Round ')) {
      const tok = stage.split(/\s+/)[1] ?? '';
      return /^\d/.test(tok) ? parseInt(tok.replace(/\)$/, ''), 10) : 3;
    }
    if (stage.startsWith('Semis')) return 3;
    return 0;
  }

  function dedupByEvent(events: Obj[]): Obj[] {
    const best: Record<string, Obj> = {};
    for (const e of events) {
      const ek = e.event_key as string;
      if (!(ek in best) || stageRank(e.stage) > stageRank(best[ek]!.stage)) best[ek] = e;
    }
    return Object.values(best).sort((a, b) => b.year - a.year);
  }

  const connections: Obj[] = [];
  const seenPairs = new Set<string>();

  for (const { ta, tb, common } of pairCommon) {
    const pairId = `${ta}+${tb}`;
    if (seenPairs.has(pairId)) continue;

    const partnerEvents: Obj[] = [];
    const opponentEvents: Obj[] = [];

    for (const ek of common) {
      const eventYear = Number(ek.slice(0, 4));

      // Partnership check — highest playoff stage reached together.
      let werePartners = false;
      let allianceResult: string | null = null;
      for (const al of allianceCache[ek] ?? []) {
        const picks = (al.picks ?? []) as string[];
        if (picks.includes(ta) && picks.includes(tb)) {
          werePartners = true;
          const status = al.status ?? {};
          if (status && typeof status === 'object') {
            const s = status.status ?? '';
            if (s === 'won') allianceResult = 'winner';
            else if (status.level === 'f') allianceResult = 'finalist';
          }
          break;
        }
      }

      if (werePartners) {
        let partnerHighestLabel: string | null = null;
        let partnerHighestOrder = -1;
        const isDe = eventYear >= 2023;
        for (const m of matchCache[ek] ?? []) {
          const cl = (m.comp_level ?? 'qm') as string;
          if (cl === 'qm') continue;
          const red = (m.alliances?.red?.team_keys ?? []) as string[];
          const blue = (m.alliances?.blue?.team_keys ?? []) as string[];
          if ((red.includes(ta) && red.includes(tb)) || (blue.includes(ta) && blue.includes(tb))) {
            let order: number;
            let label: string;
            if (isDe) {
              [order, label] = resolveDeStage(m);
            } else {
              order = COMP_LEVEL_ORDER[cl] ?? 0;
              label = COMP_LEVEL_LABELS[cl] ?? cl;
            }
            if (order > partnerHighestOrder) {
              partnerHighestOrder = order;
              partnerHighestLabel = label;
            }
          }
        }
        partnerEvents.push({
          event_key: ek,
          event_name: eventNameMap[ek] ?? ek,
          year: eventYear,
          stage: partnerHighestLabel || 'Alliance',
          result: allianceResult,
        });
      }

      // Playoff opponents — highest comp_level + H2H wins.
      let highestLabel: string | null = null;
      let highestOrder = -1;
      let h2hAWins = 0;
      let h2hBWins = 0;
      const isDe2 = eventYear >= 2023;
      for (const m of matchCache[ek] ?? []) {
        const cl = (m.comp_level ?? 'qm') as string;
        if (cl === 'qm') continue;
        const red = (m.alliances?.red?.team_keys ?? []) as string[];
        const blue = (m.alliances?.blue?.team_keys ?? []) as string[];
        const winner = (m.winning_alliance ?? '') as string;
        if ((red.includes(ta) && blue.includes(tb)) || (blue.includes(ta) && red.includes(tb))) {
          let order: number;
          let label: string;
          if (isDe2) {
            [order, label] = resolveDeStage(m);
          } else {
            order = COMP_LEVEL_ORDER[cl] ?? 0;
            label = COMP_LEVEL_LABELS[cl] ?? cl;
          }
          if (order > highestOrder) {
            highestOrder = order;
            highestLabel = label;
          }
          if (red.includes(ta) && blue.includes(tb)) {
            if (winner === 'red') h2hAWins += 1;
            else if (winner === 'blue') h2hBWins += 1;
          } else if (blue.includes(ta) && red.includes(tb)) {
            if (winner === 'blue') h2hAWins += 1;
            else if (winner === 'red') h2hBWins += 1;
          }
        }
      }

      if (highestLabel) {
        opponentEvents.push({
          event_key: ek,
          event_name: eventNameMap[ek] ?? ek,
          year: eventYear,
          stage: highestLabel,
          team_a_wins: h2hAWins,
          team_b_wins: h2hBWins,
        });
      }
    }

    if (partnerEvents.length || opponentEvents.length) {
      seenPairs.add(pairId);

      const dedupedOpponents = dedupByEvent(opponentEvents);
      const h2hWinsA = dedupedOpponents.reduce((s, e) => s + (e.team_a_wins ?? 0), 0);
      const h2hWinsB = dedupedOpponents.reduce((s, e) => s + (e.team_b_wins ?? 0), 0);
      connections.push({
        team_a: Number(ta.replace('frc', '')),
        team_a_name: nameMap[ta] ?? '',
        team_b: Number(tb.replace('frc', '')),
        team_b_name: nameMap[tb] ?? '',
        partnered_at: dedupByEvent(partnerEvents),
        opponents_at: dedupedOpponents,
        h2h_wins_a: h2hWinsA,
        h2h_wins_b: h2hWinsB,
      });
    }
  }

  connections.sort(
    (a, b) =>
      (b.partnered_at.length + b.opponents_at.length) - (a.partnered_at.length + a.opponents_at.length),
  );
  return connections;
}

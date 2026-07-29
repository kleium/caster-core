/**
 * Prior playoff connections between FTC teams at an event — port of
 * `get_ftc_event_connections` / `get_ftc_match_connections` /
 * `_build_ftc_connections` / `_maybe_warm_ftc_alltime` in
 * backend/app/services/ftc_event_service.py.
 *
 * 3-tier cache-aside: disk payload cache → Supabase summary cache → build.
 */
import { getFtcClient } from './ftcClient.js';
import { parseFtcBracketLabel } from './ftcMatchesService.js';
import { getCachedSummary, setCachedSummary } from './supabase.js';
import * as payloadCache from '../lib/payloadCache.js';
import { Semaphore } from '../lib/semaphore.js';
import { parseFtcKey } from '../lib/ftcKey.js';
import { pyGet, pyOr, pyTruthy } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

const CONNECTIONS_TTL = 3600; // seconds — 1 hour disk cache
const FTC_FIRST_SEASON = 2019;

const alltimeWarmTasks = new Set<string>();

/** True when the cached list already carries H2H win data (older entries don't). */
function hasH2h(conns: Obj[]): boolean {
  for (const c of conns) {
    if (pyTruthy(c.opponents_at)) return 'h2h_wins_a' in c;
  }
  return true; // no opponent pairs → nothing to check
}

/** Kick off a background all-time build if it isn't cached yet. */
function maybeWarmAlltime(eventKey: string): void {
  const allKey = `${eventKey}_all`;
  if (alltimeWarmTasks.has(allKey)) return;
  void (async () => {
    const cached = await payloadCache.readPayload('connections', allKey, CONNECTIONS_TTL);
    if (cached) return;
    alltimeWarmTasks.add(allKey);
    try {
      await getFtcEventConnections(eventKey, true);
    } catch {
      /* best-effort warm */
    }
  })();
}

/** 3-tier cache-aside entry point. ftc_event_service.py:get_ftc_event_connections. */
export async function getFtcEventConnections(
  eventKey: string,
  allTime = false,
  lookback = 3,
): Promise<Obj[]> {
  const cacheKey = allTime ? `${eventKey}_all` : eventKey;

  // 1) Disk cache
  const cached = await payloadCache.readPayload('connections', cacheKey, CONNECTIONS_TTL);
  if (cached) {
    const conns = (pyGet(cached, 'connections', []) ?? []) as Obj[];
    if (hasH2h(conns)) {
      delete (cached as Obj)._ts;
      if (!allTime) maybeWarmAlltime(eventKey);
      return conns;
    }
    // Pre-H2H entry — drop it so we rebuild with H2H data.
    await payloadCache.invalidate('connections', cacheKey);
  }

  // 2) Supabase cache
  const sbKey = `conn_${cacheKey}`;
  const sbRow = await getCachedSummary(sbKey);
  if (sbRow && pyTruthy(sbRow.summary)) {
    const summary = sbRow.summary as Obj;
    const conns = (pyGet(summary, 'connections', []) ?? []) as Obj[];
    if (hasH2h(conns)) {
      await payloadCache.writePayload('connections', cacheKey, summary);
      if (!allTime) maybeWarmAlltime(eventKey);
      return conns;
    }
    // Stale Supabase entry — fall through and rebuild.
  }

  // 3) Build
  const result = await buildFtcConnections(eventKey, allTime, lookback);
  const payload = { connections: result };
  await payloadCache.writePayload('connections', cacheKey, payload);
  if (pyTruthy(result)) await setCachedSummary(sbKey, payload);

  if (!allTime) maybeWarmAlltime(eventKey);
  return result;
}

/** Filter full-event connections to the teams on the field. */
export async function getFtcMatchConnections(
  eventKey: string,
  teamNumbers: number[],
  allTime = false,
): Promise<Obj[]> {
  const allConns = await getFtcEventConnections(eventKey, allTime);
  if (!allConns.length) return [];
  const teamSet = new Set(teamNumbers);
  return allConns.filter((c) => teamSet.has(c.team_a) && teamSet.has(c.team_b));
}

/** Stage ordering used for per-event dedup. ftc_event_service.py:_stage_rank. */
function stageRank(stage: string): number {
  const s = stage.toLowerCase();
  if (s.includes('final')) return 4;
  if (s.includes('semi')) return 3;
  if (s.includes('round')) {
    // Python: `int(stage.split()[1])`, guarded by IndexError/ValueError → 1.
    const parts = stage.split(/\s+/);
    if (parts.length > 1 && /^[+-]?\d+$/.test(parts[1]!)) return Number(parts[1]);
    return 1;
  }
  return 0;
}

function dedup(events: Obj[]): Obj[] {
  const best = new Map<string, Obj>();
  for (let e of events) {
    const ek = e.event_key as string;
    const prev = best.get(ek);
    if (!prev || stageRank(e.stage as string) > stageRank(prev.stage as string)) {
      if (prev && 'team_a_wins' in e) {
        e = { ...e };
        e.team_a_wins = (e.team_a_wins as number) + ((prev.team_a_wins as number) ?? 0);
        e.team_b_wins = (e.team_b_wins as number) + ((prev.team_b_wins as number) ?? 0);
      }
      best.set(ek, e);
    }
  }
  // Python `sorted(..., reverse=True)` is stable, as is Array.prototype.sort.
  return [...best.values()].sort((a, b) => (b.year as number) - (a.year as number));
}

/** Team numbers on each alliance side of a raw FTC match. */
function sideTeams(m: Obj, side: 'Red' | 'Blue'): number[] {
  return ((pyGet(m, 'teams', []) ?? []) as Obj[])
    .filter((t) => String(pyGet(t, 'station', '')).startsWith(side))
    .map((t) => t.teamNumber);
}

/** Full connections build. ftc_event_service.py:_build_ftc_connections. */
async function buildFtcConnections(
  eventKey: string,
  allTime: boolean,
  lookback: number,
): Promise<Obj[]> {
  const client = getFtcClient();
  const [year, eventCode] = parseFtcKey(eventKey);

  const teams = await client.getEventTeams(year, eventCode);
  if (!teams || !teams.length) return [];

  const teamNumbers = teams.map((t) => t.teamNumber as number);
  const nameMap = new Map<number, string>();
  for (const t of teams) {
    nameMap.set(t.teamNumber as number, pyOr(t.nameShort, pyGet(t, 'nameFull', '')) as string);
  }

  const checkYears: number[] = [];
  const startYear = allTime ? FTC_FIRST_SEASON : Math.max(FTC_FIRST_SEASON, year - lookback + 1);
  for (let y = startYear; y <= year; y += 1) checkYears.push(y);

  const sem = new Semaphore(8);
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> =>
    sem.run(async () => {
      try {
        return await fn();
      } catch {
        return null;
      }
    });

  // 2) Each team's events per season, keyed "season:code".
  const teamEvents = new Map<number, Set<string>>();
  for (const n of teamNumbers) teamEvents.set(n, new Set());
  const eventNameMap = new Map<string, string>();

  const tasks: Promise<[number, number, Obj[]]>[] = [];
  for (const num of teamNumbers) {
    for (const s of checkYears) {
      tasks.push(
        (async () => {
          const evts = await safe(() => client.getTeamEvents(s, num));
          return [num, s, (evts ?? []) as Obj[]] as [number, number, Obj[]];
        })(),
      );
    }
  }
  const fetched = await Promise.all(tasks);
  for (const [num, s, evts] of fetched) {
    for (const ev of evts) {
      const code = pyGet(ev, 'code', '') as string;
      if (!code) continue;
      // Skip the current event itself.
      if (s === year && code.toUpperCase() === eventCode.toUpperCase()) continue;
      teamEvents.get(num)!.add(`${s}:${code}`);
      const key = `${s}:${code}`;
      if (!eventNameMap.has(key)) eventNameMap.set(key, pyGet(ev, 'name', code) as string);
    }
  }

  // 3) Team pairs sharing common events.
  const pairCommon = new Map<string, { ta: number; tb: number; common: string[] }>();
  const eventsToFetch = new Set<string>();
  for (let i = 0; i < teamNumbers.length; i += 1) {
    for (let j = i + 1; j < teamNumbers.length; j += 1) {
      const ta = teamNumbers[i]!;
      const tb = teamNumbers[j]!;
      const setB = teamEvents.get(tb)!;
      const common = [...teamEvents.get(ta)!].filter((k) => setB.has(k));
      if (common.length) {
        pairCommon.set(`${ta}:${tb}`, { ta, tb, common });
        for (const k of common) eventsToFetch.add(k);
      }
    }
  }
  if (!eventsToFetch.size) return [];

  // 4) Alliances + playoff matches for each common event.
  const fetchList = [...eventsToFetch];
  const split = (k: string): [number, string] => {
    const idx = k.indexOf(':');
    return [Number(k.slice(0, idx)), k.slice(idx + 1)];
  };

  const [allianceResults, matchResults] = await Promise.all([
    Promise.all(
      fetchList.map(async (k) => {
        const [s, c] = split(k);
        return [k, await safe(() => client.getAlliances(s, c))] as const;
      }),
    ),
    Promise.all(
      fetchList.map(async (k) => {
        const [s, c] = split(k);
        return [k, await safe(() => client.getMatches(s, c, { level: 'playoff' }))] as const;
      }),
    ),
  ]);

  const allianceCache = new Map<string, Obj[]>();
  const matchCache = new Map<string, Obj[]>();
  for (const [k, data] of allianceResults) if (data !== null) allianceCache.set(k, data as Obj[]);
  for (const [k, data] of matchResults) if (data !== null) matchCache.set(k, data as Obj[]);

  // 5) Classify each pair's shared history.
  const connections: Obj[] = [];

  const slotTeamNum = (slot: unknown): number | null => {
    if (slot && typeof slot === 'object') return (slot as Obj).teamNumber ?? null;
    if (typeof slot === 'number') return Math.trunc(slot);
    return null;
  };

  for (const { ta, tb, common } of pairCommon.values()) {
    const partnerEvents: Obj[] = [];
    const opponentEvents: Obj[] = [];

    for (const key of common) {
      const [s, code] = split(key);
      const displayName = eventNameMap.get(key) ?? code;
      const ftcEventKey = `${s}ftc${code.toLowerCase()}`;
      const matches = matchCache.get(key) ?? [];

      // Partners? (same playoff alliance)
      let werePartners = false;
      for (const al of allianceCache.get(key) ?? []) {
        const members = ['captain', 'round1', 'round2', 'round3']
          .map((k) => slotTeamNum(al[k]))
          .filter((m): m is number => m !== null);
        if (members.includes(ta) && members.includes(tb)) {
          werePartners = true;
          break;
        }
      }

      if (werePartners) {
        let highestLabel: string | null = null;
        let highestOrder = -1;
        for (const m of matches) {
          const red = sideTeams(m, 'Red');
          const blue = sideTeams(m, 'Blue');
          const sameAlliance =
            (red.includes(ta) && red.includes(tb)) || (blue.includes(ta) && blue.includes(tb));
          if (!sameAlliance) continue;
          const { label, sortKey } = parseFtcBracketLabel(
            pyGet(m, 'description', '') as string,
            pyGet(m, 'series', 0) as number,
            pyGet(m, 'matchNumber', 0) as number,
          );
          const order = sortKey[0] * 100 + sortKey[1];
          if (order > highestOrder) {
            highestOrder = order;
            highestLabel = label;
          }
        }
        partnerEvents.push({
          event_key: ftcEventKey,
          event_name: displayName,
          year: s,
          stage: pyOr(highestLabel, 'Alliance'),
          // Python sets alliance_result = None and never reassigns it.
          result: null,
        });
      }

      // Opponents? (opposite alliances in the same playoff match)
      let highestLabel: string | null = null;
      let highestOrder = -1;
      let h2hAWins = 0;
      let h2hBWins = 0;
      for (const m of matches) {
        const red = sideTeams(m, 'Red');
        const blue = sideTeams(m, 'Blue');
        const aRedBBlue = red.includes(ta) && blue.includes(tb);
        const aBlueBRed = blue.includes(ta) && red.includes(tb);
        if (!aRedBBlue && !aBlueBRed) continue;

        const { label, sortKey } = parseFtcBracketLabel(
          pyGet(m, 'description', '') as string,
          pyGet(m, 'series', 0) as number,
          pyGet(m, 'matchNumber', 0) as number,
        );
        const order = sortKey[0] * 100 + sortKey[1];
        if (order > highestOrder) {
          highestOrder = order;
          highestLabel = label;
        }

        const redScore = m.scoreRedFinal ?? null;
        const blueScore = m.scoreBlueFinal ?? null;
        if (redScore !== null && blueScore !== null) {
          if (aRedBBlue) {
            if (redScore > blueScore) h2hAWins += 1;
            else if (blueScore > redScore) h2hBWins += 1;
          } else if (aBlueBRed) {
            if (blueScore > redScore) h2hAWins += 1;
            else if (redScore > blueScore) h2hBWins += 1;
          }
        }
      }

      if (highestLabel) {
        opponentEvents.push({
          event_key: ftcEventKey,
          event_name: displayName,
          year: s,
          stage: highestLabel,
          team_a_wins: h2hAWins,
          team_b_wins: h2hBWins,
        });
      }
    }

    if (partnerEvents.length || opponentEvents.length) {
      const dedupedOpponents = dedup(opponentEvents);
      const h2hWinsA = dedupedOpponents.reduce(
        (acc, e) => acc + ((pyGet(e, 'team_a_wins', 0) as number) ?? 0),
        0,
      );
      const h2hWinsB = dedupedOpponents.reduce(
        (acc, e) => acc + ((pyGet(e, 'team_b_wins', 0) as number) ?? 0),
        0,
      );
      connections.push({
        team_a: ta,
        team_a_name: nameMap.get(ta) ?? '',
        team_b: tb,
        team_b_name: nameMap.get(tb) ?? '',
        partnered_at: dedup(partnerEvents),
        opponents_at: dedupedOpponents,
        h2h_wins_a: h2hWinsA,
        h2h_wins_b: h2hWinsB,
      });
    }
  }

  connections.sort(
    (a, b) =>
      (b.partnered_at as Obj[]).length +
      (b.opponents_at as Obj[]).length -
      ((a.partnered_at as Obj[]).length + (a.opponents_at as Obj[]).length),
  );
  return connections;
}

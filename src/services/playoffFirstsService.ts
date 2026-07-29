/**
 * "First-ever playoff / finals / Einstein appearance" flags for every team in
 * an event's playoffs — port of `get_playoff_firsts` in
 * backend/app/routers/matches.py.
 *
 * Process-lifetime cached (the answer only changes when history changes), and
 * concurrency-limited because it fans out to TBA per team per season.
 */
import { getTbaClient } from './tbaClient.js';
import { Semaphore } from '../lib/semaphore.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

const playoffFirstsCache = new Map<string, Obj>();

export async function getPlayoffFirsts(eventKey: string): Promise<Obj> {
  const cached = playoffFirstsCache.get(eventKey);
  if (cached) return cached;

  const client = getTbaClient();
  const year = Number(eventKey.slice(0, 4));

  const [alliancesRaw, teamsRaw, eventInfoRaw] = await Promise.all([
    safe(client.getEventAlliances<Obj[]>(eventKey)),
    safe(client.getEventTeams<Obj[]>(eventKey)),
    safe(client.getEvent<Obj>(eventKey)),
  ]);
  if (!alliancesRaw || !alliancesRaw.length) return {};

  const isEinstein = pyGet(pyOr(eventInfoRaw, {}) as Obj, 'event_type', undefined) === 4;

  const rookieMap: Record<string, number> = {};
  for (const t of teamsRaw ?? []) {
    rookieMap[t.key] = (pyOr(t.rookie_year, 0) ?? 0) as number;
  }

  const playoffTeamKeys: string[] = [];
  for (const a of alliancesRaw) {
    for (const tk of (pyGet(a, 'picks', []) ?? []) as string[]) playoffTeamKeys.push(tk);
  }

  const sem = new Semaphore(12); // limit concurrent TBA calls

  // Einstein veterans: teams with a prior-year event_type 4 appearance.
  const einsteinVeterans = new Set<string>();
  if (isEinstein) {
    const sem2 = new Semaphore(8);
    const allTeamEvents = await Promise.all(
      playoffTeamKeys.map((tk) =>
        sem2.run(() => safe(client.get<Obj[]>(`/team/${tk}/events/simple`))),
      ),
    );
    playoffTeamKeys.forEach((tk, i) => {
      const events = allTeamEvents[i];
      if (!events) return;
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        const evKey = (pyOr(ev.key, '') ?? '') as string;
        if (
          ev.event_type === 4 &&
          evKey !== eventKey &&
          /^\d{4}$/.test(evKey.slice(0, 4)) &&
          Number(evKey.slice(0, 4)) < year
        ) {
          einsteinVeterans.add(tk);
          break;
        }
      }
    });
  }

  const checkTeam = async (tk: string): Promise<[number, Obj]> => {
    const num = Number(tk.replace('frc', ''));
    const ry = pyGet(rookieMap, tk, 0) as number;

    // Current-year rookies are first-time everything.
    if (ry >= year) {
      return [num, { first_playoff: true, first_finals: true, first_einstein: isEinstein, rookie: true }];
    }

    let everPlayoff = false;
    let everFinals = false;

    // Last 5 seasons plus the current one (other events earlier this season).
    const checkYears: number[] = [];
    for (let y = Math.max(ry, year - 5); y <= year; y += 1) checkYears.push(y);

    const statusesList = await Promise.all(
      checkYears.map((y) => sem.run(() => safe(client.getTeamEventsStatuses<Obj>(tk, y)))),
    );

    outer: for (const statuses of statusesList) {
      if (!statuses || typeof statuses !== 'object') continue;
      for (const [ek, status] of Object.entries(statuses)) {
        if (ek === eventKey) continue; // skip the current event
        if (!status || typeof status !== 'object') continue;
        const playoff = (status as Obj).playoff;
        if (playoff && typeof playoff === 'object') {
          everPlayoff = true;
          if (pyGet(playoff, 'level', '') === 'f') everFinals = true;
        }
        if (everPlayoff && everFinals) break outer;
      }
    }

    return [
      num,
      {
        first_playoff: !everPlayoff,
        first_finals: !everFinals,
        first_einstein: isEinstein && !einsteinVeterans.has(tk),
        rookie: ry >= year,
      },
    ];
  };

  const results = await Promise.all(playoffTeamKeys.map((tk) => checkTeam(tk)));
  const out: Obj = {};
  for (const [num, data] of results) out[num] = data;
  playoffFirstsCache.set(eventKey, out);
  return out;
}

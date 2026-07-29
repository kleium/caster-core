/**
 * Alliance selection analysis & partnership-history checker — port of
 * backend/app/services/alliance_service.py.
 */
import { getTbaClient } from './tbaClient.js';
import { getFrcClient } from './frcClient.js';
import { getEpaMap } from './statboticsClient.js';
import { getAvatars } from './avatarCache.js';
import {
  readEvent,
  readEventTeamsFull,
  readTeamAvatars,
  readFrcPlayoffMatches,
} from './supabase.js';
import { Semaphore } from '../lib/semaphore.js';
import { pyRound } from '../lib/pyround.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

const API_SEMAPHORE = new Semaphore(10);

function asObject(v: unknown): Obj {
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Obj) : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' ? (v as Obj) : {};
}

function sbTeamsValid(sbRows: Obj[]): boolean {
  for (const r of sbRows) {
    const rd = asObject(r.raw_data);
    if (rd.rank != null || rd.opr != null) return true;
  }
  return false;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await API_SEMAPHORE.run(fn);
  } catch {
    return null;
  }
}

// ── Double-elim bracket labels (alliance_service.py:42-63) ──
const PLAYOFF_LABELS: Record<string, string> = {
  f: 'Finals', sf: 'Semifinals', qf: 'Quarterfinals', ef: 'Round 1',
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

/** Highest double-elim round an alliance played, using FRC API playoff data. */
function resolveDoubleElimLabelFrc(playoffMatches: Obj[], alliancePicks: string[]): string | null {
  const pickNumbers = new Set(alliancePicks.map((tk) => Number(tk.replace('frc', ''))));
  let bestRound = -1;
  let bestBracket = '';
  for (const m of playoffMatches) {
    const desc = ((m.description ?? '') as string).toLowerCase();
    const matchTeams = new Set(((m.teams ?? []) as Obj[]).map((t) => t.teamNumber ?? 0));
    const overlaps = [...pickNumbers].some((n) => matchTeams.has(n));
    if (!overlaps) continue;
    if (desc.includes('final') && !desc.includes('semi')) return null; // handled separately
    const mn = (m.matchNumber ?? 0) as number;
    if (mn in DOUBLE_ELIM_MAP) {
      const [rnd, bracket] = DOUBLE_ELIM_MAP[mn]!;
      if (rnd > bestRound) {
        bestRound = rnd;
        bestBracket = bracket;
      }
    }
  }
  if (bestRound < 0) return null;
  const stage = DOUBLE_ELIM_ROUND_LABELS[bestRound] ?? `Round ${bestRound}`;
  return `${stage} (${bestBracket})`;
}

// Championship event types (no backup teams, alliances have 4 real picks).
const CHAMP_DIVISION_TYPE = 3;
const EINSTEIN_TYPE = 4;

interface Lookups {
  nameMap: Record<string, string>;
  countryMap: Record<string, string>;
  cityMap: Record<string, string>;
  stateProvMap: Record<string, string>;
  schoolMap: Record<string, string>;
  rookieYearMap: Record<string, number | null>;
  frcOrgMap: Record<number, string>;
  rankMap: Record<string, Obj>;
  oprMap: Record<string, Obj>;
  avatarMap: Record<string, string>;
}

// ── get_alliances_with_stats (alliance_service.py:91) ────────
export async function getAlliancesWithStats(eventKey: string): Promise<Obj> {
  const year = /^\d{4}/.test(eventKey) ? Number(eventKey.slice(0, 4)) : 2026;
  const eventCode = eventKey.slice(4);

  // ── Try Supabase first ──────────────────────────────────
  let sbEvent: Obj | null = null;
  let sbTeams: Obj[] = [];
  try {
    [sbEvent, sbTeams] = await Promise.all([readEvent(eventKey), readEventTeamsFull(eventKey)]);
  } catch {
    /* fall through to TBA path */
  }

  let sbAlliancesRaw: Obj[] | null = null;
  let sbEventType = -1;
  if (sbEvent) {
    const raw = asObject(sbEvent.raw_data);
    sbAlliancesRaw = (raw.alliances ?? null) as Obj[] | null;
    sbEventType = (raw.event_type ?? -1) as number;
  }

  if (sbAlliancesRaw && sbAlliancesRaw.length && sbTeams.length && sbTeamsValid(sbTeams)) {
    const nameMap: Record<string, string> = {};
    const countryMap: Record<string, string> = {};
    const cityMap: Record<string, string> = {};
    const stateProvMap: Record<string, string> = {};
    const schoolMap: Record<string, string> = {};
    const rookieYearMap: Record<string, number | null> = {};
    const rankMap: Record<string, Obj> = {};
    const oprMap: Record<string, Obj> = {};
    const frcOrgMap: Record<number, string> = {};

    for (const r of sbTeams) {
      const tk = r.team_key as string;
      const rd = asObject(r.raw_data);
      const tims = asObject(r.tims_data);
      const frcD = asObject(r.frc_data);

      nameMap[tk] = (r.nickname ?? '') as string;
      countryMap[tk] = (tims.country ?? '') as string;
      cityMap[tk] = pyOr(frcD.city, tims.city, '') as string;
      stateProvMap[tk] = pyOr(frcD.stateProv, tims.state_prov, '') as string;
      schoolMap[tk] = pyOr(frcD.schoolName, tims.school_name, '') as string;
      rookieYearMap[tk] = (pyOr(tims.rookie_year, frcD.rookieYear, null) as number | null);

      const frcOrg = (pyOr(frcD.schoolName, frcD.nameShort, '') as string);
      if (frcOrg && r.team_number) frcOrgMap[r.team_number as number] = frcOrg;

      if (rd.rank != null) {
        rankMap[tk] = {
          rank: rd.rank,
          record: { wins: rd.wins ?? 0, losses: rd.losses ?? 0, ties: rd.ties ?? 0 },
        };
      }

      const epaBlock = asObject(rd.epa);
      const oprRaw = rd.opr as number | undefined;
      oprMap[tk] = {
        opr: oprRaw ? pyRound(oprRaw, 2) : 0,
        epa: epaBlock.epa ?? null,
        epa_auto: epaBlock.epa_auto ?? null,
        epa_teleop: epaBlock.epa_teleop ?? null,
        epa_endgame: epaBlock.epa_endgame ?? null,
      };
    }

    const allAllianceKeys: string[] = [];
    for (const a of sbAlliancesRaw) allAllianceKeys.push(...((a.picks ?? []) as string[]));

    let avatarMap: Record<string, string> = {};
    try {
      avatarMap = await readTeamAvatars(allAllianceKeys, year);
    } catch {
      avatarMap = {};
    }

    // Supplement missing team data from TBA for picks not in Supabase event_teams.
    const missingPicks = allAllianceKeys.filter((tk) => !nameMap[tk]);
    if (missingPicks.length) {
      const client = getTbaClient();
      const results = await Promise.all(
        missingPicks.map((tk) => safe(() => client.get<Obj>(`/team/${tk}`))),
      );
      missingPicks.forEach((tk, i) => {
        const team = results[i];
        if (team && typeof team === 'object') {
          nameMap[tk] = (team.nickname ?? '') as string;
          if (!(tk in countryMap)) countryMap[tk] = (team.country ?? '') as string;
          if (!(tk in cityMap)) cityMap[tk] = (team.city ?? '') as string;
          if (!(tk in stateProvMap)) stateProvMap[tk] = (team.state_prov ?? '') as string;
          if (!(tk in schoolMap)) schoolMap[tk] = (team.school_name ?? '') as string;
          if (!(tk in rookieYearMap)) rookieYearMap[tk] = team.rookie_year ?? null;
        } else {
          nameMap[tk] = '';
        }
      });
    }

    // Playoff matches: Supabase first, then FRC API direct.
    let frcPlayoffMatches: Obj[] | null = null;
    if (year >= 2023) {
      try {
        frcPlayoffMatches = await readFrcPlayoffMatches(eventKey);
      } catch {
        frcPlayoffMatches = null;
      }
      if (!frcPlayoffMatches || frcPlayoffMatches.length === 0) {
        const frc = getFrcClient();
        frcPlayoffMatches = await safe(() =>
          frc.getMatches(year, eventCode.toUpperCase(), { level: 'Playoff' }),
        );
      }
      if (!Array.isArray(frcPlayoffMatches)) frcPlayoffMatches = null;
    }

    return buildAlliancesResponse(
      sbAlliancesRaw,
      { nameMap, countryMap, cityMap, stateProvMap, schoolMap, rookieYearMap, frcOrgMap, rankMap, oprMap, avatarMap },
      frcPlayoffMatches,
      year,
      eventKey,
      sbEventType,
    );
  }

  // ── Fallback: TBA + FRC API + Statbotics ────────────────
  const client = getTbaClient();
  const frc = getFrcClient();

  const [
    alliancesRaw,
    rankings,
    oprs,
    teamsList,
    frcTeamsRaw,
    epaDataR,
    frcPlayoffMatchesR,
    tbaEventInfo,
  ] = await Promise.all([
    client.getEventAlliances<Obj[]>(eventKey),
    safe(() => client.getEventRankings<Obj>(eventKey)),
    safe(() => client.getEventOprs<Obj>(eventKey)),
    safe(() => client.getEventTeams<Obj[]>(eventKey)),
    safe(() => frc.getEventTeams(year, eventCode)),
    safe(() => getEpaMap(eventKey)),
    year >= 2023
      ? safe(() => frc.getMatches(year, eventCode.toUpperCase(), { level: 'Playoff' }))
      : Promise.resolve(null),
    safe(() => client.getEvent<Obj>(eventKey)),
  ]);

  let frcPlayoffMatches = Array.isArray(frcPlayoffMatchesR) ? frcPlayoffMatchesR : null;
  const tbaEventType = (tbaEventInfo?.event_type ?? -1) as number;
  const epaData = epaDataR ?? {};

  if (!alliancesRaw || alliancesRaw.length === 0) {
    return { alliances: [], partnerships: {} };
  }

  const nameMap: Record<string, string> = {};
  const countryMap: Record<string, string> = {};
  const cityMap: Record<string, string> = {};
  const stateProvMap: Record<string, string> = {};
  const schoolMap: Record<string, string> = {};
  const rookieYearMap: Record<string, number | null> = {};
  if (teamsList) {
    for (const t of teamsList) {
      nameMap[t.key] = t.nickname ?? '';
      countryMap[t.key] = t.country ?? '';
      cityMap[t.key] = t.city ?? '';
      stateProvMap[t.key] = t.state_prov ?? '';
      schoolMap[t.key] = t.school_name ?? '';
      rookieYearMap[t.key] = t.rookie_year ?? null;
    }
  }

  const frcOrgMap: Record<number, string> = {};
  if (frcTeamsRaw) {
    for (const ft of frcTeamsRaw) {
      const num = ft.teamNumber as number | undefined;
      const org = (ft.schoolName || ft.nameShort || '') as string;
      if (num && org) frcOrgMap[num] = org;
    }
  }

  const rankMap: Record<string, Obj> = {};
  if (rankings && rankings.rankings) {
    for (const r of rankings.rankings as Obj[]) rankMap[r.team_key] = r;
  }

  const oprMap: Record<string, Obj> = {};
  if (oprs && oprs.oprs) {
    for (const tk of Object.keys(oprs.oprs as Obj)) {
      const epaInfo = asObject((epaData as Obj)[tk]);
      oprMap[tk] = {
        opr: pyRound((oprs.oprs as Obj)[tk] ?? 0, 2),
        epa: epaInfo.epa ?? null,
        epa_auto: epaInfo.epa_auto ?? null,
        epa_teleop: epaInfo.epa_teleop ?? null,
        epa_endgame: epaInfo.epa_endgame ?? null,
      };
    }
  }

  const allAllianceKeys: string[] = [];
  for (const a of alliancesRaw) allAllianceKeys.push(...((a.picks ?? []) as string[]));
  const avatarMap = await getAvatars(allAllianceKeys, year);

  return buildAlliancesResponse(
    alliancesRaw,
    { nameMap, countryMap, cityMap, stateProvMap, schoolMap, rookieYearMap, frcOrgMap, rankMap, oprMap, avatarMap },
    frcPlayoffMatches,
    year,
    eventKey,
    tbaEventType,
  );
}

// ── _build_alliances_response (alliance_service.py:328) ─────
async function buildAlliancesResponse(
  alliancesRaw: Obj[],
  lookups: Lookups,
  frcPlayoffMatches: Obj[] | null,
  year: number,
  eventKey: string,
  eventType: number,
): Promise<Obj> {
  const { nameMap, countryMap, cityMap, stateProvMap, schoolMap, rookieYearMap, frcOrgMap, rankMap, oprMap, avatarMap } =
    lookups;
  const isChamp = eventType === CHAMP_DIVISION_TYPE || eventType === EINSTEIN_TYPE;
  const pickLabels = isChamp
    ? ['Captain', '1st Pick', '2nd Pick', '3rd Pick']
    : ['Captain', '1st Pick', '2nd Pick', 'Backup'];

  const alliances: Obj[] = [];
  alliancesRaw.forEach((alliance, idx) => {
    const picks = (alliance.picks ?? []) as string[];
    const backupIn = (alliance.backup ?? {})?.in as string | undefined;
    const teamDetails: Obj[] = [];

    picks.forEach((tk, pickIdx) => {
      const r = rankMap[tk] ?? {};
      const rec = r.record ?? {};
      const o = oprMap[tk] ?? { opr: 0, epa: null, epa_auto: null, epa_teleop: null, epa_endgame: null };
      const tnum = Number(tk.replace('frc', ''));

      const pickLabel = tk === backupIn ? 'Backup' : (pickLabels[pickIdx] ?? '');

      teamDetails.push({
        team_key: tk,
        team_number: tnum,
        nickname: nameMap[tk] ?? '',
        country: countryMap[tk] ?? '',
        city: cityMap[tk] ?? '',
        state_prov: stateProvMap[tk] ?? '',
        school_name: frcOrgMap[tnum] || schoolMap[tk] || '',
        rookie_year: rookieYearMap[tk] ?? null,
        avatar: avatarMap[tk] ?? null,
        pick_label: pickLabel,
        rank: pyGet(r, 'rank', '-'),
        wins: pyGet(rec, 'wins', 0),
        losses: pyGet(rec, 'losses', 0),
        ties: pyGet(rec, 'ties', 0),
        opr: o.opr,
        epa: o.epa,
        epa_auto: o.epa_auto,
        epa_teleop: o.epa_teleop,
        epa_endgame: o.epa_endgame,
      });
    });

    // Playoff result from TBA status.
    const status = alliance.status ?? {};
    const playoffStatus = (status.status ?? '') as string;
    const playoffLevel = (status.level ?? '') as string;
    const playoffRecord = status.record ?? {};
    const pw = (playoffRecord.wins ?? 0) as number;
    const pl = (playoffRecord.losses ?? 0) as number;

    let deLabel: string | null = null;
    if (year >= 2023 && playoffLevel === 'sf' && frcPlayoffMatches) {
      deLabel = resolveDoubleElimLabelFrc(frcPlayoffMatches, picks);
    }

    let resultLabel: string;
    let resultType: string;
    if (playoffStatus === 'won') {
      resultLabel = 'Event Winner';
      resultType = 'winner';
    } else if (playoffStatus === 'eliminated' && playoffLevel === 'f') {
      resultLabel = 'Finalist';
      resultType = 'finalist';
    } else if (playoffStatus === 'eliminated') {
      resultLabel = deLabel
        ? `Eliminated in ${deLabel}`
        : `Eliminated in ${PLAYOFF_LABELS[playoffLevel] ?? playoffLevel}`;
      resultType = 'eliminated';
    } else if (playoffStatus === 'playing') {
      resultLabel = deLabel
        ? `Playing — ${deLabel}`
        : `Playing — ${PLAYOFF_LABELS[playoffLevel] ?? playoffLevel}`;
      resultType = 'playing';
    } else {
      resultLabel = '';
      resultType = '';
    }

    const combinedOpr = pyRound(teamDetails.reduce((s, t) => s + (t.opr as number), 0), 2);
    const epaVals = teamDetails.map((t) => t.epa).filter((v) => v != null) as number[];
    const combinedEpa = epaVals.length ? pyRound(epaVals.reduce((a, b) => a + b, 0), 2) : null;
    const epaAutoVals = teamDetails.map((t) => t.epa_auto).filter((v) => v != null) as number[];
    const combinedEpaAuto = epaAutoVals.length ? pyRound(epaAutoVals.reduce((a, b) => a + b, 0), 2) : null;
    const epaTeleopVals = teamDetails.map((t) => t.epa_teleop).filter((v) => v != null) as number[];
    const combinedEpaTeleop = epaTeleopVals.length ? pyRound(epaTeleopVals.reduce((a, b) => a + b, 0), 2) : null;
    const epaEndgameVals = teamDetails.map((t) => t.epa_endgame).filter((v) => v != null) as number[];
    const combinedEpaEndgame = epaEndgameVals.length
      ? pyRound(epaEndgameVals.reduce((a, b) => a + b, 0), 2)
      : null;

    alliances.push({
      number: idx + 1,
      name: alliance.name || `Alliance ${idx + 1}`,
      teams: teamDetails,
      picks,
      combined_opr: combinedOpr,
      combined_epa: combinedEpa,
      combined_epa_auto: combinedEpaAuto,
      combined_epa_teleop: combinedEpaTeleop,
      combined_epa_endgame: combinedEpaEndgame,
      playoff_result: resultLabel,
      playoff_type: resultType,
      playoff_record: pw || pl ? `${pw}-${pl}` : '',
    });
  });

  const maxOpr = alliances.length
    ? Math.max(...alliances.map((a) => a.combined_opr as number)) || 1
    : 1;

  const partnerships = await checkAllPartnerships(alliancesRaw, eventKey);

  const isChampionship = eventType === CHAMP_DIVISION_TYPE || eventType === EINSTEIN_TYPE;
  const isEinstein = eventType === EINSTEIN_TYPE;

  const divisionNames: Record<number, string> = {};
  if (isEinstein) {
    for (const a of alliances) {
      const defaultName = `Alliance ${a.number}`;
      if (a.name && a.name !== defaultName) divisionNames[a.number as number] = a.name;
    }
  }

  return {
    alliances,
    partnerships,
    max_combined_opr: maxOpr,
    is_championship: isChampionship,
    is_einstein: isEinstein,
    division_names: divisionNames,
  };
}

// ── _check_all_partnerships (alliance_service.py:478) ────────
const VALID_PARTNERSHIP_TYPES = new Set([0, 1, 2, 3, 4, 5]);

async function checkAllPartnerships(alliancesRaw: Obj[], eventKey: string): Promise<Obj> {
  const client = getTbaClient();

  const allTeams = new Set<string>();
  for (const a of alliancesRaw) for (const tk of (a.picks ?? []) as string[]) allTeams.add(tk);

  // 1) Years participated per team.
  const teamYears: Record<string, number[]> = {};
  await Promise.all(
    [...allTeams].map(async (tk) => {
      const data = await safe(() => client.getTeamYearsParticipated<number[]>(tk));
      teamYears[tk] = data ?? [];
    }),
  );

  // 2) Each team's events for every year they participated.
  const teamEvents: Record<string, Set<string>> = {};
  const eventTasks: Array<Promise<void>> = [];
  for (const tk of allTeams) {
    teamEvents[tk] = new Set<string>();
    for (const y of teamYears[tk] ?? []) {
      eventTasks.push(
        (async () => {
          const data = (await safe(() => client.getTeamEvents<Obj[]>(tk, y))) ?? [];
          for (const ev of data) {
            if (!VALID_PARTNERSHIP_TYPES.has(ev.event_type ?? -1)) continue;
            teamEvents[tk]!.add(ev.key);
          }
        })(),
      );
    }
  }
  await Promise.all(eventTasks);

  // 3) Common events we'll need alliance data for.
  const eventsToFetch = new Set<string>();
  for (const a of alliancesRaw) {
    const picks = (a.picks ?? []) as string[];
    for (let i = 0; i < picks.length; i += 1) {
      for (let j = i + 1; j < picks.length; j += 1) {
        const common = intersect(
          teamEvents[picks[i]!] ?? new Set<string>(),
          teamEvents[picks[j]!] ?? new Set<string>(),
        );
        common.delete(eventKey);
        for (const ek of common) eventsToFetch.add(ek);
      }
    }
  }

  // 4) Batch-fetch alliance data + event info for those events.
  const allianceCache: Record<string, Obj[]> = {};
  const eventNameCache: Record<string, string> = {};
  await Promise.all([
    Promise.all(
      [...eventsToFetch].map(async (ek) => {
        const data = await safe(() => client.getEventAlliances<Obj[]>(ek));
        if (data) allianceCache[ek] = data;
      }),
    ),
    Promise.all(
      [...eventsToFetch].map(async (ek) => {
        const info = await safe(() => client.getEvent<Obj>(ek));
        eventNameCache[ek] = info ? (info.name ?? ek) : ek;
      }),
    ),
  ]);

  // 5) Check each pair.
  const partnerships: Obj = {};
  for (const a of alliancesRaw) {
    const picks = (a.picks ?? []) as string[];
    for (let i = 0; i < picks.length; i += 1) {
      for (let j = i + 1; j < picks.length; j += 1) {
        const ta = picks[i]!;
        const tb = picks[j]!;
        const pairKey = `${ta}+${tb}`;
        const common = intersect(teamEvents[ta] ?? new Set<string>(), teamEvents[tb] ?? new Set<string>());
        common.delete(eventKey);

        const history: Obj[] = [];
        for (const ek of common) {
          for (const al of allianceCache[ek] ?? []) {
            const ps = (al.picks ?? []) as string[];
            if (ps.includes(ta) && ps.includes(tb)) {
              history.push({
                event_key: ek,
                event_name: eventNameCache[ek] ?? ek,
                year: Number(ek.slice(0, 4)),
                alliance_name: al.name ?? '',
              });
            }
          }
        }
        history.sort((x, y) => (x.event_key < y.event_key ? 1 : x.event_key > y.event_key ? -1 : 0));

        partnerships[pairKey] = { first_time: history.length === 0, history };
      }
    }
  }

  return partnerships;
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

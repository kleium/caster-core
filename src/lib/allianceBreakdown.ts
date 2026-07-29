/**
 * Per-alliance score-breakdown parsers — port of `_parse_alliance_2026` and
 * `_parse_alliance_2025` in backend/app/routers/matches.py.
 *
 * Field names are identical between the FRC Events API and TBA for these
 * games, so one parser serves both source paths.
 */
import { pyGet } from './pysemantics.js';

type Obj = Record<string, any>;

function robots(data: Obj, teamKeys: string[], fields: (i: number) => Obj): Obj[] {
  const out: Obj[] = [];
  for (let i = 0; i < 3; i += 1) {
    const tk = i < teamKeys.length ? teamKeys[i]! : null;
    out.push({
      team_key: tk,
      team_number: tk ? Number(tk.replace('frc', '')) : null,
      ...fields(i),
    });
  }
  void data;
  return out;
}

/** 2026 REBUILT-era breakdown. matches.py:_parse_alliance_2026. */
export function parseAlliance2026(data: Obj, teamKeys: string[]): Obj {
  const hub = (pyGet(data, 'hubScore', {}) ?? {}) as Obj;
  return {
    robots: robots(data, teamKeys, (i) => ({
      autoTower: pyGet(data, `autoTowerRobot${i + 1}`, 'None'),
      endGameTower: pyGet(data, `endGameTowerRobot${i + 1}`, 'None'),
    })),
    // Auto
    totalAutoPoints: pyGet(data, 'totalAutoPoints', 0),
    autoTowerPoints: pyGet(data, 'autoTowerPoints', 0),
    autoFuelCount: pyGet(hub, 'autoCount', 0),
    autoFuelPoints: pyGet(hub, 'autoPoints', 0),
    // Teleop
    totalTeleopPoints: pyGet(data, 'totalTeleopPoints', 0),
    transitionFuelCount: pyGet(hub, 'transitionCount', 0),
    transitionFuelPoints: pyGet(hub, 'transitionPoints', 0),
    shift1FuelCount: pyGet(hub, 'shift1Count', 0),
    shift1FuelPoints: pyGet(hub, 'shift1Points', 0),
    shift2FuelCount: pyGet(hub, 'shift2Count', 0),
    shift2FuelPoints: pyGet(hub, 'shift2Points', 0),
    shift3FuelCount: pyGet(hub, 'shift3Count', 0),
    shift3FuelPoints: pyGet(hub, 'shift3Points', 0),
    shift4FuelCount: pyGet(hub, 'shift4Count', 0),
    shift4FuelPoints: pyGet(hub, 'shift4Points', 0),
    endgameFuelCount: pyGet(hub, 'endgameCount', 0),
    endgameFuelPoints: pyGet(hub, 'endgamePoints', 0),
    teleopFuelCount: pyGet(hub, 'teleopCount', 0),
    teleopFuelPoints: pyGet(hub, 'teleopPoints', 0),
    totalFuelCount: pyGet(hub, 'totalCount', 0),
    totalFuelPoints: pyGet(hub, 'totalPoints', 0),
    uncountedFuel: pyGet(hub, 'uncounted', 0),
    // Tower
    totalTowerPoints: pyGet(data, 'totalTowerPoints', 0),
    endGameTowerPoints: pyGet(data, 'endGameTowerPoints', 0),
    // Fouls
    minorFoulCount: pyGet(data, 'minorFoulCount', 0),
    majorFoulCount: pyGet(data, 'majorFoulCount', 0),
    foulPoints: pyGet(data, 'foulPoints', 0),
    penalties: pyGet(data, 'penalties', 'None'),
    g206Penalty: pyGet(data, 'g206Penalty', false),
    // RP
    energizedAchieved: pyGet(data, 'energizedAchieved', false),
    superchargedAchieved: pyGet(data, 'superchargedAchieved', false),
    traversalAchieved: pyGet(data, 'traversalAchieved', false),
    // Totals
    adjustPoints: pyGet(data, 'adjustPoints', 0),
    totalPoints: pyGet(data, 'totalPoints', 0),
    rp: pyGet(data, 'rp', 0),
  };
}

/** Reef rows keep only `node*` keys, plus the trough/count rollups. */
function parseReef(reef: Obj): Obj {
  const rows: Obj = {};
  for (const rname of ['topRow', 'midRow', 'botRow']) {
    const row = (pyGet(reef, rname, {}) ?? {}) as Obj;
    const kept: Obj = {};
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('node')) kept[k] = v;
    }
    rows[rname] = kept;
  }
  return {
    ...rows,
    trough: pyGet(reef, 'trough', 0),
    tba_botRowCount: pyGet(reef, 'tba_botRowCount', 0),
    tba_midRowCount: pyGet(reef, 'tba_midRowCount', 0),
    tba_topRowCount: pyGet(reef, 'tba_topRowCount', 0),
  };
}

/** 2025 REEFSCAPE breakdown. matches.py:_parse_alliance_2025. */
export function parseAlliance2025(data: Obj, teamKeys: string[]): Obj {
  return {
    robots: robots(data, teamKeys, (i) => ({
      autoLine: pyGet(data, `autoLineRobot${i + 1}`, 'No'),
      endGame: pyGet(data, `endGameRobot${i + 1}`, 'None'),
    })),
    autoPoints: pyGet(data, 'autoPoints', 0),
    autoMobilityPoints: pyGet(data, 'autoMobilityPoints', 0),
    autoCoralCount: pyGet(data, 'autoCoralCount', 0),
    autoCoralPoints: pyGet(data, 'autoCoralPoints', 0),
    autoBonusAchieved: pyGet(data, 'autoBonusAchieved', false),
    autoReef: parseReef((pyGet(data, 'autoReef', {}) ?? {}) as Obj),
    teleopPoints: pyGet(data, 'teleopPoints', 0),
    teleopCoralCount: pyGet(data, 'teleopCoralCount', 0),
    teleopCoralPoints: pyGet(data, 'teleopCoralPoints', 0),
    teleopReef: parseReef((pyGet(data, 'teleopReef', {}) ?? {}) as Obj),
    algaePoints: pyGet(data, 'algaePoints', 0),
    netAlgaeCount: pyGet(data, 'netAlgaeCount', 0),
    wallAlgaeCount: pyGet(data, 'wallAlgaeCount', 0),
    endGameBargePoints: pyGet(data, 'endGameBargePoints', 0),
    bargeBonusAchieved: pyGet(data, 'bargeBonusAchieved', false),
    coralBonusAchieved: pyGet(data, 'coralBonusAchieved', false),
    coopertitionCriteriaMet: pyGet(data, 'coopertitionCriteriaMet', false),
    foulCount: pyGet(data, 'foulCount', 0),
    techFoulCount: pyGet(data, 'techFoulCount', 0),
    foulPoints: pyGet(data, 'foulPoints', 0),
    g206Penalty: pyGet(data, 'g206Penalty', false),
    g410Penalty: pyGet(data, 'g410Penalty', false),
    g418Penalty: pyGet(data, 'g418Penalty', false),
    g428Penalty: pyGet(data, 'g428Penalty', false),
    adjustPoints: pyGet(data, 'adjustPoints', 0),
    totalPoints: pyGet(data, 'totalPoints', 0),
    rp: pyGet(data, 'rp', 0),
  };
}

/** Pick the parser for a game year. */
export function parserFor(gameYear: number): (d: Obj, tk: string[]) => Obj {
  return gameYear >= 2026 ? parseAlliance2026 : parseAlliance2025;
}

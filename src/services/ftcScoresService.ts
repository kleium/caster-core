/**
 * FTC live score fast-path + single-match score breakdown — port of
 * `get_match_scores`, `get_score_breakdown` and `_build_ftc_breakdown` in
 * backend/app/services/ftc_event_service.py.
 */
import { getFtcClient } from './ftcClient.js';
import { parseFtcKey } from '../lib/ftcKey.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';

type Obj = Record<string, any>;

/** Quick score fetch for live polling. ftc_event_service.py:get_match_scores. */
export async function getMatchScores(eventKey: string): Promise<Obj> {
  const [year, eventCode] = parseFtcKey(eventKey);
  const client = getFtcClient();

  const settled = await Promise.allSettled([
    client.getMatches(year, eventCode, { level: 'qual' }),
    client.getMatches(year, eventCode, { level: 'playoff' }),
  ]);

  const results: Obj[] = [];
  const levels: Array<'qual' | 'playoff'> = ['qual', 'playoff'];
  settled.forEach((res, i) => {
    if (res.status !== 'fulfilled') return; // Python skips exception batches
    const level = levels[i]!;
    for (const m of res.value as Obj[]) {
      const matchNum = pyGet(m, 'matchNumber', 0) as number;
      const redScore = m.scoreRedFinal ?? null;
      const blueScore = m.scoreBlueFinal ?? null;
      if (redScore === null && blueScore === null) continue;

      let winning = '';
      if (redScore !== null && blueScore !== null) {
        if (redScore > blueScore) winning = 'red';
        else if (blueScore > redScore) winning = 'blue';
      }

      results.push({
        key: `${year}ftc${eventCode}_${level[0]}m${matchNum}`,
        comp_level: level,
        match_number: matchNum,
        // Python `red_score or 0` — null AND 0 both yield 0.
        red_score: pyOr(redScore, 0),
        blue_score: pyOr(blueScore, 0),
        winning_alliance: winning,
      });
    }
  });

  return { event_key: eventKey, scores: results };
}

/** Normalised FTC DECODE breakdown from raw alliance data. ftc_event_service.py:_build_ftc_breakdown. */
function buildFtcBreakdown(a: Obj): Obj {
  const autoGrid = pyGet(a, 'autoClassifierState', []);
  const teleopGrid = pyGet(a, 'teleopClassifierState', []);

  const endMap: Record<string, string> = {
    NONE: 'None',
    FULL: 'Full Ascent',
    PARTIAL: 'Partial Ascent',
  };
  const robots: Obj[] = [];
  for (const i of [1, 2]) {
    const autoLeft = pyGet(a, `robot${i}Auto`, false);
    const teleopEnd = pyGet(a, `robot${i}Teleop`, 'NONE') as string;
    robots.push({
      robot_number: i,
      auto_leave: autoLeft,
      endgame: pyGet(endMap, teleopEnd, teleopEnd),
      endgame_raw: teleopEnd,
    });
  }

  return {
    robots,
    // Auto
    autoLeavePoints: pyGet(a, 'autoLeavePoints', 0),
    autoArtifactPoints: pyGet(a, 'autoArtifactPoints', 0),
    autoPatternPoints: pyGet(a, 'autoPatternPoints', 0),
    autoClassifiedArtifacts: pyGet(a, 'autoClassifiedArtifacts', 0),
    autoOverflowArtifacts: pyGet(a, 'autoOverflowArtifacts', 0),
    autoClassifierState: autoGrid,
    autoPoints: pyGet(a, 'autoPoints', 0),
    // Teleop / driver-controlled
    teleopArtifactPoints: pyGet(a, 'teleopArtifactPoints', 0),
    teleopDepotPoints: pyGet(a, 'teleopDepotPoints', 0),
    teleopPatternPoints: pyGet(a, 'teleopPatternPoints', 0),
    teleopBasePoints: pyGet(a, 'teleopBasePoints', 0),
    teleopClassifiedArtifacts: pyGet(a, 'teleopClassifiedArtifacts', 0),
    teleopOverflowArtifacts: pyGet(a, 'teleopOverflowArtifacts', 0),
    teleopDepotArtifacts: pyGet(a, 'teleopDepotArtifacts', 0),
    teleopClassifierState: teleopGrid,
    teleopPoints: pyGet(a, 'teleopPoints', 0),
    // Fouls
    foulPointsCommitted: pyGet(a, 'foulPointsCommitted', 0),
    majorFouls: pyGet(a, 'majorFouls', 0),
    minorFouls: pyGet(a, 'minorFouls', 0),
    // Ranking points
    movementRP: pyGet(a, 'movementRP', false),
    goalRP: pyGet(a, 'goalRP', false),
    patternRP: pyGet(a, 'patternRP', false),
    // Totals
    totalPoints: pyGet(a, 'totalPoints', 0),
    preFoulTotal: pyGet(a, 'preFoulTotal', 0),
    // Randomization
    randomization: pyOr(a.randomization, 0),
  };
}

/** Detailed breakdown for a single FTC match; null when unavailable. */
export async function getScoreBreakdown(
  eventKey: string,
  level: string,
  matchNumber: number,
): Promise<Obj | null> {
  const [year, eventCode] = parseFtcKey(eventKey);
  const scores = await getFtcClient().getScores(year, eventCode, level, { matchNumber });
  if (!scores || !scores.length) return null;

  const raw = scores[0] as Obj;
  const alliances = (pyGet(raw, 'alliances', []) ?? []) as Obj[];
  if (!alliances.length) return { available: false };

  let redBd: Obj | null = null;
  let blueBd: Obj | null = null;
  for (const a of alliances) {
    const side = String(pyOr(a.alliance, '')).toLowerCase();
    const bd = buildFtcBreakdown(a);
    if (side === 'red') redBd = bd;
    else if (side === 'blue') blueBd = bd;
  }
  if (!redBd && !blueBd) return { available: false };

  const redScore = redBd ? (redBd.totalPoints as number) : 0;
  const blueScore = blueBd ? (blueBd.totalPoints as number) : 0;
  let winning = '';
  if (redScore > blueScore) winning = 'red';
  else if (blueScore > redScore) winning = 'blue';

  return {
    available: true,
    game_year: year,
    program: 'FTC',
    winning_alliance: winning,
    red: { score: redScore, breakdown: redBd ?? {} },
    blue: { score: blueScore, breakdown: blueBd ?? {} },
  };
}

/**
 * Competition-level / event-type lookup tables and the double-elimination
 * bracket resolver — port of the module-level constants and
 * `_resolve_de_level_frc` in backend/app/services/team_service.py.
 *
 * Kept in lib/ rather than inline: these tables are pure data shared by the
 * team-stats and season-achievement paths, and the DE resolver is the one
 * genuinely tricky bit of logic in that file.
 */

export const COMP_LEVEL_ORDER: Record<string, number> = {
  qm: 0,
  ef: 1,
  qf: 2,
  sf: 3,
  f: 4,
};

export const COMP_LEVEL_LABELS: Record<string, string> = {
  qm: 'Qualifications',
  ef: 'Round 1',
  qf: 'Round 2',
  sf: 'Round 3',
  f: 'Finals',
};

/** Double-elimination bracket (2023+): set_number → [round, bracket]. team_service.py:23. */
const DOUBLE_ELIM_MAP: Record<number, [number, string]> = {
  1: [1, 'Upper'],
  2: [1, 'Upper'],
  3: [1, 'Upper'],
  4: [1, 'Upper'],
  5: [2, 'Lower'],
  6: [2, 'Lower'],
  7: [2, 'Upper'],
  8: [2, 'Upper'],
  9: [3, 'Lower'],
  10: [3, 'Lower'],
  11: [4, 'Upper'],
  12: [4, 'Lower'],
  13: [5, 'Lower'],
};

const DE_ROUND_LABELS: Record<number, string> = {
  1: 'Round 1',
  2: 'Round 2',
  3: 'Round 3',
  4: 'Semis',
  5: 'Semis',
};

export const EVENT_TYPE_ORDER: Record<number, number> = {
  99: 0,
  6: 0,
  0: 1,
  1: 1,
  5: 2,
  2: 3,
  3: 4,
  4: 5,
};

export const EVENT_TYPE_LABELS: Record<number, string> = {
  0: 'Regional',
  1: 'District',
  2: 'District Championship',
  3: 'FIRST Championship Division',
  4: 'FIRST Championship (Einstein)',
  5: 'District Championship Division',
  99: 'Offseason',
  6: 'Festival of Champions',
};

/** Short event-level labels used for stage context. team_service.py:218. */
export const ET_SHORT: Record<number, string> = {
  0: 'Regional',
  1: 'District',
  2: 'District CMP',
  3: 'CMP Division',
  4: 'Einstein',
  5: 'DCMP Division',
  99: 'Offseason',
};

/** Event-type labels used when annotating an event win. team_service.py:170. */
export const WINNER_LABELS: Record<number, string> = {
  0: 'Regional',
  1: 'District',
  2: 'District Championship',
  3: 'FIRST Championship Division',
  4: 'Championship',
  5: 'District Championship Division',
};

type Obj = Record<string, any>;

/**
 * Highest double-elim round a team reached, from raw FRC API playoff matches.
 * Returns null when the team appears in no mapped match. team_service.py:36.
 */
export function resolveDeLevelFrc(playoffMatches: Obj[], teamNumber: number): string | null {
  let bestRound = -1;
  let bestBracket = '';
  let reachedFinals = false;

  for (const m of playoffMatches) {
    const mn: number = m.matchNumber ?? 0;
    const desc = String(m.description ?? '').toLowerCase();
    const matchTeams = new Set((m.teams ?? []).map((t: Obj) => t.teamNumber ?? 0));
    if (!matchTeams.has(teamNumber)) continue;

    if (desc.includes('final') && !desc.includes('semi')) {
      reachedFinals = true;
      continue;
    }
    const entry = DOUBLE_ELIM_MAP[mn];
    if (entry) {
      const [rnd, bracket] = entry;
      if (rnd > bestRound) {
        bestRound = rnd;
        bestBracket = bracket;
      }
    }
  }

  if (reachedFinals) return 'Finals';
  if (bestRound < 0) return null;
  const stage = DE_ROUND_LABELS[bestRound] ?? `Round ${bestRound}`;
  return `${stage} (${bestBracket})`;
}

/**
 * Validation schemas for upstream API responses — zod port of the subset of
 * backend/app/workers/schemas.py used by the FRC match poller.
 *
 * Models are deliberately loose (optional fields, passthrough extras) because
 * upstream APIs evolve — we validate *shape*, not *business rules*. Invalid
 * items are dropped and logged, never written to Supabase.
 */
import { z } from 'zod';

export const TBAEvent = z
  .object({
    key: z.string(),
    name: z.string().default(''),
    start_date: z.string().nullish(),
    end_date: z.string().nullish(),
    event_type: z.number().default(-1),
    city: z.string().nullish(),
    state_prov: z.string().nullish(),
    country: z.string().nullish(),
  })
  .passthrough();
export type TBAEvent = z.infer<typeof TBAEvent>;

export const TBATeam = z
  .object({
    key: z.string(),
    team_number: z.number(),
    nickname: z.string().nullish(),
    school_name: z.string().nullish(),
    city: z.string().nullish(),
    state_prov: z.string().nullish(),
    country: z.string().nullish(),
    rookie_year: z.number().nullish(),
  })
  .passthrough();
export type TBATeam = z.infer<typeof TBATeam>;

/** Coerce a numeric score; reject non-numeric garbage (schemas.py:73-81). */
const coerceScore: z.ZodType<number | null, z.ZodTypeDef, unknown> = z.preprocess(
  (v) => (typeof v === 'number' ? Math.trunc(v) : null),
  z.number().nullable(),
);

export const FRCMatchTeam = z
  .object({
    teamNumber: z.number(),
    station: z.string().nullish(),
  })
  .passthrough();

export const FRCMatch = z
  .object({
    matchNumber: z.number().default(0),
    tournamentLevel: z.string().nullish(),
    scoreRedFinal: coerceScore.default(null),
    scoreBlueFinal: coerceScore.default(null),
    actualStartTime: z.string().nullish(),
    startTime: z.string().nullish(),
    teams: z.array(FRCMatchTeam).default([]),
  })
  .passthrough();
export type FRCMatch = z.infer<typeof FRCMatch>;

export const FRCRanking = z
  .object({
    teamNumber: z.number(),
    rank: z.number().nullish(),
    wins: z.number().default(0),
    losses: z.number().default(0),
    ties: z.number().default(0),
    matchesPlayed: z.number().default(0),
    dq: z.number().default(0),
    qualAverage: z.number().nullish(),
    sortOrders: z.array(z.unknown()).nullish(),
  })
  .passthrough();
export type FRCRanking = z.infer<typeof FRCRanking>;

export const FTCEvent = z
  .object({
    code: z.string(),
    name: z.string().nullish(),
    dateStart: z.string().nullish(),
    dateEnd: z.string().nullish(),
    city: z.string().nullish(),
    stateprov: z.string().nullish(),
    country: z.string().nullish(),
  })
  .passthrough();
export type FTCEvent = z.infer<typeof FTCEvent>;

export const FTCTeam = z
  .object({
    teamNumber: z.number(),
    nameShort: z.string().nullish(),
    nameFull: z.string().nullish(),
  })
  .passthrough();
export type FTCTeam = z.infer<typeof FTCTeam>;

export const FTCMatch = z
  .object({
    matchNumber: z.number().default(0),
    series: z.number().default(1),
    tournamentLevel: z.string().nullish(),
    scoreRedFinal: coerceScore.default(null),
    scoreBlueFinal: coerceScore.default(null),
    scoreTotalRed: coerceScore.default(null),
    scoreTotalBlue: coerceScore.default(null),
    actualStartTime: z.string().nullish(),
    startTime: z.string().nullish(),
    teams: z.array(FRCMatchTeam).default([]), // same team shape as FRC (schemas.py:135)
  })
  .passthrough();
export type FTCMatch = z.infer<typeof FTCMatch>;

export const FTCRanking = z
  .object({
    teamNumber: z.number(),
    rank: z.number().nullish(),
    wins: z.number().default(0),
    losses: z.number().default(0),
    ties: z.number().default(0),
    matchesPlayed: z.number().default(0),
    dq: z.number().default(0),
    qualAverage: z.number().nullish(),
    sortOrders: z.array(z.unknown()).nullish(),
  })
  .passthrough();
export type FTCRanking = z.infer<typeof FTCRanking>;

/**
 * Validate a list against `schema`, returning only items that pass. Invalid
 * items are logged and skipped (schemas.py:178).
 */
export function validateList<T>(
  schema: z.ZodType<T>,
  items: unknown,
  label = '',
): T[] {
  if (!Array.isArray(items)) {
    console.warn(
      `Expected list for ${label}, got ${typeof items} — rejecting entire payload`,
    );
    return [];
  }
  const valid: T[] = [];
  items.forEach((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      console.warn(`[${label}] Item ${i} is ${typeof raw}, not object — skipping`);
      return;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      console.warn(`[${label}] Item ${i} failed validation: ${parsed.error.message}`);
    }
  });
  return valid;
}

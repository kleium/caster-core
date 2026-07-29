/**
 * Active FTC kickoff year — port of `current_ftc_season` in
 * backend/app/services/ftc_event_service.py.
 *
 * The rollover month is **August** (`_FTC_SEASON_ROLLOVER_MONTH = 8`), i.e. from
 * 1 August the current calendar year is the season. `ftcEventSync.ts` originally
 * carried its own copy using September, which would have disagreed with FastAPI
 * for the whole of August; this module is now the single source of truth.
 *
 * Python uses `date.today()` (local time), so this uses local getMonth/getFullYear
 * rather than the UTC variants.
 */
const FTC_SEASON_ROLLOVER_MONTH = 8;

export function currentFtcSeason(today: Date = new Date()): number {
  const year = today.getFullYear();
  return today.getMonth() + 1 >= FTC_SEASON_ROLLOVER_MONTH ? year : year - 1;
}

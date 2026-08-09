/**
 * FTC Scout GraphQL API client — port of the subset of
 * backend/app/services/ftcscout_client.py needed by the M4b event_sync worker
 * (`getEventTeamStats` — OPR/averages/QuickStats). World record, per-team
 * QuickStats, OPR history, event matches, and season high scores belong to
 * later M4c+ read-layer slices.
 */
import { ftcscoutBreaker } from '../lib/circuitBreaker.js';
import { postJson } from '../lib/http.js';
import { pyGet, pyOr, pyTruthy } from '../lib/pysemantics.js';
import { pyRound } from '../lib/pyround.js';

const FTCSCOUT_URL = 'https://api.ftcscout.org/graphql';
const CACHE_TTL = 300_000; // ms — 5 min for team-level stats (ftcscout_client.py:15)
const WR_CACHE_TTL = 600_000;
const SEASON_STATS_TTL = 600_000; // ms — 10 min for season-wide records (ftcscout_client.py:18) // ms — 10 min for world record (ftcscout_client.py:17)
const EVENT_CACHE_TTL = 120_000; // ms — 2 min for event queries (ftcscout_client.py:16)

type Obj = Record<string, any>;

class FTCScoutClient {
  private readonly cache = new Map<string, { ts: number; data: unknown }>();

  private getCached<T>(key: string, ttlMs: number): T | undefined {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.ts < ttlMs) return hit.data as T;
    return undefined;
  }

  private setCache(key: string, value: unknown): void {
    this.cache.set(key, { ts: Date.now(), data: value });
  }

  /** Execute a GraphQL query through the circuit breaker. ftcscout_client.py:56. */
  private async query(gql: string, variables?: Obj): Promise<Obj> {
    const payload = JSON.stringify(variables ? { query: gql, variables } : { query: gql });
    const body = await ftcscoutBreaker.call(() =>
      postJson<Obj>(FTCSCOUT_URL, payload, { headers: { 'content-type': 'application/json' } }),
    );
    if (!body || typeof body !== 'object') return {};
    if (body.errors && body.errors.length) {
      console.warn(`FTC Scout GraphQL errors: ${JSON.stringify(body.errors)}`);
    }
    return body.data ?? {};
  }

  /**
   * Team event participation with OPR/avg stats for the current DECODE-era
   * season. Returns snake_case rows: {team_number, rank, rp, wins, losses,
   * ties, qual_matches_played, opr_total, opr_auto, opr_dc, opr_np, avg_*,
   * max_*, min_total, dev_total, quick_stats}. ftcscout_client.py:83.
   */
  async getEventTeamStats(season: number, eventCode: string): Promise<Obj[]> {
    const cacheKey = `event_stats:${season}:${eventCode}`;
    const cached = this.getCached<Obj[]>(cacheKey, EVENT_CACHE_TTL);
    if (cached !== undefined) return cached;

    const statFrag = `
                  rank rp tb1 wins losses ties qualMatchesPlayed
                  opr { autoPoints dcPoints totalPoints totalPointsNp }
                  avg { autoPoints dcPoints totalPoints totalPointsNp }
                  max { autoPoints dcPoints totalPoints }
                  min { autoPoints dcPoints totalPoints }
                  dev { autoPoints dcPoints totalPoints }
    `;
    const query = `
        query ($season: Int!, $code: String!) {
          eventByCode(season: $season, code: $code) {
            teams {
              teamNumber
              stats {
                ... on TeamEventStats2025 {${statFrag}}
                ... on TeamEventStats2024 {${statFrag}}
              }
              team {
                number name
                quickStats(season: $season) {
                  tot { value rank }
                  auto { value rank }
                  dc { value rank }
                  count
                }
              }
            }
          }
        }
    `;
    const data = await this.query(query, { season, code: eventCode });
    const event = data.eventByCode;
    if (!event || !event.teams) {
      this.setCache(cacheKey, []);
      return [];
    }

    const results: Obj[] = [];
    for (const tep of event.teams as Obj[]) {
      const stats = tep.stats ?? {};
      const team = tep.team ?? {};
      const qs = team.quickStats ?? {};

      const opr = stats.opr ?? {};
      const avg = stats.avg ?? {};
      const mx = stats.max ?? {};
      const mn = stats.min ?? {};
      const dv = stats.dev ?? {};

      results.push({
        team_number: tep.teamNumber,
        rank: stats.rank,
        rp: stats.rp,
        tb1: stats.tb1,
        wins: stats.wins ?? 0,
        losses: stats.losses ?? 0,
        ties: stats.ties ?? 0,
        qual_matches_played: stats.qualMatchesPlayed ?? 0,
        opr_total: opr.totalPoints,
        opr_auto: opr.autoPoints,
        opr_dc: opr.dcPoints,
        opr_np: opr.totalPointsNp,
        avg_total: avg.totalPoints,
        avg_auto: avg.autoPoints,
        avg_dc: avg.dcPoints,
        avg_np: avg.totalPointsNp,
        max_total: mx.totalPoints,
        max_auto: mx.autoPoints,
        max_dc: mx.dcPoints,
        min_total: mn.totalPoints,
        dev_total: dv.totalPoints,
        // Explicit `?? null` (not left as undefined): JSON.stringify drops
        // undefined keys entirely, whereas Python's None always serializes
        // to `null` — omitting these here would silently strip the keys.
        quick_stats: {
          tot: qs.tot ?? null,
          auto: qs.auto ?? null,
          dc: qs.dc ?? null,
          count: qs.count ?? null,
        },
      });
    }

    this.setCache(cacheKey, results);
    return results;
  }

  /** A single team's QuickStats for a season. ftcscout_client.py:287. */
  async getTeamQuickStats(teamNumber: number, season: number): Promise<Obj | null> {
    const cacheKey = `qstats:${season}:${teamNumber}`;
    const cached = this.getCached<Obj | null>(cacheKey, CACHE_TTL);
    if (cached !== undefined) return cached;

    const query = `
        query ($num: Int!) {
          teamByNumber(number: $num) {
            number name schoolName
            location { city state country }
            rookieYear
            quickStats(season: ${season}) {
              tot { value rank }
              auto { value rank }
              dc { value rank }
              count
            }
          }
        }
        `;
    const data = await this.query(query, { num: teamNumber });
    const team = data.teamByNumber as Obj | undefined;
    if (!team) {
      this.setCache(cacheKey, null);
      return null;
    }

    const qs = (pyOr(team.quickStats, {}) ?? {}) as Obj;
    const result = {
      team_number: team.number ?? null,
      name: pyGet(team, 'name', ''),
      school_name: pyGet(team, 'schoolName', ''),
      location: team.location ?? null,
      rookie_year: team.rookieYear ?? null,
      quick_stats: {
        tot: qs.tot ?? null,
        auto: qs.auto ?? null,
        dc: qs.dc ?? null,
        count: qs.count ?? null,
      },
    };
    this.setCache(cacheKey, result);
    return result;
  }

  /** OPR across every season back to 2019 for a team. ftcscout_client.py:332. */
  async getTeamOprHistory(teamNumber: number, currentSeason: number): Promise<Obj[]> {
    const cacheKey = `opr_history:${teamNumber}:${currentSeason}`;
    const cached = this.getCached<Obj[]>(cacheKey, CACHE_TTL);
    if (cached !== undefined) return cached;

    const seasons: number[] = [];
    for (let s = 2019; s <= currentSeason; s += 1) seasons.push(s);

    const settled = await Promise.allSettled(
      seasons.map((s) => this.getTeamQuickStats(teamNumber, s)),
    );

    const results: Obj[] = [];
    seasons.forEach((s, i) => {
      const r = settled[i]!;
      if (r.status !== 'fulfilled' || !pyTruthy(r.value)) return;
      const qs = (pyGet(r.value as Obj, 'quick_stats', {}) ?? {}) as Obj;
      const tot = (pyOr(qs.tot, {}) ?? {}) as Obj;
      if (tot.value === null || tot.value === undefined) return;
      results.push({
        season: s,
        opr_total: pyRound(tot.value as number, 2),
        opr_auto: pyRound(pyGet((pyOr(qs.auto, {}) ?? {}) as Obj, 'value', 0) as number, 2),
        opr_dc: pyRound(pyGet((pyOr(qs.dc, {}) ?? {}) as Obj, 'value', 0) as number, 2),
        rank: tot.rank ?? null,
        count: qs.count ?? null,
      });
    });

    this.setCache(cacheKey, results);
    return results;
  }

  /**
   * Traditional (alliance) world-record match for a season. ftcscout_client.py:192.
   *
   * No `... on MatchScores2026` fragment yet: FTC Scout's schema doesn't have
   * that type until they add 2026 support (confirmed via introspection —
   * newest is MatchScores2025). A GraphQL document referencing an unknown
   * type fails validation for the *whole* query, so requesting an unsupported
   * season doesn't just come back empty, it 400s every season including
   * ones that do exist. Add the 2026 fragment back once FTC Scout ships it.
   */
  async getWorldRecord(season: number): Promise<Obj | null> {
    const cacheKey = `wr:${season}`;
    const cached = this.getCached<Obj | null>(cacheKey, WR_CACHE_TTL);
    if (cached !== undefined) return cached;

    const query = `
        query ($season: Int!) {
          tradWorldRecord(season: $season) {
            season eventCode id hasBeenPlayed
            tournamentLevel series matchNum
            scores {
              ... on MatchScores2025 {
                red { autoPoints dcPoints totalPoints minorsCommitted majorsCommitted }
                blue { autoPoints dcPoints totalPoints minorsCommitted majorsCommitted }
              }
              ... on MatchScores2024 {
                red { autoPoints dcPoints totalPoints minorsCommitted majorsCommitted }
                blue { autoPoints dcPoints totalPoints minorsCommitted majorsCommitted }
              }
            }
            teams {
              station teamNumber
              team { number name }
            }
          }
        }
        `;
    const data = await this.query(query, { season });
    const wr = data.tradWorldRecord as Obj | undefined;
    if (!wr) {
      this.setCache(cacheKey, null);
      return null;
    }

    const scores = (pyOr(wr.scores, {}) ?? {}) as Obj;
    const red = (pyOr(scores.red, {}) ?? {}) as Obj;
    const blue = (pyOr(scores.blue, {}) ?? {}) as Obj;
    const redTotal = pyGet(red, 'totalPoints', 0) as number;
    const blueTotal = pyGet(blue, 'totalPoints', 0) as number;
    const winningScore = Math.max(redTotal, blueTotal);
    const winningAlliance = redTotal >= blueTotal ? 'red' : 'blue';

    // FTC Scout uses numbered stations, not Red1/Blue1 — the teams list holds
    // 4 entries for a traditional match, first half red, second half blue.
    const teams = (pyGet(wr, 'teams', []) ?? []) as Obj[];
    const redTeams: Obj[] = [];
    const blueTeams: Obj[] = [];
    teams.forEach((t, i) => {
      const info = {
        number: t.teamNumber ?? null,
        name: pyGet((pyOr(t.team, {}) ?? {}) as Obj, 'name', ''),
      };
      if (i < Math.floor(teams.length / 2)) redTeams.push(info);
      else blueTeams.push(info);
    });

    const allTeamNames = [...redTeams, ...blueTeams]
      .filter((t) => pyTruthy(t.name))
      .map((t) => t.name);

    const eventCode = pyGet(wr, 'eventCode', '') as string;
    const levelStr = pyGet(wr, 'tournamentLevel', '') as string;
    const matchNum = pyGet(wr, 'matchNum', 0) as number;

    const result = {
      season: wr.season ?? null,
      event_code: eventCode,
      event_key: `${season}ftc${eventCode}`.toLowerCase(),
      event_name: eventCode, // FTC Scout's WR query carries no event name
      match: levelStr ? `${levelStr} ${matchNum}` : `Match ${matchNum}`,
      match_id: wr.id ?? null,
      level: levelStr,
      match_number: matchNum,
      score: winningScore,
      winning_alliance: winningAlliance,
      red_score: redTotal,
      blue_score: blueTotal,
      red_auto: pyGet(red, 'autoPoints', 0),
      blue_auto: pyGet(blue, 'autoPoints', 0),
      red_dc: pyGet(red, 'dcPoints', 0),
      blue_dc: pyGet(blue, 'dcPoints', 0),
      teams: allTeamNames,
      red_teams: redTeams,
      blue_teams: blueTeams,
    };
    this.setCache(cacheKey, result);
    return result;
  }


  /**
   * Top match scores + top-OPR teams for a season. ftcscout_client.py:434.
   * No MatchScores2026 fragment — see the comment on getWorldRecord above.
   */
  async getSeasonHighScores(season: number, limit = 10): Promise<Obj> {
    const cacheKey = `season_high:${season}:${limit}`;
    const cached = this.getCached<Obj>(cacheKey, SEASON_STATS_TTL);
    if (cached !== undefined) return cached;

    const statFrag = `
            opr { totalPoints autoPoints dcPoints totalPointsNp }
            rank wins losses
        `;
    const scoreFrag = `
            red { totalPoints autoPoints dcPoints totalPointsNp }
            blue { totalPoints autoPoints dcPoints totalPointsNp }
        `;

    const matchQuery = `
        query ($season: Int!, $take: Int!) {
          matchRecords(
            season: $season
            sortBy: "totalPointsNp"
            sortDir: Desc
            skip: 0
            take: $take
          ) {
            data {
              noFilterRank
              data {
                alliance
                match {
                  season eventCode id tournamentLevel matchNum
                  scores {
                    ... on MatchScores2025 { ${scoreFrag} }
                    ... on MatchScores2024 { ${scoreFrag} }
                  }
                  teams {
                    station teamNumber
                    team { name }
                  }
                }
              }
            }
          }
        }
        `;

    const tepQuery = `
        query ($season: Int!, $take: Int!) {
          tepRecords(
            season: $season
            sortBy: "opr.totalPoints"
            sortDir: Desc
            skip: 0
            take: $take
          ) {
            data {
              noFilterRank
              data {
                teamNumber
                stats {
                  ... on TeamEventStats2025 { ${statFrag} }
                  ... on TeamEventStats2024 { ${statFrag} }
                }
                team { name }
                event { code name }
              }
            }
          }
        }
        `;

    // Both queries count as ONE breaker unit. Take limit*4 match records —
    // scrimmages are filtered by the caller afterwards, so we need headroom.
    let matchData: unknown;
    let tepData: unknown;
    try {
      [matchData, tepData] = await ftcscoutBreaker.call(async () => {
        const settled = await Promise.allSettled([
          this.query(matchQuery, { season, take: limit * 4 }),
          this.query(tepQuery, { season, take: limit * 3 }),
        ]);
        return settled.map((r) => (r.status === 'fulfilled' ? r.value : r.reason)) as [
          unknown,
          unknown,
        ];
      });
    } catch (exc) {
      console.warn(`FTC Scout season high scores failed for ${season}: ${String(exc)}`);
      return { matches: [], opr_teams: [], team_names: {} };
    }

    const teamNames: Record<string, string> = {};

    // ── Match records ─────────────────────────────────────
    const matches: Obj[] = [];
    if (matchData && !(matchData instanceof Error)) {
      const rows = (pyOr((matchData as Obj).matchRecords, {}) as Obj).data ?? [];
      for (const row of rows as Obj[]) {
        const inner = (pyOr(row.data, {}) ?? {}) as Obj;
        const match = (pyOr(inner.match, {}) ?? {}) as Obj;
        const alliance = String(pyOr(inner.alliance, 'Red')).toLowerCase();
        const scores = (pyOr(match.scores, {}) ?? {}) as Obj;
        const side = (pyOr(scores[alliance], {}) ?? {}) as Obj;

        const scoreNp = pyOr(pyGet(side, 'totalPointsNp', 0), 0) as number;
        const score = pyOr(pyGet(side, 'totalPoints', 0), 0) as number;
        const auto = pyOr(pyGet(side, 'autoPoints', 0), 0) as number;
        const dc = pyOr(pyGet(side, 'dcPoints', 0), 0) as number;

        // FTC Scout orders teams Red1, Red2, [RedSurrogate], Blue1, Blue2, …
        // Filter to on-field stations first, then split by position.
        const allTeams = (pyOr(match.teams, []) ?? []) as Obj[];
        const onField = allTeams
          .filter((t) => t.station === 'One' || t.station === 'Two')
          .map((t) => ({
            number: t.teamNumber ?? null,
            name: pyGet((pyOr(t.team, {}) ?? {}) as Obj, 'name', '') as string,
          }));
        for (const pt of onField) {
          if (pt.number && pt.name) teamNames[String(pt.number)] = pt.name;
        }
        const playing = alliance === 'red' ? onField.slice(0, 2) : onField.slice(2);

        const eventCode = pyGet(match, 'eventCode', '') as string;
        const level = pyGet(match, 'tournamentLevel', '') as string;
        const matchNum = pyGet(match, 'matchNum', 0) as number;

        matches.push({
          rank: row.noFilterRank ?? null,
          event_code: eventCode,
          event_key: `${season}ftc${eventCode}`.toLowerCase(),
          event_name: eventCode, // caller enriches with the friendly name
          match_id: match.id ?? null,
          level,
          match_number: matchNum,
          match_label: level ? `${level} ${matchNum}` : `M${matchNum}`,
          alliance,
          score,
          score_np: scoreNp,
          auto,
          dc,
          red_score: pyGet((pyOr(scores.red, {}) ?? {}) as Obj, 'totalPoints', 0),
          blue_score: pyGet((pyOr(scores.blue, {}) ?? {}) as Obj, 'totalPoints', 0),
          teams: playing.filter((pt) => pyTruthy(pt.name)).map((pt) => pt.name),
          team_numbers: playing.filter((pt) => pyTruthy(pt.number)).map((pt) => pt.number),
        });
      }
    }

    // ── TEP records — best OPR per team ───────────────────
    const oprTeams: Obj[] = [];
    const seenTeamNums = new Set<number>();
    if (tepData && !(tepData instanceof Error)) {
      const rows = (pyOr((tepData as Obj).tepRecords, {}) as Obj).data ?? [];
      for (const row of rows as Obj[]) {
        const inner = (pyOr(row.data, {}) ?? {}) as Obj;
        const teamNum = inner.teamNumber;
        if (teamNum === null || teamNum === undefined || seenTeamNums.has(teamNum)) continue;
        seenTeamNums.add(teamNum);

        const stats = (pyOr(inner.stats, {}) ?? {}) as Obj;
        const opr = (pyOr(stats.opr, {}) ?? {}) as Obj;
        const teamName = pyGet((pyOr(inner.team, {}) ?? {}) as Obj, 'name', '') as string;
        const event = (pyOr(inner.event, {}) ?? {}) as Obj;

        if (teamName) teamNames[String(teamNum)] = teamName;

        oprTeams.push({
          team: teamNum,
          name: teamName,
          opr: pyRound((pyOr(opr.totalPoints, 0) ?? 0) as number, 2),
          opr_auto: pyRound((pyOr(opr.autoPoints, 0) ?? 0) as number, 2),
          opr_dc: pyRound((pyOr(opr.dcPoints, 0) ?? 0) as number, 2),
          rank: stats.rank ?? null,
          wins: pyGet(stats, 'wins', 0),
          losses: pyGet(stats, 'losses', 0),
          best_event_code: pyGet(event, 'code', ''),
          best_event_name: pyGet(event, 'name', ''),
        });
        if (oprTeams.length >= limit) break;
      }
    }

    const result = { matches, opr_teams: oprTeams, team_names: teamNames };
    this.setCache(cacheKey, result);
    return result;
  }

}

// ── Singleton ───────────────────────────────────────────────
let _client: FTCScoutClient | null = null;

export function getFtcscoutClient(): FTCScoutClient {
  if (_client === null) _client = new FTCScoutClient();
  return _client;
}

/**
 * FRC event read routes — port of the corresponding handlers in
 * backend/app/routers/events.py. M3a/M3b: /info and /teams.
 */
import type { FastifyInstance } from 'fastify';

import {
  getEventInfo,
  getEventTeamsWithStats,
  getSeasonEvents,
  getFastRankings,
} from '../services/eventService.js';
import { getStatboticsClient } from '../services/statboticsClient.js';
import { getFrcClient } from '../services/frcClient.js';
import { getTbaClient } from '../services/tbaClient.js';
import { getGatoolClient } from '../services/gatoolClient.js';
import { getSupabase } from '../services/supabase.js';
import { invalidateSnapshot } from '../lib/snapshotCache.js';
import { getSeasonRecord, setSeasonRecord } from '../services/supabase.js';
import { getEventSummary, getEventSummaryStats } from '../services/summaryService.js';
import { getEventSummaryAwards, getCurrentSeasonAwards } from '../services/summaryAwardsService.js';
import { getEventAdvancement } from '../services/advancementService.js';
import { getEventConnections, getMatchConnections } from '../services/connectionsService.js';
import { seedFromTba, getWorldRecord } from '../services/worldRecordService.js';
import { getRegionFacts, listRegions } from '../lib/regionStats.js';
import { getEventHistory } from '../services/regionService.js';
import { getEventSnapshot, buildSnapshot, writeSnapshot } from '../services/snapshotService.js';
import { getTeamComparison } from '../services/teamComparisonService.js';
import * as payloadCache from '../lib/payloadCache.js';
import { raiseApiError } from '../lib/apiError.js';
import { ApiError } from '../plugins/errorEnvelope.js';

interface EventKeyParams {
  event_key: string;
}

interface ConnectionsQuery {
  all_time?: string;
  teams?: string;
}

/**
 * TBA match-key suffix → readable label. events.py:109.
 * 2026abc_qm42 → "QM 42", 2026abc_sf1m1 → "SF1-1", 2026abc_f1m2 → "F1-2".
 */
function parseMatchLabel(matchKey: string): string {
  const parts = matchKey.split('_');
  if (parts.length < 2) return matchKey;
  const raw = parts[parts.length - 1]!;
  // Python re.match anchors at the start only (not the end) — mirror that.
  const m = /^([a-z]+)(\d+)(?:m(\d+))?/.exec(raw);
  if (!m) return raw;
  const [, comp, num1, num2] = m;
  const labels: Record<string, string> = { qm: 'QM', sf: 'SF', f: 'F', qf: 'QF', ef: 'EF' };
  const prefix = labels[comp!] ?? comp!.toUpperCase();
  return num2 ? `${prefix}${num1}-${num2}` : `${prefix} ${num1}`;
}

/** Mirrors FastAPI's Query(bool) coercion: "true"/"1" (case-insensitive) → true. */
function parseBoolQuery(v: string | undefined): boolean {
  if (!v) return false;
  return ['true', '1'].includes(v.toLowerCase());
}

export function registerEventRoutes(app: FastifyInstance): void {
  // events.py:20 — GET /api/events/world-record
  app.get('/api/events/world-record', async () => {
    try {
      await seedFromTba();
      const rec = getWorldRecord();
      if (!rec) return { score: 0 };
      return rec;
    } catch (e) {
      raiseApiError(e, 'Could not load world record.');
    }
  });

  // events.py:36 — GET /api/events/season-high-scores
  app.get<{ Querystring: { year?: string } }>('/api/events/season-high-scores', async (req) => {
    const year = req.query.year !== undefined ? Number(req.query.year) : 2026;
    try {
      // 1. Disk cache — Statbotics data changes infrequently.
      const cached = await payloadCache.readPayload('season_high', String(year), 600);
      if (cached) return cached;

      // Keep stale data on hand in case Statbotics is down.
      const stale = await payloadCache.readStale('season_high', String(year));

      // 2. Supabase cache — survives process restarts / cold starts.
      const sbRow = await getSeasonRecord(`frc_season_high_${year}`);
      if (sbRow?.payload) {
        const payload = sbRow.payload as Record<string, unknown>;
        await payloadCache.writePayload('season_high', String(year), payload);
        return payload;
      }

      try {
        const sb = getStatboticsClient();
        const data = await sb.getSeasonHighScores(year, 10);

        // Resolve event keys → friendly names from season data.
        const eventNames: Record<string, string> = {};
        try {
          const events = await getSeasonEvents(year);
          for (const ev of events) {
            eventNames[(ev.key as string) ?? ''] =
              (ev.short_name as string) || (ev.name as string) || ((ev.key as string) ?? '');
          }
        } catch {
          /* names are best-effort */
        }

        for (const m of (data.matches ?? []) as Record<string, unknown>[]) {
          const ek = (m.event_key as string) ?? '';
          m.event_name = eventNames[ek] ?? ek;
          m.match_label = parseMatchLabel((m.key as string) ?? '');
        }

        await payloadCache.writePayload('season_high', String(year), data);
        // Fire-and-forget, matching Python's asyncio.create_task.
        void setSeasonRecord(`frc_season_high_${year}`, year, 'frc_season_high_scores', data);
        return data;
      } catch (e) {
        if (stale) return stale;
        throw e;
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, `Could not load season high scores for ${year}.`);
    }
  });

  // events.py:90 — GET /api/events/season-most-wins
  app.get<{ Querystring: { year?: string; limit?: string } }>(
    '/api/events/season-most-wins',
    async (req) => {
      const year = req.query.year !== undefined ? Number(req.query.year) : 2026;
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new ApiError(400, 'limit must be between 1 and 50');
      }
      try {
        const cacheKey = `${year}_${limit}`;
        const cached = await payloadCache.readPayload('season_most_wins', cacheKey, 600);
        if (cached) return cached.teams ?? [];

        const sb = getStatboticsClient();
        const teams = await sb.getMostWins(year, limit);
        await payloadCache.writePayload('season_most_wins', cacheKey, { teams });
        return teams;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load most wins for ${year}.`);
      }
    },
  );

  // events.py:132 — GET /api/events/season/{year}
  app.get<{ Params: { year: string }; Querystring: { include_offseason?: string } }>(
    '/api/events/season/:year',
    async (req) => {
      const year = Number(req.params.year);
      if (!Number.isInteger(year)) throw new ApiError(400, 'Invalid year');
      const includeOffseason = parseBoolQuery(req.query.include_offseason);
      try {
        return await getSeasonEvents(year, includeOffseason);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load season ${year} events.`);
      }
    },
  );

  // events.py:142 — GET /api/events/{event_key}/info
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/info', async (req) => {
    const { event_key } = req.params;
    try {
      return await getEventInfo(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load event info for '${event_key}'.`);
    }
  });

  // events.py:152 — GET /api/events/{event_key}/teams
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/teams', async (req) => {
    const { event_key } = req.params;
    try {
      return await getEventTeamsWithStats(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load teams for event '${event_key}'.`);
    }
  });

  // events.py:160 — GET /api/events/{event_key}/summary
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/summary', async (req) => {
    const { event_key } = req.params;
    try {
      const result = await getEventSummary(event_key);
      if ('error' in result) {
        throw new ApiError(404, result.error as string);
      }
      return result;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, `Could not load summary for event '${event_key}'.`);
    }
  });

  // events.py:173 — GET /api/events/{event_key}/summary/refresh-stats
  app.get<{ Params: EventKeyParams }>(
    '/api/events/:event_key/summary/refresh-stats',
    async (req) => {
      const { event_key } = req.params;
      try {
        // Invalidate the summary disk cache so the next full load is fresh.
        await payloadCache.invalidate('summary', event_key);
        return await getEventSummaryStats(event_key);
      } catch (e) {
        raiseApiError(e, `Could not refresh stats for event '${event_key}'.`);
      }
    },
  );

  // events.py:187 — GET /api/events/{event_key}/summary/awards
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/summary/awards', async (req) => {
    const { event_key } = req.params;
    try {
      return await getEventSummaryAwards(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load awards for event '${event_key}'.`);
    }
  });

  // events.py:198 — GET /api/events/{event_key}/summary/season-awards
  app.get<{ Params: EventKeyParams }>(
    '/api/events/:event_key/summary/season-awards',
    async (req) => {
      const { event_key } = req.params;
      try {
        return await getCurrentSeasonAwards(event_key);
      } catch (e) {
        raiseApiError(e, `Could not load season awards for event '${event_key}'.`);
      }
    },
  );

  // events.py:208 — GET /api/events/{event_key}/summary/advancement
  app.get<{ Params: EventKeyParams }>(
    '/api/events/:event_key/summary/advancement',
    async (req) => {
      const { event_key } = req.params;
      try {
        return await getEventAdvancement(event_key);
      } catch (e) {
        raiseApiError(e, `Could not load advancement data for event '${event_key}'.`);
      }
    },
  );

  // events.py:219 — GET /api/events/{event_key}/summary/connections
  app.get<{ Params: EventKeyParams; Querystring: ConnectionsQuery }>(
    '/api/events/:event_key/summary/connections',
    async (req) => {
      const { event_key } = req.params;
      const allTime = parseBoolQuery(req.query.all_time);
      const teamsParam = req.query.teams;
      try {
        if (teamsParam) {
          const teamNumbers = teamsParam
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
            .map((t) => Number(t));
          return await getMatchConnections(event_key, teamNumbers, allTime);
        }
        return await getEventConnections(event_key, allTime);
      } catch (e) {
        raiseApiError(e, `Could not load connections for event '${event_key}'.`);
      }
    },
  );

  // events.py:237 — GET /api/events/{event_key}/refresh
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/refresh', async (req) => {
    const { event_key } = req.params;
    try {
      const client = getTbaClient();
      for (const ep of [
        `/event/${event_key}`,
        `/event/${event_key}/teams`,
        `/event/${event_key}/oprs`,
        `/event/${event_key}/rankings`,
        `/event/${event_key}/matches`,
        `/event/${event_key}/alliances`,
        `/event/${event_key}/awards`,
      ]) {
        client.clearCacheEntry(ep);
      }
      await payloadCache.invalidate('summary', event_key);
      await payloadCache.invalidate('awards', event_key);
      await invalidateSnapshot(event_key);

      // Rebuild the snapshot so the next read is warm and fresh.
      const payload = await buildSnapshot(event_key);
      await writeSnapshot(event_key, payload);

      return { status: 'refreshed', event_key };
    } catch (e) {
      raiseApiError(e, `Could not refresh event '${event_key}'.`);
    }
  });

  // events.py:323 — GET /api/events/{event_key}/compare
  app.get<{ Params: EventKeyParams; Querystring: { teams?: string } }>(
    '/api/events/:event_key/compare',
    async (req) => {
      const { event_key } = req.params;
      const teams = req.query.teams;
      if (typeof teams !== 'string') {
        throw new ApiError(400, 'Provide between 2 and 6 team keys');
      }
      try {
        return await getTeamComparison(event_key, teams);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // Python surfaces ValueError through raise_api_error -> 500 fallback.
        raiseApiError(e, 'Could not compare the requested teams.');
      }
    },
  );

  // events.py:275 — GET /api/events/{event_key}/clear-cache
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/clear-cache', async (req) => {
    const { event_key } = req.params;
    try {
      getTbaClient().clearCache();
      await payloadCache.invalidate('summary', event_key);
      await payloadCache.invalidate('awards', event_key);
      await invalidateSnapshot(event_key);
      return { status: 'cache cleared' };
    } catch (e) {
      raiseApiError(e, 'Could not clear cache.');
    }
  });

  // events.py:291 — GET /api/events/{event_key}/refresh-rankings
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/refresh-rankings', async (req) => {
    const { event_key } = req.params;
    const client = getTbaClient();
    for (const ep of [
      `/event/${event_key}/rankings`,
      `/event/${event_key}/oprs`,
      `/event/${event_key}/teams`,
    ]) {
      client.clearCacheEntry(ep);
    }
    try {
      return await getEventTeamsWithStats(event_key);
    } catch (e) {
      raiseApiError(e, `Could not refresh rankings for event '${event_key}'.`);
    }
  });

  // events.py:308 — GET /api/events/{event_key}/fast-rankings
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/fast-rankings', async (req) => {
    const { event_key } = req.params;
    try {
      return await getFastRankings(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load rankings for event '${event_key}'.`);
    }
  });

  // events.py:399 — GET /api/events/{event_key}/gatool-updates
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/gatool-updates', async (req) => {
    const { event_key } = req.params;
    try {
      const year = Number(event_key.slice(0, 4));
      let eventCode = event_key.slice(4);
      // Strip an "ftc" prefix for FTC event keys ("ftcTRTUQ1" → "TRTUQ1").
      if (eventCode.toLowerCase().startsWith('ftc')) eventCode = eventCode.slice(3);
      return await getGatoolClient().getEventCommunityUpdates(year, eventCode);
    } catch (e) {
      raiseApiError(e, `Could not load GATool updates for event '${event_key}'.`);
    }
  });

  // events.py:423 — GET /api/events/{event_key}/notes
  app.get<{
    Params: EventKeyParams;
    Querystring: { team_key?: string; match_key?: string; category?: string; sort?: string };
  }>('/api/events/:event_key/notes', async (req) => {
    const { event_key } = req.params;
    const sortParam = req.query.sort;
    if (sortParam !== undefined && sortParam !== 'asc' && sortParam !== 'desc') {
      throw new ApiError(400, "sort must be 'asc' or 'desc'.");
    }
    try {
      let q = getSupabase()
        .from('notes')
        .select('*')
        .eq('event_key', event_key)
        .eq('is_deleted', false)
        .order('created_at', { ascending: sortParam === 'asc' });
      if (req.query.team_key) q = q.eq('team_key', req.query.team_key);
      if (req.query.match_key) q = q.eq('match_key', req.query.match_key);
      if (req.query.category) q = q.eq('category', req.query.category);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data ?? [];
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, `Could not load notes for event '${event_key}'.`);
    }
  });

  // events.py:341 — GET /api/events/regional-pool/{season}
  app.get<{ Params: { season: string } }>('/api/events/regional-pool/:season', async (req) => {
    const season = Number(req.params.season);
    if (!Number.isInteger(season)) throw new ApiError(400, 'Invalid season');
    try {
      const teams = await getFrcClient().getRegionalPool(season);
      return { season, teams };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, `Could not load regional pool for season ${season}.`);
    }
  });

  // events.py:353 — GET /api/events/regional-pool/{season}/{event_code}
  app.get<{ Params: { season: string; event_code: string } }>(
    '/api/events/regional-pool/:season/:event_code',
    async (req) => {
      const season = Number(req.params.season);
      const { event_code } = req.params;
      if (!Number.isInteger(season)) throw new ApiError(400, 'Invalid season');
      try {
        return await getFrcClient().getRegionalPoolEvent(season, event_code);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load regional pool for event '${event_code}'.`);
      }
    },
  );

  // events.py:368 — GET /api/events/region/{region_name}/facts
  app.get<{ Params: { region_name: string } }>(
    '/api/events/region/:region_name/facts',
    async (req) => {
      const { region_name } = req.params;
      const data = await getRegionFacts(region_name);
      if (!data) {
        throw new ApiError(404, `No data for region: ${region_name}`);
      }
      return data;
    },
  );

  // events.py:377 — GET /api/events/regions/list
  app.get('/api/events/regions/list', async () => {
    try {
      return await listRegions();
    } catch (e) {
      raiseApiError(e, 'Could not load regions list.');
    }
  });

  // events.py:388 — GET /api/events/{event_key}/history
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/history', async (req) => {
    const { event_key } = req.params;
    try {
      return await getEventHistory(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load history for event '${event_key}'.`);
    }
  });

  // snapshot.py:163 — GET /api/events/{event_key}/snapshot
  app.get<{ Params: EventKeyParams }>('/api/events/:event_key/snapshot', async (req) => {
    const { event_key } = req.params;
    try {
      return await getEventSnapshot(event_key);
    } catch (e) {
      raiseApiError(e, `Could not build snapshot for '${event_key}'.`);
    }
  });
}

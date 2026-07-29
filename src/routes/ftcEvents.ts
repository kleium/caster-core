/**
 * FTC event read routes — port of the corresponding handlers in
 * backend/app/routers/ftc_events.py (mounted at /api/ftc/events).
 */
import type { FastifyInstance } from 'fastify';

import {
  getEventInfo,
  getEventTeamsWithStats,
  getSeasonEvents,
  getFastRankings,
  getFtcWorldRecord,
  getTeamOprHistory,
} from '../services/ftcEventService.js';
import { getFtcClient } from '../services/ftcClient.js';
import { getGatoolClient } from '../services/gatoolClient.js';
import { getFtcscoutClient } from '../services/ftcscoutClient.js';
import { getTeamLookup } from '../services/ftcTeamLookupService.js';
import {
  getFtcEventConnections,
  getFtcMatchConnections,
} from '../services/ftcConnectionsService.js';
import { getSeasonRecord, setSeasonRecord } from '../services/supabase.js';
import * as payloadCache from '../lib/payloadCache.js';
import { currentFtcSeason } from '../lib/ftcSeason.js';
import { pyGet, pyOr } from '../lib/pysemantics.js';
import {
  getFtcTeamAwardsSummary,
  getEventAwards,
  getFtcPastSeasonAwards,
  getFtcCurrentSeasonAwards,
} from '../services/ftcAwardsService.js';
import { getFtcEventSnapshot } from '../services/ftcSnapshotService.js';
import { raiseApiError } from '../lib/apiError.js';
import { ApiError } from '../plugins/errorEnvelope.js';

const AVATAR_CSS_URL = 'https://ftc-scoring.firstinspires.org/avatars/composed/{year}.css';
const avatarCssCache = new Map<number, string>();

type Obj = Record<string, any>;

interface EventKeyParams {
  event_key: string;
}

export function registerFtcEventRoutes(app: FastifyInstance): void {
  // ftc_events.py:189 — GET /api/ftc/events/{event_key}/info
  app.get<{ Params: EventKeyParams }>('/api/ftc/events/:event_key/info', async (req) => {
    const { event_key } = req.params;
    try {
      return await getEventInfo(event_key);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, `Could not load FTC event info for '${event_key}'.`);
    }
  });

  // ftc_events.py:199 — GET /api/ftc/events/{event_key}/teams
  app.get<{ Params: EventKeyParams }>('/api/ftc/events/:event_key/teams', async (req) => {
    const { event_key } = req.params;
    try {
      return await getEventTeamsWithStats(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load FTC teams for event '${event_key}'.`);
    }
  });

  // ftc_events.py:233 — GET /api/ftc/events/{event_key}/awards
  app.get<{ Params: EventKeyParams }>('/api/ftc/events/:event_key/awards', async (req) => {
    const { event_key } = req.params;
    try {
      return await getEventAwards(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load FTC awards for event '${event_key}'.`);
    }
  });

  // ftc_events.py:244 — GET /api/ftc/events/{event_key}/past-awards
  app.get<{ Params: EventKeyParams }>('/api/ftc/events/:event_key/past-awards', async (req) => {
    const { event_key } = req.params;
    try {
      return await getFtcPastSeasonAwards(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load FTC past awards for event '${event_key}'.`);
    }
  });

  // ftc_events.py:294 — GET /api/ftc/events/{event_key}/season-awards
  app.get<{ Params: EventKeyParams }>('/api/ftc/events/:event_key/season-awards', async (req) => {
    const { event_key } = req.params;
    try {
      return await getFtcCurrentSeasonAwards(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load FTC season awards for event '${event_key}'.`);
    }
  });

  // snapshot.py:277 (ftc_router) — GET /api/ftc/events/{event_key}/snapshot
  app.get<{ Params: EventKeyParams }>('/api/ftc/events/:event_key/snapshot', async (req) => {
    const { event_key } = req.params;
    try {
      return await getFtcEventSnapshot(event_key);
    } catch (e) {
      raiseApiError(e, `Could not build FTC snapshot for '${event_key}'.`);
    }
  });

  // ftc_events.py — GET /api/ftc/events/season/current
  app.get('/api/ftc/events/season/current', async () => {
    return { season: currentFtcSeason() };
  });

  // ftc_events.py — GET /api/ftc/events/season/{year}
  app.get<{ Params: { year: string }; Querystring: { include_offseason?: string } }>(
    '/api/ftc/events/season/:year',
    async (req) => {
      const year = Number(req.params.year);
      if (!Number.isInteger(year)) throw new ApiError(400, 'Invalid year');
      const includeOffseason = ['true', '1'].includes(
        (req.query.include_offseason ?? '').toLowerCase(),
      );
      try {
        return await getSeasonEvents(year, includeOffseason);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load FTC season ${year} events.`);
      }
    },
  );

  // ftc_events.py — GET /api/ftc/events/season/{year}/summary
  app.get<{ Params: { year: string } }>('/api/ftc/events/season/:year/summary', async (req) => {
    const year = Number(req.params.year);
    if (!Number.isInteger(year)) throw new ApiError(400, 'Invalid year');
    try {
      return await getFtcClient().getSeasonSummary(year);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, `Could not load FTC season ${year} summary.`);
    }
  });

  // ftc_events.py — GET /api/ftc/events/{event_key}/fast-rankings
  app.get<{ Params: EventKeyParams }>('/api/ftc/events/:event_key/fast-rankings', async (req) => {
    const { event_key } = req.params;
    try {
      return await getFastRankings(event_key);
    } catch (e) {
      raiseApiError(e, `Could not load FTC rankings for event '${event_key}'.`);
    }
  });

  // ftc_events.py — GET /api/ftc/events/{event_key}/refresh-rankings
  app.get<{ Params: EventKeyParams }>(
    '/api/ftc/events/:event_key/refresh-rankings',
    async (req) => {
      // Python does NOT wrap this one in try/except — errors surface as 500s.
      getFtcClient().clearCache();
      return await getEventTeamsWithStats(req.params.event_key);
    },
  );

  // ftc_events.py — GET /api/ftc/events/{event_key}/clear-cache
  app.get<{ Params: EventKeyParams }>('/api/ftc/events/:event_key/clear-cache', async () => {
    getFtcClient().clearCache();
    return { status: 'FTC cache cleared' };
  });

  // ftc_events.py — GET /api/ftc/events/{event_key}/gatool-updates
  app.get<{ Params: EventKeyParams }>('/api/ftc/events/:event_key/gatool-updates', async (req) => {
    const { event_key } = req.params;
    try {
      const year = Number(event_key.slice(0, 4));
      let eventCode = event_key.slice(4);
      if (eventCode.toLowerCase().startsWith('ftc')) eventCode = eventCode.slice(3);
      return await getGatoolClient().getFtcEventCommunityUpdates(year, eventCode);
    } catch (e) {
      raiseApiError(e, `Could not load GATool updates for FTC event '${event_key}'.`);
    }
  });

  // ftc_events.py — GET /api/ftc/events/avatar-css/{year}
  // Proxies the FTC scoring server's avatar sprite CSS, which serves no CORS
  // headers of its own. Returns text/css, not JSON.
  app.get<{ Params: { year: string } }>('/api/ftc/events/avatar-css/:year', async (req, reply) => {
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 2019 || year > 2030) {
      throw new ApiError(400, 'Invalid year');
    }
    const cached = avatarCssCache.get(year);
    if (cached !== undefined) {
      reply.header('Cache-Control', 'public, max-age=86400').type('text/css; charset=utf-8');
      return cached;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let text: string;
      try {
        const resp = await fetch(AVATAR_CSS_URL.replace('{year}', String(year)), {
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        text = await resp.text();
      } finally {
        clearTimeout(timer);
      }
      avatarCssCache.set(year, text);
      reply.header('Cache-Control', 'public, max-age=86400').type('text/css; charset=utf-8');
      return text;
    } catch (e) {
      throw new ApiError(502, `Could not fetch FTC avatar CSS: ${String(e)}`);
    }
  });

  // ftc_events.py — GET /api/ftc/events/world-record/{season}
  app.get<{ Params: { season: string } }>('/api/ftc/events/world-record/:season', async (req) => {
    const season = Number(req.params.season);
    if (!Number.isInteger(season)) throw new ApiError(400, 'Invalid season');
    try {
      const result = await getFtcWorldRecord(season);
      if (!result) throw new ApiError(404, 'No FTC world record found.');
      return result;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, `Could not load FTC world record for season ${season}.`);
    }
  });

  // ftc_events.py — GET /api/ftc/events/team/{team_number}/opr-history
  app.get<{ Params: { team_number: string }; Querystring: { season?: string } }>(
    '/api/ftc/events/team/:team_number/opr-history',
    async (req) => {
      const teamNumber = Number(req.params.team_number);
      if (!Number.isInteger(teamNumber)) throw new ApiError(400, 'Invalid team number');
      const season = req.query.season !== undefined ? Number(req.query.season) : currentFtcSeason();
      try {
        return await getTeamOprHistory(teamNumber, season);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load OPR history for FTC team ${teamNumber}.`);
      }
    },
  );

  // ftc_events.py — GET /api/ftc/events/teams/awards-summary
  app.get<{ Querystring: { teams?: string } }>(
    '/api/ftc/events/teams/awards-summary',
    async (req) => {
      const teamsParam = req.query.teams;
      if (typeof teamsParam !== 'string') throw new ApiError(400, 'Provide 1-12 team numbers');
      const parts = teamsParam.split(',').map((t) => t.trim()).filter(Boolean);
      const nums: number[] = [];
      for (const p of parts) {
        if (!/^[+-]?\d+$/.test(p)) throw new ApiError(400, 'Invalid team numbers');
        nums.push(Number(p));
      }
      if (!nums.length || nums.length > 12) throw new ApiError(400, 'Provide 1-12 team numbers');
      try {
        return await getFtcTeamAwardsSummary(nums);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, 'Could not load FTC awards summary.');
      }
    },
  );

  // ftc_events.py — GET /api/ftc/events/season/high-scores
  app.get<{ Querystring: { season?: string; limit?: string } }>(
    '/api/ftc/events/season/high-scores',
    async (req) => {
      const season =
        req.query.season !== undefined ? Number(req.query.season) : currentFtcSeason();
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
        throw new ApiError(400, 'limit must be between 1 and 25');
      }
      const cacheKey = `${season}_${limit}`;

      // Build the valid competition event-code set. getSeasonEvents already
      // drops non-competition types, so the result doubles as a scrimmage
      // allowlist AND the event-name lookup.
      const eventNames: Record<string, string> = {};
      const validEventCodes = new Set<string>();
      try {
        const events = await getSeasonEvents(season);
        for (const ev of events) {
          const code = String(pyOr(ev.event_code, pyOr(ev.code, ''))).toLowerCase();
          if (code) {
            validEventCodes.add(code);
            eventNames[code] = String(pyOr(ev.name, pyOr(ev.event_name, code)));
          }
        }
      } catch {
        /* degrade gracefully — filtering is skipped if events are unavailable */
      }

      const filterScrimmages = (data: Obj): Obj => {
        if (!validEventCodes.size) return data;
        data.matches = ((data.matches ?? []) as Obj[])
          .filter((m) => validEventCodes.has(String(pyGet(m, 'event_code', '')).toLowerCase()))
          .slice(0, limit);
        return data;
      };

      try {
        // 1. Disk cache
        const cached = await payloadCache.readPayload('ftc_season_high', cacheKey, 600);
        if (cached) return filterScrimmages({ ...cached });

        const stale = await payloadCache.readStale('ftc_season_high', cacheKey);

        // 2. Supabase
        const sbRow = await getSeasonRecord(`ftc_season_high_${season}_${limit}`);
        if (sbRow?.payload) {
          const sbPayload = { ...(sbRow.payload as Obj) };
          sbPayload.matches = [...((sbPayload.matches ?? []) as Obj[])];
          // Enrich event_name when still raw (row predates enrichment, or CMP
          // subdivisions were missing from the static season file).
          const anyRaw = (sbPayload.matches as Obj[]).some(
            (m) => m.event_name === m.event_code,
          );
          if (Object.keys(eventNames).length && anyRaw) {
            for (const m of sbPayload.matches as Obj[]) {
              const c = String(pyGet(m, 'event_code', '')).toLowerCase();
              if (c && eventNames[c]) m.event_name = eventNames[c];
            }
          }
          filterScrimmages(sbPayload);
          await payloadCache.writePayload('ftc_season_high', cacheKey, sbPayload);
          return sbPayload;
        }

        // 3. Live FTC Scout fetch
        try {
          const data = await getFtcscoutClient().getSeasonHighScores(season, limit);
          for (const m of (data.matches ?? []) as Obj[]) {
            const code = String(pyGet(m, 'event_code', '')).toLowerCase();
            if (code && code in eventNames) m.event_name = eventNames[code];
          }
          // Filter before persisting so the caches stay clean.
          filterScrimmages(data);
          await payloadCache.writePayload('ftc_season_high', cacheKey, data);
          void setSeasonRecord(
            `ftc_season_high_${season}_${limit}`,
            season,
            'ftc_season_high_scores',
            data,
          );
          return data;
        } catch (e) {
          if (stale) return filterScrimmages({ ...stale });
          throw e;
        }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load FTC season high scores for ${season}.`);
      }
    },
  );

  // ftc_events.py — GET /api/ftc/events/team/{team_number}
  app.get<{ Params: { team_number: string }; Querystring: { season?: string } }>(
    '/api/ftc/events/team/:team_number',
    async (req) => {
      const teamNumber = Number(req.params.team_number);
      if (!Number.isInteger(teamNumber)) throw new ApiError(400, 'Invalid team number');
      const season = req.query.season !== undefined ? Number(req.query.season) : currentFtcSeason();
      try {
        return await getTeamLookup(teamNumber, season);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        raiseApiError(e, `Could not load FTC team ${teamNumber}.`);
      }
    },
  );

  // ftc_events.py — GET /api/ftc/events/{event_key}/summary/connections
  app.get<{
    Params: EventKeyParams;
    Querystring: { all_time?: string; teams?: string };
  }>('/api/ftc/events/:event_key/summary/connections', async (req) => {
    const { event_key } = req.params;
    const allTime = ['true', '1'].includes((req.query.all_time ?? '').toLowerCase());
    const teamsParam = req.query.teams;
    try {
      if (teamsParam) {
        const teamNumbers = teamsParam
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => Number(t));
        return await getFtcMatchConnections(event_key, teamNumbers, allTime);
      }
      return await getFtcEventConnections(event_key, allTime);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      raiseApiError(e, `Could not load FTC connections for event '${event_key}'.`);
    }
  });
}

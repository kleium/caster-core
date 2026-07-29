/**
 * AI broadcast storylines — caching + LLM orchestration half of
 * backend/app/services/storyline_service.py. Dossier assembly lives in
 * storylineDossier.ts.
 */
import Anthropic from '@anthropic-ai/sdk';

import { ANTHROPIC_API_KEY } from '../config.js';
import { coalesce } from '../lib/inflight.js';
import { MATCH_SYSTEM_PROMPT, TEAM_SYSTEM_PROMPT, LLM_MODEL } from '../lib/storylinePrompts.js';
import { getTbaClient } from './tbaClient.js';
import { getSupabase } from './supabase.js';
import { assembleMatchDossier, assembleTeamDossier } from './storylineDossier.js';

type Obj = Record<string, any>;

export interface StorylineParams {
  mode: 'match' | 'team';
  event_key: string;
  match_key?: string | null;
  team_number?: number | null;
}

// ── In-memory cache: key → {ts, result} ─────────────────────
const CACHE_TTL_MS = 7_200_000; // 2 hours (fallback when match count unchanged)
const cache = new Map<string, { ts: number; result: Obj }>();

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (anthropicClient === null) {
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

export function isAvailable(): boolean {
  return Boolean(ANTHROPIC_API_KEY);
}

async function safe<T>(promise: Promise<T>, dflt: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return dflt;
  }
}

function cacheKeyFor(mode: string, eventKey: string, matchKey?: string | null, teamNumber?: number | null): string | null {
  if (mode === 'match' && matchKey) return `match:${matchKey}`;
  if (mode === 'team' && teamNumber) return `team:${eventKey}:${teamNumber}`;
  return null;
}

function makeResponse(
  storyline: string,
  opts: {
    cached: boolean;
    generatedAt?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    matchCount?: number | null;
    model?: string | null;
  },
): Obj {
  return {
    content: { storyline },
    meta: {
      cached: opts.cached,
      generated_at: opts.generatedAt ?? null,
      input_tokens: opts.inputTokens ?? null,
      output_tokens: opts.outputTokens ?? null,
      match_count: opts.matchCount ?? null,
      model: opts.model ?? null,
    },
    // Legacy compat — web frontend reads these flat keys.
    storyline,
    cached: opts.cached,
  };
}

/** Current match count for event-aware invalidation. storyline_service.py:849. */
async function getEventMatchCount(eventKey: string): Promise<number | null> {
  try {
    const tba = getTbaClient();
    const matches = await safe(tba.getEventMatches<Obj[]>(eventKey), []);
    if (matches?.length) {
      return matches.filter((m) => m.actual_time !== null && m.actual_time !== undefined).length;
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function loadFromSupabase(cacheKey: string): Promise<Obj | null> {
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('storyline_cache')
      .select('storyline, match_count, input_tokens, output_tokens, updated_at')
      .eq('cache_key', cacheKey);
    if (error) throw new Error(error.message);
    return data && data.length ? data[0]! : null;
  } catch {
    return null;
  }
}

async function saveToSupabase(
  cacheKey: string,
  eventKey: string,
  storyline: string,
  matchCount: number | null,
  inputTokens: number | null,
  outputTokens: number | null,
): Promise<void> {
  try {
    const sb = getSupabase();
    const { error } = await sb.from('storyline_cache').upsert(
      {
        cache_key: cacheKey,
        event_key: eventKey,
        storyline,
        match_count: matchCount,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
      { onConflict: 'cache_key' },
    );
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn(`Supabase storyline save failed for ${cacheKey}: ${String(e)}`);
  }
}

function buildUserMessage(dossier: string): string {
  return (
    `Generate a storyline based on this dossier:\n\n${dossier}\n\n` +
    "IMPORTANT REMINDER: Do not use the words 'powerhouse', 'proving', " +
    "'showcasing', 'demonstrating', or 'statement'. " +
    'Write like a newspaper beat reporter — factual and vivid.'
  );
}

/** Core generation logic — called via inflight coalescing. storyline_service.py:900. */
async function generateStorylineInner(
  cacheKey: string,
  mode: 'match' | 'team',
  eventKey: string,
  matchKey: string | null | undefined,
  teamNumber: number | null | undefined,
): Promise<Obj> {
  const now = Date.now();
  const nowIso = new Date().toISOString();

  // ── Layer 1: in-memory cache with event-aware invalidation ──
  const memHit = cache.get(cacheKey);
  if (memHit) {
    const age = now - memHit.ts;
    if (age < CACHE_TTL_MS) {
      const mc = memHit.result.meta?.match_count;
      if (mode === 'team' && age > 300_000) {
        const currentCount = await getEventMatchCount(eventKey);
        if (currentCount !== null && mc !== null && mc !== undefined) {
          if (currentCount === mc) return memHit.result;
          // else: fall through to regenerate — match count changed.
        } else {
          return memHit.result;
        }
      } else {
        return memHit.result;
      }
    }
  }

  // ── Layer 2: Supabase persistent cache (source of truth) ──
  const sbRow = await loadFromSupabase(cacheKey);
  if (sbRow) {
    const sbMc = sbRow.match_count;
    const currentCount = await getEventMatchCount(eventKey);
    if (sbMc !== null && sbMc !== undefined && currentCount === sbMc) {
      const result = makeResponse(sbRow.storyline, {
        cached: true,
        generatedAt: sbRow.updated_at,
        inputTokens: sbRow.input_tokens,
        outputTokens: sbRow.output_tokens,
        matchCount: sbMc,
        model: LLM_MODEL,
      });
      cache.set(cacheKey, { ts: now, result });
      return result;
    }
  }

  // ── Layer 3: generate fresh ──
  const matchCount = await getEventMatchCount(eventKey);

  const dossier =
    mode === 'match' ? await assembleMatchDossier(eventKey, matchKey!) : await assembleTeamDossier(eventKey, teamNumber!);
  const systemPrompt = mode === 'match' ? MATCH_SYSTEM_PROMPT : TEAM_SYSTEM_PROMPT;

  if (!dossier) {
    return makeResponse('No data available for this storyline.', { cached: false });
  }

  const client = getClient();
  const userMsg = buildUserMessage(dossier);

  let inTok: number | null = null;
  let outTok: number | null = null;
  let storyline: string;
  try {
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });
    const block = response.content[0];
    storyline = block && block.type === 'text' ? block.text.trim() : '';
    if (response.usage) {
      inTok = response.usage.input_tokens ?? null;
      outTok = response.usage.output_tokens ?? null;
    }
  } catch (e) {
    throw new Error(`AI service error: ${String(e)}`);
  }

  await saveToSupabase(cacheKey, eventKey, storyline, matchCount, inTok, outTok);

  const result = makeResponse(storyline, {
    cached: false,
    generatedAt: nowIso,
    inputTokens: inTok,
    outputTokens: outTok,
    matchCount,
    model: LLM_MODEL,
  });
  cache.set(cacheKey, { ts: now, result });
  return result;
}

/** Generate an AI storyline (full, non-streamed response). storyline_service.py:789. */
export async function generateStoryline(params: StorylineParams): Promise<Obj> {
  if (!isAvailable()) throw new Error('Anthropic API key not configured');

  const cacheKey = cacheKeyFor(params.mode, params.event_key, params.match_key, params.team_number);
  if (!cacheKey) throw new RangeError('Invalid mode or missing parameters');

  return coalesce(
    `storyline:${cacheKey}`,
    generateStorylineInner as never,
    cacheKey as never,
    params.mode as never,
    params.event_key as never,
    params.match_key as never,
    params.team_number as never,
  );
}

function sseFrame(event: string, data: unknown): Buffer {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, 'utf-8');
}

/**
 * SSE generator — yields storyline tokens as they arrive. storyline_service.py:1010.
 *
 * Events: start {cache_key, cached} · token {text} · done {full response} ·
 * error {detail}. If cached, emits start(cached=true) then done immediately.
 */
export async function* generateStorylineStream(params: StorylineParams): AsyncGenerator<Buffer> {
  if (!isAvailable()) {
    yield sseFrame('error', { detail: 'Anthropic API key not configured' });
    return;
  }

  const { mode, event_key: eventKey, match_key: matchKey, team_number: teamNumber } = params;
  const cacheKey = cacheKeyFor(mode, eventKey, matchKey, teamNumber);
  if (!cacheKey) {
    yield sseFrame('error', { detail: 'Invalid mode or missing parameters' });
    return;
  }

  // Check caches first — if hit, skip streaming.
  const now = Date.now();
  const memHit = cache.get(cacheKey);
  if (memHit && now - memHit.ts < CACHE_TTL_MS) {
    yield sseFrame('start', { cache_key: cacheKey, cached: true });
    yield sseFrame('done', memHit.result);
    return;
  }

  const sbRow = await loadFromSupabase(cacheKey);
  if (sbRow) {
    const sbMc = sbRow.match_count;
    const currentCount = await getEventMatchCount(eventKey);
    if (sbMc !== null && sbMc !== undefined && currentCount === sbMc) {
      const result = makeResponse(sbRow.storyline, {
        cached: true,
        generatedAt: sbRow.updated_at,
        inputTokens: sbRow.input_tokens,
        outputTokens: sbRow.output_tokens,
        matchCount: sbMc,
        model: LLM_MODEL,
      });
      cache.set(cacheKey, { ts: now, result });
      yield sseFrame('start', { cache_key: cacheKey, cached: true });
      yield sseFrame('done', result);
      return;
    }
  }

  // ── Fresh generation with token streaming ──
  yield sseFrame('start', { cache_key: cacheKey, cached: false });

  const matchCount = await getEventMatchCount(eventKey);

  const dossier =
    mode === 'match' ? await assembleMatchDossier(eventKey, matchKey!) : await assembleTeamDossier(eventKey, teamNumber!);
  const systemPrompt = mode === 'match' ? MATCH_SYSTEM_PROMPT : TEAM_SYSTEM_PROMPT;

  if (!dossier) {
    const empty = makeResponse('No data available for this storyline.', { cached: false });
    yield sseFrame('done', empty);
    return;
  }

  const client = getClient();
  const userMsg = buildUserMessage(dossier);

  try {
    const chunks: string[] = [];
    const stream = client.messages.stream({
      model: LLM_MODEL,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const text = event.delta.text;
        chunks.push(text);
        yield sseFrame('token', { text });
      }
    }

    const storyline = chunks.join('').trim();
    const finalMsg = await stream.finalMessage();
    const inTok = finalMsg.usage?.input_tokens ?? null;
    const outTok = finalMsg.usage?.output_tokens ?? null;

    await saveToSupabase(cacheKey, eventKey, storyline, matchCount, inTok, outTok);

    const nowIso = new Date().toISOString();
    const result = makeResponse(storyline, {
      cached: false,
      generatedAt: nowIso,
      inputTokens: inTok,
      outputTokens: outTok,
      matchCount,
      model: LLM_MODEL,
    });
    cache.set(cacheKey, { ts: Date.now(), result });
    yield sseFrame('done', result);
  } catch (e) {
    yield sseFrame('error', { detail: String(e instanceof Error ? e.message : e) });
  }
}

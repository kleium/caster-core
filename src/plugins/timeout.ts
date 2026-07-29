/**
 * Hard request-timeout guard — port of TimeoutMiddleware in
 * backend/app/main.py:210-230. Caps any /api/* request at 90s and returns a
 * 504 with the {detail} envelope.
 *
 * Fastify has no built-in way to abort an in-flight handler — a JS Promise
 * can't be cancelled — so we arm a timer on each request and, if it fires
 * first, send the 504 ourselves and call `reply.hijack()`. Hijacking is the
 * required step: without it, Fastify's async-handler wrapper still calls
 * `reply.send(returnValue)` when the original (still-running) handler
 * eventually resolves, and `Reply.send()` throws synchronously on an
 * already-sent reply — an `onSend` hook alone never gets a chance to run,
 * since the throw happens before the send pipeline. The late-resolving
 * handler keeps consuming resources in the background either way (Node
 * cannot cancel it), so hijacking only stops the crash, not the wasted work
 * — the real fix for that is call sites bounding their own upstream fan-out.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const REQUEST_TIMEOUT_MS = 90_000;

const TIMER = Symbol('timeoutTimer');

interface TimedRequest extends FastifyRequest {
  [TIMER]?: NodeJS.Timeout;
}

export function registerTimeout(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: TimedRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (!path.startsWith('/api/')) return;

    request[TIMER] = setTimeout(() => {
      if (reply.sent) return;
      request.log.warn(`Request timed out: ${request.method} ${path}`);
      reply.hijack(); // tell Fastify the late handler's eventual return must be ignored
      reply.code(504).send({
        detail:
          'The request took too long to complete. The upstream data sources ' +
          'may be slow — please try again.',
      });
    }, REQUEST_TIMEOUT_MS);
  });

  app.addHook('onResponse', async (request: TimedRequest) => {
    if (request[TIMER]) clearTimeout(request[TIMER]);
  });
}

/**
 * Uniform error envelope — every non-2xx response is
 * `{ detail, retry_after }`, matching what the frontend reads
 * (docs/js/api.js:23-24,47). Ports FastAPI's HTTPException detail contract and
 * the 404 shape.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Thrown by route handlers to produce a specific status + detail (like HTTPException). */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly retryAfter: number | null;
  constructor(statusCode: number, detail: string, retryAfter: number | null = null) {
    super(detail);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

export function registerErrorEnvelope(app: FastifyInstance): void {
  // FastAPI's HTTPException bodies are `{"detail": "..."}` ONLY — retry_after is
  // added exclusively by the inbound rate limiter (which sends its own 429 body,
  // see plugins/rateLimit.ts). So general errors here emit just `{ detail }`.
  app.setErrorHandler((err: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) => {
    const isApiError = err instanceof ApiError;
    const status = isApiError ? err.statusCode : (err as FastifyError).statusCode ?? 500;

    if (status >= 500) {
      request.log.error(err);
    }

    // ApiError already carries FastAPI's user-facing detail (incl. 500 fallbacks
    // from raiseApiError). Truly unexpected 500s fall back to Starlette's text.
    let detail: string;
    if (isApiError) detail = err.message;
    else if (status >= 500) detail = 'Internal Server Error';
    else detail = err.message || 'Request failed.';

    reply.code(status).send({ detail });
  });

  // Starlette's default 404 body is `{"detail":"Not Found"}`; match it byte-for-byte.
  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({ detail: 'Not Found' });
  });
}

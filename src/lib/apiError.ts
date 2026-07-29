/**
 * Error translation — port of backend/app/services/error_utils.py.
 *
 * Maps upstream/HTTP failures to an ApiError carrying the exact status code and
 * user-facing `detail` the FastAPI backend would produce, so the frontend's
 * `{ detail, retry_after }` contract is preserved on the error path too.
 */
import { ApiError } from '../plugins/errorEnvelope.js';
import { CircuitOpenError } from './circuitBreaker.js';
import { HttpStatusError } from './http.js';

const SOURCE_LABELS: Array<[string, string]> = [
  ['thebluealliance.com', 'The Blue Alliance (TBA)'],
  ['frc-api.firstinspires.org', 'FRC Events API'],
  ['api.statbotics.io', 'Statbotics'],
  ['api.gatool.org', 'GATool'],
];

function identifySource(err: unknown): string {
  const url = err instanceof HttpStatusError ? err.url : '';
  for (const [domain, label] of SOURCE_LABELS) {
    if (url.includes(domain)) return label;
  }
  return 'the upstream data source';
}

/** Throws an ApiError mirroring raise_api_error(). Return type `never`. */
export function raiseApiError(err: unknown, fallbackDetail = ''): never {
  if (err instanceof CircuitOpenError) {
    throw new ApiError(503, String(err.message));
  }

  if (err instanceof HttpStatusError) {
    const source = identifySource(err);
    const status = err.statusCode;
    if (status === 404) {
      throw new ApiError(
        404,
        `Resource not found on ${source}. The event key or team number may be invalid.`,
      );
    }
    if (status === 401 || status === 403) {
      throw new ApiError(
        502,
        `Authentication error with ${source}. The server's API key may be invalid or expired.`,
      );
    }
    if (status === 429) {
      throw new ApiError(429, `${source} rate limit reached. Please wait a moment and try again.`);
    }
    if (status >= 500 && status < 600) {
      throw new ApiError(
        502,
        `${source} is currently experiencing issues (HTTP ${status}). Please try again shortly.`,
      );
    }
    throw new ApiError(502, `${source} returned an error (HTTP ${status}). Please try again.`);
  }

  // ── Network-level failures ────────────────────────────────
  // Python distinguishes httpx.TimeoutException (504) from httpx.RequestError
  // (502). The JS equivalents are an AbortError from our timeout controller,
  // and undici's `TypeError: fetch failed` for DNS/connection failures.
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    throw new ApiError(
      504,
      `Request to ${identifySource(err)} timed out. The service may be slow or unreachable.`,
    );
  }
  if (err instanceof TypeError && /fetch failed|network|ECONN|ENOTFOUND|socket/i.test(err.message)) {
    throw new ApiError(502, `Could not connect to ${identifySource(err)}. The service may be down.`);
  }

  // Validation errors → 400 with the message. Python catches
  // (ValueError, TypeError, KeyError); services here raise RangeError for the
  // ValueError cases. A bare TypeError is deliberately NOT mapped to 400 —
  // in JS that usually signals a genuine bug (or a network failure, handled
  // above), and reporting it as a client error would hide it.
  if (err instanceof RangeError) {
    throw new ApiError(400, err.message || fallbackDetail || 'Invalid request parameters.');
  }

  // Catch-all → 500 with the fallback message.
  throw new ApiError(
    500,
    fallbackDetail || 'An unexpected error occurred while fetching data. Please try again.',
  );
}

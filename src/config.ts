/**
 * Environment configuration — mirrors backend/app/config.py.
 *
 * Uses the SAME variable names as the FastAPI backend so a single .env drives
 * both during the strangler migration.
 */
import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    // Mirrors config.py:11 — TBA_API_KEY is mandatory; refuse to start without it.
    throw new Error(
      `${name} environment variable is not set. ` +
        `Create a .env file with ${name}=your_key`,
    );
  }
  return v;
}

// Blue Alliance API key — required (config.py:10-15).
export const BLUE_ALLIANCE_API_KEY = required('TBA_API_KEY');

// Trusted API keys — comma-separated, bypass/raise rate limits (config.py:19-23).
export const TRUSTED_API_KEYS: ReadonlySet<string> = new Set(
  (process.env.TRUSTED_API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean),
);

// FIRST FRC Events API token (Base64 "username:authkey"), config.py:27.
export const FRC_EVENTS_API_TOKEN = process.env.FRC_EVENTS_API_TOKEN ?? '';

// FIRST FTC Events API token, config.py:31.
export const FTC_EVENTS_API_TOKEN = process.env.FTC_EVENTS_API_TOKEN ?? '';

// Anthropic key for AI storylines (optional), config.py:35.
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';

// Supabase (config.py:41-43).
export const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? '';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';

// ── Node-backend-specific ──────────────────────────────────
export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? '0.0.0.0';

// Where unported routes are proxied during the migration.
export const FASTAPI_UPSTREAM =
  process.env.FASTAPI_UPSTREAM ?? 'http://127.0.0.1:8000';

// Workers run only when Supabase is configured and not explicitly disabled
// (matches main.py:45-47).
export const WORKERS_ENABLED = Boolean(SUPABASE_URL) && !process.env.DISABLE_WORKERS;

// M1 helper: comma-separated event keys to seed as "active" on startup.
// In the full system, event_sync (not yet ported) discovers ongoing events and
// calls setActiveEvents(); until then this lets you point the poller at a live
// event for verification, e.g. POLL_EVENTS=2026tuak.
export const POLL_EVENTS: string[] = (process.env.POLL_EVENTS ?? '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

// Same idea, for the FTC poller — active-event discovery lands in M4b
// (ftc_event_sync port); until then this seeds watched FTC events for testing,
// e.g. POLL_FTC_EVENTS=2025ftcaz.
export const POLL_FTC_EVENTS: string[] = (process.env.POLL_FTC_EVENTS ?? '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

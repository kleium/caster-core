/**
 * Verified identity from a Supabase access token.
 *
 * Deliberately NOT the same as `passkeyService.extractUserIdFromToken`, which
 * base64-decodes the payload without checking the signature (a behaviour ported
 * verbatim from the Python original for parity). Decoding is fine when the
 * claim is only used to look something up; it is not fine when the claim
 * becomes stored, displayed data — anyone could hand us a hand-written token
 * and pick their own name on a note.
 *
 * So this module verifies HS256 against SUPABASE_JWT_SECRET and checks expiry.
 * It is additive: no existing route's behaviour changes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SUPABASE_JWT_SECRET } from '../config.js';

export interface Identity {
  userId: string;
  /** Best available human label — a display name if set, else the email. */
  displayName: string;
}

function b64urlJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
}

/**
 * Returns the caller's identity, or null when there is no usable token.
 *
 * Null rather than throwing: these endpoints are open by design (the iOS client
 * and the sync path call them without a session), so an absent or bad token
 * means "anonymous", not "reject the request".
 */
export function verifySessionToken(authorization: string | undefined): Identity | null {
  if (!authorization || !SUPABASE_JWT_SECRET) return null;

  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  try {
    if (b64urlJson(header).alg !== 'HS256') return null;

    const expected = createHmac('sha256', SUPABASE_JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    // timingSafeEqual throws on length mismatch, so guard first.
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    const claims = b64urlJson(payload);
    const exp = typeof claims.exp === 'number' ? claims.exp : 0;
    if (!exp || exp * 1000 <= Date.now()) return null;

    const userId = typeof claims.sub === 'string' ? claims.sub : '';
    if (!userId) return null;

    const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
    const named = [meta.full_name, meta.name, claims.email].find(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    );

    return { userId, displayName: named ?? 'Unknown' };
  } catch {
    return null;
  }
}

/**
 * Passkey (WebAuthn) — register/authenticate via platform authenticators.
 * Port of backend/app/routers/passkey.py.
 *
 * Uses @simplewebauthn/server (JS analogue of the `webauthn` Python package)
 * plus direct REST calls to Supabase's GoTrue admin API (service-role key) —
 * mirrored 1:1 from the Python httpx calls rather than routed through
 * supabase-js's `auth.admin.*` wrapper, since the exact ILIKE-filter/
 * exact-match-verification behavior documented in `_get_user_by_email` below
 * is proven production behavior worth reproducing exactly rather than trusting
 * a different code path's semantics.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';

import { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY } from '../config.js';
import { ApiError } from '../plugins/errorEnvelope.js';

type Obj = Record<string, any>;

// ── Config ───────────────────────────────────────────────────
const RP_NAME = process.env.PASSKEY_RP_NAME ?? "Caster's Tool";
const RP_ID = process.env.PASSKEY_RP_ID ?? '';
const ORIGIN = process.env.PASSKEY_ORIGIN ?? '';

/**
 * Return [rpId, expectedOrigin]. Env vars win if both set; otherwise derived
 * from the request's Origin header so the app works on any domain without
 * extra config. passkey.py:78.
 */
export function rpConfig(originHeader: string | undefined): [string, string] {
  if (RP_ID && ORIGIN) return [RP_ID, ORIGIN];

  if (originHeader) {
    try {
      const parsed = new URL(originHeader);
      const rpId = parsed.hostname || 'localhost';
      const scheme = parsed.protocol ? parsed.protocol.replace(':', '') : 'https';
      const netloc = parsed.host || 'localhost';
      return [rpId, `${scheme}://${netloc}`];
    } catch {
      /* fall through to last resort */
    }
  }

  return [RP_ID || 'localhost', ORIGIN || 'http://localhost:3000'];
}

// ── In-memory challenge store (TTL = 90s) ───────────────────
interface ChallengeEntry {
  email: string;
  userId: string | null;
  expires: number;
}
const challenges = new Map<string, ChallengeEntry>();
const CHALLENGE_TTL_MS = 90_000;

function pruneChallenges(): void {
  const now = Date.now();
  for (const [k, v] of challenges) {
    if (v.expires < now) challenges.delete(k);
  }
}

function storeChallenge(challenge: string, email = '', userId: string | null = null): void {
  pruneChallenges();
  challenges.set(challenge, { email, userId, expires: Date.now() + CHALLENGE_TTL_MS });
}

function popChallenge(challengeB64url: string): ChallengeEntry | null {
  pruneChallenges();
  const entry = challenges.get(challengeB64url);
  if (!entry) return null;
  challenges.delete(challengeB64url);
  if (entry.expires < Date.now()) return null;
  return entry;
}

// ── Supabase admin REST helpers (service-role) ──────────────
function svcHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

function anonHeaders(): Record<string, string> {
  return { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
}

/**
 * GoTrue's `filter` param does an ILIKE substring match, not an exact
 * PostgREST-style eq — verify an exact case-insensitive match client-side so
 * partial collisions can't return the wrong account. passkey.py:147.
 */
export async function getUserByEmail(email: string): Promise<Obj | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const url = new URL(`${SUPABASE_URL}/auth/v1/admin/users`);
  url.searchParams.set('filter', email);
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', '50');
  const resp = await fetch(url, { headers: svcHeaders() });
  if (!resp.ok) {
    console.warn(`admin/users lookup failed for ${email}: ${resp.status} ${await resp.text()}`);
    return null;
  }
  const data = (await resp.json()) as Obj;
  const users: Obj[] = data.users ?? [];
  const needle = email.trim().toLowerCase();
  return users.find((u) => (u.email ?? '').toLowerCase() === needle) ?? null;
}

export async function getUserById(userId: string): Promise<Obj | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: svcHeaders() });
  if (!resp.ok) return null;
  return (await resp.json()) as Obj;
}

export async function getCredentialById(credentialId: string): Promise<Obj | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  const url = new URL(`${SUPABASE_URL}/rest/v1/passkey_credentials`);
  url.searchParams.set('credential_id', `eq.${credentialId}`);
  url.searchParams.set('select', '*');
  url.searchParams.set('limit', '1');
  const resp = await fetch(url, { headers: { ...svcHeaders(), Prefer: 'return=representation' } });
  if (!resp.ok) {
    console.warn(`Failed to fetch passkey credential ${credentialId}: ${resp.status} ${await resp.text()}`);
    return null;
  }
  const rows = (await resp.json()) as Obj[];
  return rows.length ? rows[0]! : null;
}

export async function getPasskeyCredentials(userId: string): Promise<Obj[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return [];
  const url = new URL(`${SUPABASE_URL}/rest/v1/passkey_credentials`);
  url.searchParams.set('user_id', `eq.${userId}`);
  url.searchParams.set('select', '*');
  const resp = await fetch(url, { headers: { ...svcHeaders(), Prefer: 'return=representation' } });
  if (!resp.ok) {
    console.warn(`Failed to fetch passkey credentials for user ${userId}: ${await resp.text()}`);
    return [];
  }
  return (await resp.json()) as Obj[];
}

export async function storePasskeyCredential(args: {
  userId: string;
  credentialId: string;
  publicKey: string;
  signCount: number;
  aaguid: string | null;
  deviceName: string | null;
}): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;
  const payload: Obj = {
    user_id: args.userId,
    credential_id: args.credentialId,
    public_key: args.publicKey,
    sign_count: args.signCount,
  };
  if (args.aaguid) payload.aaguid = args.aaguid;
  if (args.deviceName) payload.device_name = args.deviceName;

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/passkey_credentials`, {
    method: 'POST',
    headers: { ...svcHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    console.error(`Failed to store passkey credential: ${await resp.text()}`);
    return false;
  }
  return true;
}

export async function updateSignCount(credentialId: string, newCount: number): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  const url = new URL(`${SUPABASE_URL}/rest/v1/passkey_credentials`);
  url.searchParams.set('credential_id', `eq.${credentialId}`);
  await fetch(url, {
    method: 'PATCH',
    headers: { ...svcHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({ sign_count: newCount, last_used_at: 'now()' }),
  });
}

/**
 * Exchange a verified passkey authentication for a full Supabase session via
 * GoTrue's admin generate_link (magiclink) + server-side verify exchange.
 * passkey.py:274.
 */
export async function generateSupabaseSession(email: string, userId: string): Promise<Obj> {
  void userId;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SUPABASE_ANON_KEY) {
    console.error('Cannot issue passkey session — missing Supabase env vars');
    throw new ApiError(503, 'Auth service is not configured.');
  }

  const genResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: svcHeaders(),
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  if (!genResp.ok) {
    console.error(`generate_link failed (${genResp.status}): ${await genResp.text()}`);
    throw new ApiError(502, 'Failed to generate authentication token.');
  }
  const genData = (await genResp.json()) as Obj;
  const props = genData.properties ?? genData;
  const tokenHash = props.hashed_token ?? props.token_hash;
  if (!tokenHash) {
    console.error(`generate_link response missing hashed_token: ${JSON.stringify(genData)}`);
    throw new ApiError(502, 'Auth token missing from server response.');
  }

  const verifyResp = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: anonHeaders(),
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
    redirect: 'manual',
  });
  if (!verifyResp.ok) {
    console.error(`Server-side verify failed (${verifyResp.status}): ${await verifyResp.text()}`);
    throw new ApiError(502, 'Session exchange failed.');
  }
  return (await verifyResp.json()) as Obj;
}

// ── JWT bearer extraction (no signature verification — matches Python) ──
export function extractUserIdFromToken(authorization: string | undefined): string {
  try {
    const token = (authorization ?? '').replace(/^Bearer /, '');
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8'));
    const uid = payload.sub;
    if (!uid) throw new Error('no sub claim');
    return uid;
  } catch {
    throw new ApiError(401, 'Invalid or missing Authorization token.');
  }
}

// ── clientDataJSON challenge extraction ─────────────────────
function extractChallenge(credential: Obj): string {
  try {
    const clientDataJson = credential?.response?.clientDataJSON;
    const clientData = JSON.parse(Buffer.from(clientDataJson, 'base64url').toString('utf-8'));
    return clientData.challenge ?? '';
  } catch {
    throw new ApiError(400, 'Malformed credential response.');
  }
}

// ── Endpoint logic ───────────────────────────────────────────

export async function hasCredential(email: string): Promise<Obj> {
  const user = await getUserByEmail(email);
  if (!user) return { has_passkey: false };
  const creds = await getPasskeyCredentials(user.id);
  return { has_passkey: creds.length > 0 };
}

export async function registerOptions(
  originHeader: string | undefined,
  authorization: string | undefined,
  email: string,
): Promise<Obj> {
  const userId = extractUserIdFromToken(authorization);
  const [rpId] = rpConfig(originHeader);

  const existing = await getPasskeyCredentials(userId);
  const excludeCredentials = existing.map((c) => ({ id: c.credential_id as string }));

  const opts = await generateRegistrationOptions({
    rpID: rpId,
    rpName: RP_NAME,
    userID: Buffer.from(userId, 'utf-8'),
    userName: email,
    userDisplayName: email,
    excludeCredentials,
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  storeChallenge(opts.challenge, email, userId);
  return opts;
}

export async function register(
  originHeader: string | undefined,
  authorization: string | undefined,
  email: string,
  credential: Obj,
  deviceName: string | null,
): Promise<Obj> {
  const userId = extractUserIdFromToken(authorization);
  const challengeB64 = extractChallenge(credential);

  const entry = popChallenge(challengeB64);
  if (!entry) throw new ApiError(400, 'Challenge expired or not found. Please try again.');
  if (entry.userId !== userId) throw new ApiError(403, 'Challenge was issued for a different user.');

  const [rpId, expectedOrigin] = rpConfig(originHeader);
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: credential as never,
      expectedChallenge: challengeB64,
      expectedRPID: rpId,
      expectedOrigin,
      requireUserVerification: false,
    });
  } catch (e) {
    console.warn(`Registration verification failed: ${String(e)}`);
    throw new ApiError(400, 'Passkey registration could not be verified.');
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new ApiError(400, 'Passkey registration could not be verified.');
  }

  const { credential: cred, aaguid } = verification.registrationInfo;
  const credId = cred.id;
  const pubKey = Buffer.from(cred.publicKey).toString('base64url');

  const stored = await storePasskeyCredential({
    userId,
    credentialId: credId,
    publicKey: pubKey,
    signCount: cred.counter,
    aaguid: aaguid || null,
    deviceName,
  });
  if (!stored) throw new ApiError(500, 'Failed to save passkey. Please try again.');

  return { ok: true, credential_id: credId };
}

export async function discoverOptions(originHeader: string | undefined): Promise<Obj> {
  const [rpId] = rpConfig(originHeader);
  const opts = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: [],
    userVerification: 'preferred',
  });
  storeChallenge(opts.challenge);
  return opts;
}

export async function discoverAuthenticate(originHeader: string | undefined, credential: Obj): Promise<Obj> {
  const challengeB64 = extractChallenge(credential);
  const entry = popChallenge(challengeB64);
  if (!entry) throw new ApiError(400, 'Challenge expired or not found. Please start the sign-in again.');

  const credId = credential.id ?? credential.rawId ?? '';
  const credRow = await getCredentialById(credId);
  if (!credRow) {
    console.warn(`Discoverable passkey not found in DB for credential_id=${credId}`);
    throw new ApiError(401, 'Passkey not recognized.');
  }

  const userId = credRow.user_id;
  const user = await getUserById(userId);
  if (!user) throw new ApiError(401, 'User account not found.');
  const email = user.email ?? '';

  const [rpId, expectedOrigin] = rpConfig(originHeader);
  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential as never,
      expectedChallenge: challengeB64,
      expectedRPID: rpId,
      expectedOrigin,
      credential: {
        id: credRow.credential_id,
        publicKey: Buffer.from(credRow.public_key, 'base64url'),
        counter: credRow.sign_count,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    console.warn(`Discoverable passkey authentication failed: ${String(e)}`);
    throw new ApiError(401, 'Passkey verification failed.');
  }
  if (!verification.verified) throw new ApiError(401, 'Passkey verification failed.');

  await updateSignCount(credRow.credential_id, verification.authenticationInfo.newCounter);
  return generateSupabaseSession(email, userId);
}

export async function authenticateOptions(originHeader: string | undefined, email: string): Promise<Obj> {
  const user = await getUserByEmail(email);
  if (!user) return { has_passkey: false };

  const existing = await getPasskeyCredentials(user.id);
  if (!existing.length) return { has_passkey: false };

  const allowCredentials = existing.map((c) => ({ id: c.credential_id as string }));
  const [rpId] = rpConfig(originHeader);
  const opts = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials,
    userVerification: 'preferred',
  });

  storeChallenge(opts.challenge, email, user.id);
  return { has_passkey: true, ...opts };
}

export async function authenticate(
  originHeader: string | undefined,
  email: string,
  credential: Obj,
): Promise<Obj> {
  const challengeB64 = extractChallenge(credential);
  const entry = popChallenge(challengeB64);
  if (!entry) throw new ApiError(400, 'Challenge expired or not found. Please start the sign-in again.');

  const userId = entry.userId;
  if (!userId) throw new ApiError(400, 'Invalid challenge.');

  const credIdFromResponse = credential.id ?? credential.rawId ?? '';
  const allCreds = await getPasskeyCredentials(userId);
  const matched = allCreds.find((c) => c.credential_id === credIdFromResponse);
  if (!matched) {
    console.warn(
      `Passkey not found in DB for user ${userId}, credential_id=${credIdFromResponse}, stored_ids=${JSON.stringify(
        allCreds.map((c) => c.credential_id),
      )}`,
    );
    throw new ApiError(401, 'Passkey not recognized.');
  }

  const [rpId, expectedOrigin] = rpConfig(originHeader);
  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential as never,
      expectedChallenge: challengeB64,
      expectedRPID: rpId,
      expectedOrigin,
      credential: {
        id: matched.credential_id,
        publicKey: Buffer.from(matched.public_key, 'base64url'),
        counter: matched.sign_count,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    console.warn(`Passkey authentication failed for user ${userId}: ${String(e)}`);
    throw new ApiError(401, 'Passkey verification failed.');
  }
  if (!verification.verified) throw new ApiError(401, 'Passkey verification failed.');

  await updateSignCount(matched.credential_id, verification.authenticationInfo.newCounter);
  return generateSupabaseSession(email, userId);
}

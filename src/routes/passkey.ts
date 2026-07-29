/**
 * Passkey (WebAuthn) routes — port of backend/app/routers/passkey.py.
 * Mounted at /auth/passkey.
 */
import type { FastifyInstance } from 'fastify';

import {
  hasCredential,
  registerOptions,
  register,
  discoverOptions,
  discoverAuthenticate,
  authenticateOptions,
  authenticate,
} from '../services/passkeyService.js';
import { ApiError } from '../plugins/errorEnvelope.js';

interface HasCredentialQuery {
  email?: string;
}

function requireEmail(v: unknown): string {
  if (typeof v !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw new ApiError(400, 'A valid email is required.');
  }
  return v;
}

function requireCredential(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object') throw new ApiError(400, 'credential is required.');
  return v as Record<string, unknown>;
}

export function registerPasskeyRoutes(app: FastifyInstance): void {
  // passkey.py:389 — GET /auth/passkey/has-credential
  app.get<{ Querystring: HasCredentialQuery }>('/auth/passkey/has-credential', async (req) => {
    const email = req.query.email;
    if (!email || email.length < 3) throw new ApiError(400, 'email is required (min length 3).');
    return await hasCredential(email);
  });

  // passkey.py:399 — POST /auth/passkey/register-options
  app.post<{ Body: { email?: unknown; device_name?: unknown } }>(
    '/auth/passkey/register-options',
    async (req) => {
      const email = requireEmail(req.body?.email);
      const authorization = req.headers.authorization;
      const origin = req.headers.origin;
      return await registerOptions(origin, authorization, email);
    },
  );

  // passkey.py:438 — POST /auth/passkey/register
  app.post<{ Body: { email?: unknown; credential?: unknown; device_name?: unknown } }>(
    '/auth/passkey/register',
    async (req) => {
      const email = requireEmail(req.body?.email);
      const credential = requireCredential(req.body?.credential);
      const deviceName = typeof req.body?.device_name === 'string' ? req.body.device_name : null;
      const authorization = req.headers.authorization;
      const origin = req.headers.origin;
      return await register(origin, authorization, email, credential, deviceName);
    },
  );

  // passkey.py:508 — POST /auth/passkey/discover-options
  app.post('/auth/passkey/discover-options', async (req) => {
    const origin = req.headers.origin;
    return await discoverOptions(origin);
  });

  // passkey.py:525 — POST /auth/passkey/discover-authenticate
  app.post<{ Body: { credential?: unknown } }>('/auth/passkey/discover-authenticate', async (req) => {
    const credential = requireCredential(req.body?.credential);
    const origin = req.headers.origin;
    return await discoverAuthenticate(origin, credential);
  });

  // passkey.py:591 — POST /auth/passkey/authenticate-options
  app.post<{ Body: { email?: unknown } }>('/auth/passkey/authenticate-options', async (req) => {
    const email = requireEmail(req.body?.email);
    const origin = req.headers.origin;
    return await authenticateOptions(origin, email);
  });

  // passkey.py:622 — POST /auth/passkey/authenticate
  app.post<{ Body: { email?: unknown; credential?: unknown } }>(
    '/auth/passkey/authenticate',
    async (req) => {
      const email = requireEmail(req.body?.email);
      const credential = requireCredential(req.body?.credential);
      const origin = req.headers.origin;
      return await authenticate(origin, email, credential);
    },
  );
}

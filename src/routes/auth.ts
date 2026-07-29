/**
 * Auth routes — port of backend/app/routers/auth.py. Mounted at /auth (NOT
 * under /api — the frontend/iOS client hardcode this distinction).
 */
import type { FastifyInstance } from 'fastify';

import { passwordLogin } from '../services/authService.js';
import { ApiError } from '../plugins/errorEnvelope.js';

interface PasswordLoginBody {
  email?: unknown;
  password?: unknown;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function registerAuthRoutes(app: FastifyInstance): void {
  // auth.py:58 — POST /auth/password-login
  app.post<{ Body: PasswordLoginBody }>('/auth/password-login', async (req) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
      throw new ApiError(400, 'A valid email is required.');
    }
    if (typeof password !== 'string' || !password) {
      throw new ApiError(400, 'password is required.');
    }
    return await passwordLogin(email, password);
  });
}

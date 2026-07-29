/**
 * User-facing auth via Supabase (anon key — NOT service-role) — port of
 * backend/app/routers/auth.py.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { ApiError } from '../plugins/errorEnvelope.js';

let anonClient: SupabaseClient | null = null;

function getAnonClient(): SupabaseClient {
  if (anonClient === null) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new ApiError(503, 'Auth service is not configured.');
    }
    anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return anonClient;
}

export interface SessionResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  user_id: string;
  email: string;
}

/** POST /auth/password-login — auth.py:68. */
export async function passwordLogin(email: string, password: string): Promise<SessionResponse> {
  const client = getAnonClient();

  const { data, error } = await client.auth.signInWithPassword({ email, password });

  if (error || !data?.session || !data.user) {
    console.warn(`Password login failed for ${email}: ${error?.message ?? 'no session returned'}`);
    throw new ApiError(401, error ? 'Invalid email or password.' : 'Authentication failed. Please try again.');
  }

  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    token_type: 'bearer',
    expires_in: data.session.expires_in,
    user_id: String(data.user.id),
    email: data.user.email ?? '',
  };
}

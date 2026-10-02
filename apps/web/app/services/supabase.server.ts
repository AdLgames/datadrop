import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.server';

/**
 * Two Supabase clients, never confused:
 *
 * - `serviceClient(env)`: the service role. Bypasses RLS. Used by the intake webhook, the cron
 *   job, admin writes on behalf of a user we have already authorised, and signed URLs. Never in
 *   a loader that renders for a signed-in user without an explicit tenant filter.
 * - `userClient(env, request)`: the publishable key plus the signed-in user's session from the
 *   auth cookies. RLS applies, so a credit user can only ever see their own tenant's rows. Any
 *   refreshed session cookies are collected in `headers` for the caller to put on its response.
 */
export type Service = SupabaseClient;

let service: SupabaseClient | null = null;

export const serviceClient = (env: Env): SupabaseClient => {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  service ??= createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return service;
};

export interface UserClient {
  supabase: SupabaseClient;
  /** Set-Cookie headers produced while handling this request (session refresh, sign-in, sign-out). */
  headers: Headers;
}

export const userClient = (env: Env, request: Request): UserClient => {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required');
  }
  const headers = new Headers();
  const supabase = createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () =>
        parseCookieHeader(request.headers.get('cookie') ?? '').map(({ name, value }) => ({
          name,
          value: value ?? '',
        })),
      setAll: (cookies) => {
        for (const { name, value, options } of cookies) {
          headers.append(
            'Set-Cookie',
            serializeCookieHeader(name, value, {
              ...options,
              httpOnly: true,
              sameSite: 'lax',
              secure: env.NODE_ENV === 'production',
              path: '/',
            }),
          );
        }
      },
    },
    cookieOptions: { name: 'ad-auth' },
  });
  return { supabase, headers };
};

export const isConfigured = (env: Env): boolean =>
  Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_SERVICE_ROLE_KEY);

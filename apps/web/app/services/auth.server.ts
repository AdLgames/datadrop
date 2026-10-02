import type { SupabaseClient, User } from '@supabase/supabase-js';
import { redirect } from 'react-router';
import { getApp, type AppServices } from './app.server';
import { pageError } from './page-error';
import { serviceClient, userClient } from './supabase.server';
import { rowAs, type CreditUserRow, type TenantRow } from './db.server';

/**
 * Credit control and admins sign in with a 6-digit code emailed by Supabase Auth; reps never
 * sign in (their identity is the registered phone number). Access is invite-only: `signInWithOtp`
 * runs with `shouldCreateUser: false`, so an email that no admin has invited gets the same
 * generic message and no account. The tenant's allowed email domains are checked before a code
 * is ever sent.
 */
export interface CreditContext {
  app: AppServices;
  supabase: SupabaseClient;
  headers: Headers;
  user: User;
  member: CreditUserRow;
  tenant: TenantRow;
}

const NOT_SET_UP = () =>
  pageError(503, 'Workspace not configured', 'AccountDrop is not connected to its database yet.');

export const requireCreditUser = async (request: Request): Promise<CreditContext> => {
  const app = getApp();
  if (!app.databaseConfigured) throw NOT_SET_UP();
  const { supabase, headers } = userClient(app.env, request);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user)
    throw redirect(`/login?next=${encodeURIComponent(new URL(request.url).pathname)}`, { headers });
  let member = (
    await supabase.from('credit_users').select('*').eq('user_id', data.user.id).maybeSingle()
  ).data as CreditUserRow | null;
  if (!member) member = await linkInvite(app, data.user);
  if (!member) {
    throw pageError(
      403,
      'No workspace',
      'Your sign-in worked, but this email has not been added to a company. Ask your admin to invite you.',
    );
  }
  const tenant = await supabase
    .from('tenants')
    .select('*')
    .eq('id', member.tenant_id)
    .maybeSingle();
  if (tenant.error || !tenant.data)
    throw pageError(403, 'No workspace', 'Your company could not be loaded.');
  return { app, supabase, headers, user: data.user, member, tenant: tenant.data as TenantRow };
};

/** First sign-in after an invite: attach the new auth user to the pending membership row. */
const linkInvite = async (app: AppServices, user: User): Promise<CreditUserRow | null> => {
  if (!user.email) return null;
  const db = serviceClient(app.env);
  const pending = await db
    .from('credit_users')
    .select('*')
    .eq('email', user.email.toLowerCase())
    .is('user_id', null)
    .maybeSingle();
  if (!pending.data) return null;
  const linked = await db
    .from('credit_users')
    .update({ user_id: user.id })
    .eq('id', rowAs<CreditUserRow>(pending.data).id)
    .select('*')
    .single();
  if (linked.error) return null;
  await db.from('audit_log').insert({
    tenant_id: (linked.data as CreditUserRow).tenant_id,
    actor: `user:${user.id}`,
    action: 'user.first_sign_in',
    detail: {},
  });
  return rowAs<CreditUserRow>(linked.data);
};

export const requireAdmin = async (request: Request): Promise<CreditContext> => {
  const ctx = await requireCreditUser(request);
  if (ctx.member.role !== 'admin')
    throw pageError(403, 'Admins only', 'Ask a workspace admin to make this change.');
  return ctx;
};

/** Is this email registered to a tenant whose allowed domains include it? Service role, no session. */
export const emailIsInvited = async (app: AppServices, email: string): Promise<boolean> => {
  const db = serviceClient(app.env);
  const { data } = await db
    .from('credit_users')
    .select('tenant_id')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (!data) return false;
  const tenant = await db
    .from('tenants')
    .select('settings')
    .eq('id', rowAs<{ tenant_id: string }>(data).tenant_id)
    .maybeSingle();
  const allowed = (
    rowAs<{ settings?: { allowed_domains?: string[] } } | null>(tenant.data)?.settings
      ?.allowed_domains ?? []
  ).map((d) => d.toLowerCase());
  if (allowed.length === 0) return true;
  const domain = email.toLowerCase().split('@')[1] ?? '';
  return allowed.includes(domain);
};

/** Same-origin check for mutating forms (SameSite=Lax cookies are the second layer). */
export const assertSameOrigin = (request: Request, appUrl: string | null): void => {
  const expected = appUrl ?? new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (origin !== expected)
      throw pageError(403, 'This form has expired', 'Go back, reload the page and try again.');
    return;
  }
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    throw pageError(403, 'This form has expired', 'Go back, reload the page and try again.');
  }
};

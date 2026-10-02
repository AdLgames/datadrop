import { Form, Link, data, redirect, useActionData } from 'react-router';
import { z } from 'zod';
import type { Route } from './+types/login';
import { getApp } from '../services/app.server';
import { assertSameOrigin, emailIsInvited } from '../services/auth.server';
import { readForm } from '../services/request.server';
import { userClient } from '../services/supabase.server';

const schema = z.object({
  email: z.string().email().max(254),
  next: z.string().max(200).optional(),
});
const GENERIC =
  'If that address is registered, a 6-digit code is on its way. It expires in 10 minutes.';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const app = getApp();
  if (!app.databaseConfigured) return data({ configured: false });
  const { supabase } = userClient(app.env, request);
  const { data: me } = await supabase.auth.getUser();
  if (me.user) throw redirect('/app');
  return data({ configured: true });
};

export const action = async ({ request }: Route.ActionArgs) => {
  const app = getApp();
  assertSameOrigin(request, app.appUrl);
  const form = await readForm(request);
  const parsed = schema.safeParse({
    email: form?.get('email'),
    next: form?.get('next') || undefined,
  });
  if (!parsed.success)
    return data({ error: 'Enter your work email address.', sent: false }, { status: 400 });
  const email = parsed.data.email.toLowerCase();
  // Domain lock + invite-only: unknown addresses get the same message and no email.
  if (await emailIsInvited(app, email)) {
    const { supabase, headers } = userClient(app.env, request);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) app.logger.warn('auth.otp_send_failed', { error: error.message });
    const next = parsed.data.next && parsed.data.next.startsWith('/') ? parsed.data.next : '/app';
    throw redirect(
      `/login/code?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`,
      { headers },
    );
  }
  app.logger.info('auth.otp_not_invited');
  return data({ error: null, sent: true });
};

export default function Login({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  return (
    <main id="main" className="container">
      <h1>Sign in</h1>
      {!loaderData.configured ? (
        <p className="notice warning">AccountDrop is not connected to its database yet.</p>
      ) : null}
      {result?.sent ? <p className="notice success">{GENERIC}</p> : null}
      {result?.error ? <p className="error">{result.error}</p> : null}
      <Form method="post">
        <label htmlFor="email">Work email</label>
        <p className="field-hint">We email you a 6-digit code. No passwords.</p>
        <input id="email" name="email" type="email" autoComplete="email" required />
        <button type="submit">Email me a code</button>
      </Form>
      <p className="muted small">
        Access is by invitation from your company's admin. <Link to="/">Back</Link>
      </p>
    </main>
  );
}

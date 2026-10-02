import { Form, Link, data, redirect, useActionData } from 'react-router';
import { z } from 'zod';
import type { Route } from './+types/login.code';
import { getApp } from '../services/app.server';
import { assertSameOrigin } from '../services/auth.server';
import { readForm } from '../services/request.server';
import { userClient } from '../services/supabase.server';

const schema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/),
  next: z.string().max(200).optional(),
});

export const loader = ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  return data({
    email: url.searchParams.get('email') ?? '',
    next: url.searchParams.get('next') ?? '/app',
  });
};

export const action = async ({ request }: Route.ActionArgs) => {
  const app = getApp();
  assertSameOrigin(request, app.appUrl);
  const form = await readForm(request);
  const parsed = schema.safeParse({
    email: form?.get('email'),
    code: (typeof form?.get('code') === 'string' ? (form.get('code') as string) : '').replace(
      /\s/g,
      '',
    ),
    next: form?.get('next') || undefined,
  });
  if (!parsed.success)
    return data({ error: 'Enter the 6-digit code from the email.' }, { status: 400 });
  const { supabase, headers } = userClient(app.env, request);
  const { error } = await supabase.auth.verifyOtp({
    email: parsed.data.email.toLowerCase(),
    token: parsed.data.code,
    type: 'email',
  });
  if (error) {
    app.logger.info('auth.otp_verify_failed');
    return data(
      { error: 'That code is wrong or has expired. Request a new one.' },
      { status: 400 },
    );
  }
  const next = parsed.data.next && parsed.data.next.startsWith('/') ? parsed.data.next : '/app';
  throw redirect(next, { headers });
};

export default function LoginCode({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  return (
    <main id="main" className="container">
      <h1>Enter your code</h1>
      <p>We sent a 6-digit code to {loaderData.email || 'your email'}. It expires in 10 minutes.</p>
      {result?.error ? <p className="error">{result.error}</p> : null}
      <Form method="post">
        <input type="hidden" name="email" value={loaderData.email} />
        <input type="hidden" name="next" value={loaderData.next} />
        <label htmlFor="code">Code</label>
        <input
          id="code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          required
        />
        <button type="submit">Sign in</button>
      </Form>
      <p className="muted small">
        <Link to="/login">Use a different email</Link>
      </p>
    </main>
  );
}

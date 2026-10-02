import { Form, data } from 'react-router';
import { z } from 'zod';
import type { Route } from './+types/app.settings.users';
import { assertSameOrigin, requireAdmin } from '../services/auth.server';
import { audit, type CreditUserRow } from '../services/db.server';
import { readForm } from '../services/request.server';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireAdmin(request);
  const { data: users } = await ctx.supabase
    .from('credit_users')
    .select('*')
    .eq('tenant_id', ctx.tenant.id)
    .order('email');
  return data(
    {
      users: ((users ?? []) as CreditUserRow[]).map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        joined: u.user_id !== null,
      })),
      allowedDomains: ctx.tenant.settings.allowed_domains ?? [],
      notifyEmails: ctx.tenant.settings.notify_emails ?? [],
      retentionDays: ctx.tenant.settings.retention_days ?? 30,
    },
    { headers: ctx.headers },
  );
};

const inviteSchema = z.object({
  intent: z.literal('invite'),
  email: z.string().email().max(254),
  name: z.string().max(120).optional(),
  role: z.enum(['admin', 'reviewer']),
});
const removeSchema = z.object({ intent: z.literal('remove'), id: z.string().uuid() });
const settingsSchema = z.object({
  intent: z.literal('settings'),
  allowed_domains: z.string().max(500),
  notify_emails: z.string().max(1000),
  retention_days: z.coerce.number().int().min(1).max(365),
});

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireAdmin(request);
  assertSameOrigin(request, ctx.app.appUrl);
  const form = await readForm(request);
  const raw = Object.fromEntries(form?.entries() ?? []);
  if (raw.intent === 'invite') {
    const parsed = inviteSchema.safeParse(raw);
    if (!parsed.success)
      return data(
        { error: 'Enter a valid email and role.', ok: null },
        { status: 400, headers: ctx.headers },
      );
    const email = parsed.data.email.toLowerCase();
    const allowed = (ctx.tenant.settings.allowed_domains ?? []).map((d) => d.toLowerCase());
    const domain = email.split('@')[1] ?? '';
    if (allowed.length > 0 && !allowed.includes(domain)) {
      return data(
        { error: `Only these domains are allowed: ${allowed.join(', ')}.`, ok: null },
        { status: 400, headers: ctx.headers },
      );
    }
    const ins = await ctx.supabase.from('credit_users').insert({
      tenant_id: ctx.tenant.id,
      email,
      name: parsed.data.name?.trim() || null,
      role: parsed.data.role,
      invited_by: ctx.user.id,
    });
    if (ins.error)
      return data(
        {
          error:
            ins.error.code === '23505' ? 'That email is already invited.' : 'Could not invite.',
          ok: null,
        },
        { status: 400, headers: ctx.headers },
      );
    await audit(ctx.supabase, {
      tenant_id: ctx.tenant.id,
      application_id: null,
      actor: `user:${ctx.user.id}`,
      action: 'user.invited',
      detail: { role: parsed.data.role },
    });
    if (ctx.app.email) {
      const link = `${ctx.app.appUrl ?? ''}/login`;
      try {
        await ctx.app.email.send({
          to: email,
          subject: `You've been added to AccountDrop for ${ctx.tenant.name}`,
          text: `${ctx.member.name ?? ctx.member.email} added you to ${ctx.tenant.name}'s AccountDrop workspace as ${parsed.data.role}.\n\nSign in with this email address and the 6-digit code we send you:\n${link}\n\nNo password is needed.`,
        });
      } catch (err) {
        ctx.app.logger.warn('invite.email_failed', { error: err });
      }
    }
    return data(
      { error: null, ok: 'Invited. They can sign in with their email now.' },
      { headers: ctx.headers },
    );
  }
  if (raw.intent === 'remove') {
    const parsed = removeSchema.safeParse(raw);
    if (!parsed.success)
      return data({ error: 'Bad request.', ok: null }, { status: 400, headers: ctx.headers });
    if (parsed.data.id === ctx.member.id)
      return data(
        { error: 'You cannot remove yourself.', ok: null },
        { status: 400, headers: ctx.headers },
      );
    await ctx.supabase
      .from('credit_users')
      .delete()
      .eq('id', parsed.data.id)
      .eq('tenant_id', ctx.tenant.id);
    await audit(ctx.supabase, {
      tenant_id: ctx.tenant.id,
      application_id: null,
      actor: `user:${ctx.user.id}`,
      action: 'user.removed',
      detail: { id: parsed.data.id },
    });
    return data({ error: null, ok: 'Removed.' }, { headers: ctx.headers });
  }
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success)
    return data({ error: 'Check the settings.', ok: null }, { status: 400, headers: ctx.headers });
  const split = (s: string) =>
    s
      .split(/[\s,;]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
  const settings = {
    ...ctx.tenant.settings,
    allowed_domains: split(parsed.data.allowed_domains),
    notify_emails: split(parsed.data.notify_emails),
    retention_days: parsed.data.retention_days,
  };
  const up = await ctx.supabase.from('tenants').update({ settings }).eq('id', ctx.tenant.id);
  if (up.error)
    return data({ error: 'Could not save.', ok: null }, { status: 400, headers: ctx.headers });
  await audit(ctx.supabase, {
    tenant_id: ctx.tenant.id,
    application_id: null,
    actor: `user:${ctx.user.id}`,
    action: 'tenant.settings_updated',
    detail: { retention_days: settings.retention_days, domains: settings.allowed_domains.length },
  });
  return data({ error: null, ok: 'Settings saved.' }, { headers: ctx.headers });
};

export default function Users({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <>
      <h1>Users and settings</h1>
      {actionData?.error ? <p className="error">{actionData.error}</p> : null}
      {actionData?.ok ? <p className="notice success">{actionData.ok}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {loaderData.users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.name ?? '-'}</td>
              <td>{u.role}</td>
              <td>{u.joined ? 'signed in' : <span className="muted">invited</span>}</td>
              <td>
                <Form method="post">
                  <input type="hidden" name="intent" value="remove" />
                  <input type="hidden" name="id" value={u.id} />
                  <button type="submit" className="secondary small">
                    Remove
                  </button>
                </Form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Invite a user</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="invite" />
        <label htmlFor="email">Work email</label>
        <input id="email" name="email" type="email" required />
        <label htmlFor="name">Name (optional)</label>
        <input id="name" name="name" type="text" />
        <label htmlFor="role">Role</label>
        <select id="role" name="role" defaultValue="reviewer">
          <option value="reviewer">Reviewer (queue and decisions)</option>
          <option value="admin">Admin (users, reps, form, settings)</option>
        </select>
        <button type="submit">Invite</button>
      </Form>
      <h2>Company settings</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="settings" />
        <label htmlFor="allowed_domains">Allowed sign-in domains</label>
        <p className="field-hint">
          Comma-separated, e.g. acme.co.uk. Leave empty to allow any invited address.
        </p>
        <input
          id="allowed_domains"
          name="allowed_domains"
          type="text"
          defaultValue={loaderData.allowedDomains.join(', ')}
        />
        <label htmlFor="notify_emails">Notify on new applications</label>
        <p className="field-hint">Comma-separated email addresses of credit control.</p>
        <input
          id="notify_emails"
          name="notify_emails"
          type="text"
          defaultValue={loaderData.notifyEmails.join(', ')}
        />
        <label htmlFor="retention_days">Delete form images this many days after a decision</label>
        <input
          id="retention_days"
          name="retention_days"
          type="number"
          min={1}
          max={365}
          defaultValue={loaderData.retentionDays}
        />
        <button type="submit">Save settings</button>
      </Form>
    </>
  );
}

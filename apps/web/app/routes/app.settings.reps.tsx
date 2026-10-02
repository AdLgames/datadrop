import { Form, data } from 'react-router';
import { z } from 'zod';
import type { Route } from './+types/app.settings.reps';
import { normalisePhone } from '../lib/validators';
import { assertSameOrigin, requireAdmin } from '../services/auth.server';
import { audit, type RepRow } from '../services/db.server';
import { readForm } from '../services/request.server';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireAdmin(request);
  const { data: reps } = await ctx.supabase
    .from('reps')
    .select('*')
    .eq('tenant_id', ctx.tenant.id)
    .order('name');
  return data(
    {
      reps: ((reps ?? []) as RepRow[]).map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        branch: r.branch,
        active: r.active,
      })),
    },
    { headers: ctx.headers },
  );
};

const addSchema = z.object({
  intent: z.literal('add'),
  name: z.string().min(1).max(120),
  phone: z.string().min(6).max(30),
  branch: z.string().max(80).optional(),
});
const toggleSchema = z.object({
  intent: z.literal('toggle'),
  id: z.string().uuid(),
  active: z.enum(['true', 'false']),
});

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireAdmin(request);
  assertSameOrigin(request, ctx.app.appUrl);
  const form = await readForm(request);
  const raw = Object.fromEntries(form?.entries() ?? []);
  if (raw.intent === 'add') {
    const parsed = addSchema.safeParse(raw);
    if (!parsed.success)
      return data({ error: 'Name and phone are required.' }, { status: 400, headers: ctx.headers });
    const phone = normalisePhone(parsed.data.phone);
    if (!phone)
      return data(
        { error: 'Enter the phone number as 07..., +44... or 0044...' },
        { status: 400, headers: ctx.headers },
      );
    const ins = await ctx.supabase.from('reps').insert({
      tenant_id: ctx.tenant.id,
      name: parsed.data.name.trim(),
      phone,
      branch: parsed.data.branch?.trim() || null,
      created_by: ctx.user.id,
    });
    if (ins.error) {
      return data(
        {
          error:
            ins.error.code === '23505'
              ? 'That number is already registered.'
              : 'Could not add the rep.',
        },
        { status: 400, headers: ctx.headers },
      );
    }
    await audit(ctx.supabase, {
      tenant_id: ctx.tenant.id,
      application_id: null,
      actor: `user:${ctx.user.id}`,
      action: 'rep.added',
      detail: { name: parsed.data.name },
    });
    return data({ error: null }, { headers: ctx.headers });
  }
  const parsed = toggleSchema.safeParse(raw);
  if (!parsed.success)
    return data({ error: 'Bad request.' }, { status: 400, headers: ctx.headers });
  await ctx.supabase
    .from('reps')
    .update({ active: parsed.data.active === 'true' })
    .eq('id', parsed.data.id)
    .eq('tenant_id', ctx.tenant.id);
  await audit(ctx.supabase, {
    tenant_id: ctx.tenant.id,
    application_id: null,
    actor: `user:${ctx.user.id}`,
    action: parsed.data.active === 'true' ? 'rep.activated' : 'rep.deactivated',
    detail: { repId: parsed.data.id },
  });
  return data({ error: null }, { headers: ctx.headers });
};

export default function Reps({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <>
      <h1>Reps</h1>
      <p className="muted">
        Reps are identified by their WhatsApp number. Only registered, active numbers are processed.
      </p>
      {actionData?.error ? <p className="error">{actionData.error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Branch</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {loaderData.reps.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="mono">{r.phone}</td>
              <td>{r.branch ?? '-'}</td>
              <td>{r.active ? 'active' : <span className="muted">deactivated</span>}</td>
              <td>
                <Form method="post">
                  <input type="hidden" name="intent" value="toggle" />
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="active" value={r.active ? 'false' : 'true'} />
                  <button type="submit" className="secondary small">
                    {r.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </Form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Add a rep</h2>
      <Form method="post">
        <input type="hidden" name="intent" value="add" />
        <label htmlFor="name">Name</label>
        <input id="name" name="name" type="text" required />
        <label htmlFor="phone">WhatsApp number</label>
        <input id="phone" name="phone" type="tel" placeholder="07700 900123" required />
        <label htmlFor="branch">Branch (optional)</label>
        <input id="branch" name="branch" type="text" />
        <button type="submit">Add rep</button>
      </Form>
    </>
  );
}

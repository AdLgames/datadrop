import type { SupabaseClient } from '@supabase/supabase-js';
import { Form, Link, data, redirect } from 'react-router';
import { z } from 'zod';
import type { Route } from './+types/app.applications.$id';
import { companiesHouseLine, money } from '../lib/conversation';
import { evaluate } from '../lib/rules';
import { parseTemplate, type TemplateDefinition } from '../lib/template';
import { normaliseCurrency } from '../lib/validators';
import { assertSameOrigin, requireCreditUser } from '../services/auth.server';
import {
  DEFAULT_TEMPLATE,
  audit,
  rowAs,
  type ApplicationRow,
  type DocumentRow,
  type MessageRow,
  type RepRow,
} from '../services/db.server';
import { notifyRepDecision } from '../services/notify.server';
import { pageError } from '../services/page-error';
import { readForm } from '../services/request.server';
import { serviceClient } from '../services/supabase.server';

const idSchema = z.string().uuid();

const loadTemplate = async (
  supabase: SupabaseClient,
  tenantId: string,
  templateId: string | null,
): Promise<TemplateDefinition> => {
  if (!templateId) return DEFAULT_TEMPLATE;
  const res = await supabase
    .from('form_templates')
    .select('definition')
    .eq('id', templateId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const row = rowAs<{ definition: unknown } | null>(res.data);
  try {
    return row ? parseTemplate(row.definition) : DEFAULT_TEMPLATE;
  } catch {
    return DEFAULT_TEMPLATE;
  }
};

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireCreditUser(request);
  const id = idSchema.safeParse(params.id);
  if (!id.success) throw pageError(404, 'Not found', 'That application does not exist.');
  const { data: app } = await ctx.supabase
    .from('applications')
    .select('*')
    .eq('id', id.data)
    .eq('tenant_id', ctx.tenant.id)
    .maybeSingle();
  if (!app) throw pageError(404, 'Not found', 'That application does not exist.');
  const application = app as ApplicationRow;
  const [rep, docs, msgs, template] = await Promise.all([
    ctx.supabase.from('reps').select('*').eq('id', application.rep_id).maybeSingle(),
    ctx.supabase
      .from('documents')
      .select('*')
      .eq('application_id', application.id)
      .is('deleted_at', null)
      .order('created_at'),
    ctx.supabase
      .from('messages')
      .select('id, application_id, direction, body, media_count, created_at')
      .eq('application_id', application.id)
      .order('created_at'),
    loadTemplate(ctx.supabase, ctx.tenant.id, application.template_id),
  ]);
  // First view by credit control moves it to under_review and is audited (plan §9: every view).
  if (application.status === 'submitted') {
    await ctx.supabase
      .from('applications')
      .update({ status: 'under_review' })
      .eq('id', application.id);
    application.status = 'under_review';
  }
  await audit(ctx.supabase, {
    tenant_id: ctx.tenant.id,
    application_id: application.id,
    actor: `user:${ctx.user.id}`,
    action: 'application.viewed',
  });
  const evaluation = evaluate(template, application.data);
  const sections = template.sections.map((s) => ({
    title: s.title,
    rows: s.fields
      .filter((f) => evaluation.requirements[f.key] !== 'hidden')
      .map((f) => ({
        key: f.key,
        label: f.label,
        value: application.data[f.key] ?? null,
        display:
          application.data[f.key] == null
            ? null
            : f.type === 'currency'
              ? `£${money(String(application.data[f.key]))}`
              : String(application.data[f.key]),
        requirement: evaluation.requirements[f.key],
        missing: evaluation.missing.includes(f.key),
        flag: evaluation.flags.find((x) => x.key === f.key)?.problem ?? null,
        sensitive: f.sensitive,
      })),
  }));
  return data(
    {
      application: {
        id: application.id,
        ref: application.ref,
        status: application.status,
        legalName: application.data.legal_name ?? null,
        submittedAt: application.submitted_at,
        decidedAt: application.decided_at,
        decisionNote: application.decision_note,
        accountNumber: application.account_number,
        approvedLimit: application.approved_limit,
        limitRequested: application.data.credit_limit_requested ?? null,
        companiesHouse: companiesHouseLine(
          application.data,
          application.lookups.companies_house,
        ).replace(/^• /, ''),
        postcodes: application.lookups.postcode_valid ?? {},
      },
      rep: rep.data
        ? { name: (rep.data as RepRow).name, branch: (rep.data as RepRow).branch }
        : null,
      documents: ((docs.data ?? []) as DocumentRow[]).map((d) => ({
        id: d.id,
        contentType: d.content_type,
        createdAt: d.created_at,
      })),
      messages: ((msgs.data ?? []) as MessageRow[]).map((m) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        media: m.media_count,
        at: m.created_at,
      })),
      sections,
      canDecide: ['submitted', 'under_review', 'returned'].includes(application.status),
    },
    { headers: ctx.headers },
  );
};

const decisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approve'),
    account_number: z.string().min(1).max(40),
    approved_limit: z.string().min(1).max(20),
  }),
  z.object({ decision: z.literal('return'), note: z.string().min(3).max(1000) }),
  z.object({ decision: z.literal('reject'), note: z.string().min(3).max(1000) }),
]);

export const action = async ({ request, params }: Route.ActionArgs) => {
  const ctx = await requireCreditUser(request);
  assertSameOrigin(request, ctx.app.appUrl);
  const id = idSchema.safeParse(params.id);
  if (!id.success) throw pageError(404, 'Not found', 'That application does not exist.');
  const form = await readForm(request);
  const parsed = decisionSchema.safeParse({
    decision: form?.get('decision'),
    account_number: form?.get('account_number') || undefined,
    approved_limit: form?.get('approved_limit') || undefined,
    note: form?.get('note') || undefined,
  });
  if (!parsed.success)
    return data({ error: 'Fill in the decision details.' }, { status: 400, headers: ctx.headers });
  const { data: row } = await ctx.supabase
    .from('applications')
    .select('*')
    .eq('id', id.data)
    .eq('tenant_id', ctx.tenant.id)
    .maybeSingle();
  if (!row) throw pageError(404, 'Not found', 'That application does not exist.');
  const current = row as ApplicationRow;
  if (!['submitted', 'under_review', 'returned'].includes(current.status)) {
    return data(
      { error: 'This application has already been decided.' },
      { status: 409, headers: ctx.headers },
    );
  }
  const now = new Date();
  const patch: Partial<ApplicationRow> = { decided_at: now.toISOString(), decided_by: ctx.user.id };
  const d = parsed.data;
  if (d.decision === 'approve') {
    const limit = normaliseCurrency(d.approved_limit);
    if (!limit)
      return data(
        { error: 'Enter the approved limit in £.' },
        { status: 400, headers: ctx.headers },
      );
    Object.assign(patch, {
      status: 'approved',
      account_number: d.account_number.trim(),
      approved_limit: limit,
      decision_note: null,
    });
  } else if (d.decision === 'return') {
    Object.assign(patch, {
      status: 'returned',
      decision_note: d.note.trim(),
      decided_at: null,
      decided_by: null,
    });
  } else {
    Object.assign(patch, { status: 'rejected', decision_note: d.note.trim() });
  }
  const updated = await ctx.supabase
    .from('applications')
    .update(patch)
    .eq('id', current.id)
    .select('*')
    .single();
  if (updated.error) throw new Error(updated.error.message);
  const application = updated.data as ApplicationRow;
  await audit(ctx.supabase, {
    tenant_id: ctx.tenant.id,
    application_id: application.id,
    actor: `user:${ctx.user.id}`,
    action: `application.${d.decision}`,
    detail: d.decision === 'approve' ? { account_number: d.account_number } : {},
  });
  // Service role for what RLS keeps read-only to users: retention stamps and the rep's message log.
  const service = serviceClient(ctx.app.env);
  if (application.status === 'approved' || application.status === 'rejected') {
    const days = ctx.tenant.settings.retention_days ?? 30;
    const deleteAfter = new Date(now.getTime() + days * 86_400_000).toISOString();
    await service
      .from('documents')
      .update({ delete_after: deleteAfter })
      .eq('application_id', application.id)
      .is('delete_after', null);
  }
  const rep = await service.from('reps').select('*').eq('id', application.rep_id).maybeSingle();
  if (rep.data)
    await notifyRepDecision(ctx.app, service, {
      tenant: ctx.tenant,
      rep: rep.data as RepRow,
      application,
    });
  throw redirect(`/app/applications/${application.id}`, { headers: ctx.headers });
};

export default function ApplicationDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { application: a, rep, documents, messages, sections } = loaderData;
  return (
    <>
      <p className="small">
        <Link to="/app">← Queue</Link>
      </p>
      <h1>
        <span className="mono">{a.ref}</span> {a.legalName ?? ''}{' '}
        <span className={`pill ${a.status}`}>{a.status.replace('_', ' ')}</span>
      </h1>
      <p className="muted">
        Rep: {rep?.name ?? '-'}
        {rep?.branch ? ` (${rep.branch})` : ''}
        {a.submittedAt
          ? ` · submitted ${new Date(a.submittedAt).toLocaleString('en-GB', { timeZone: 'Europe/London' })}`
          : ''}
      </p>
      {a.companiesHouse ? (
        <p className={a.companiesHouse.includes('✓') ? 'notice success' : 'notice warning'}>
          {a.companiesHouse}
        </p>
      ) : null}
      {a.status === 'approved' ? (
        <p className="notice success">
          Approved: account {a.accountNumber}, limit £
          {a.approvedLimit ? money(a.approvedLimit) : '-'}.
        </p>
      ) : null}
      {a.status === 'returned' ? (
        <p className="notice warning">Returned to rep: {a.decisionNote}</p>
      ) : null}
      {a.status === 'rejected' ? <p className="notice danger">Rejected: {a.decisionNote}</p> : null}
      {actionData?.error ? <p className="error">{actionData.error}</p> : null}

      <div className="two-col">
        <div>
          {sections.map((s) => (
            <section key={s.title} className="card">
              <h2>{s.title}</h2>
              <table>
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={r.key} className={r.flag ? 'flagged' : r.missing ? 'missing' : ''}>
                      <th scope="row">
                        {r.label}
                        {r.requirement === 'required' ? ' *' : ''}
                      </th>
                      <td>
                        {r.display ?? <span className="muted">{r.missing ? 'missing' : '-'}</span>}
                        {r.flag ? <span className="error small"> ({r.flag})</span> : null}
                        {r.key.endsWith('_postcode') &&
                        r.value &&
                        loaderData.application.postcodes[r.value] === false ? (
                          <span className="error small"> (postcode not found)</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <div>
          <section className="card">
            <h2>Original form</h2>
            {documents.length === 0 ? (
              <p className="muted">
                No images (typed application, or images deleted by retention).
              </p>
            ) : null}
            {documents.map((d, i) =>
              d.contentType.startsWith('image/') ? (
                <a
                  key={d.id}
                  href={`/app/applications/${a.id}/documents/${d.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    className="form-image"
                    src={`/app/applications/${a.id}/documents/${d.id}`}
                    alt={`Form page ${i + 1}`}
                  />
                </a>
              ) : (
                <p key={d.id}>
                  <a
                    href={`/app/applications/${a.id}/documents/${d.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Page {i + 1} ({d.contentType})
                  </a>
                </p>
              ),
            )}
          </section>
          {loaderData.canDecide ? (
            <section className="card">
              <h2>Decision</h2>
              <Form method="post">
                <input type="hidden" name="decision" value="approve" />
                <label htmlFor="account_number">Account number</label>
                <input id="account_number" name="account_number" type="text" required />
                <label htmlFor="approved_limit">Approved credit limit (£)</label>
                <input
                  id="approved_limit"
                  name="approved_limit"
                  type="text"
                  inputMode="decimal"
                  defaultValue={a.limitRequested ?? ''}
                  required
                />
                <button type="submit" className="success">
                  Approve
                </button>
              </Form>
              <Form method="post">
                <input type="hidden" name="decision" value="return" />
                <label htmlFor="return_note">Return to rep with a note</label>
                <textarea id="return_note" name="note" required />
                <button type="submit" className="secondary">
                  Return to rep
                </button>
              </Form>
              <Form method="post">
                <input type="hidden" name="decision" value="reject" />
                <label htmlFor="reject_note">Reject with a reason</label>
                <textarea id="reject_note" name="note" required />
                <button type="submit" className="danger">
                  Reject
                </button>
              </Form>
            </section>
          ) : null}
          <section className="card">
            <h2>Conversation</h2>
            <div className="chat">
              {messages.map((m) => (
                <p key={m.id} className={`msg ${m.direction}`}>
                  <span className="muted small">
                    {m.direction === 'in' ? 'Rep' : 'AccountDrop'} ·{' '}
                    {new Date(m.at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}
                    {m.media > 0 ? ` · ${m.media} photo${m.media === 1 ? '' : 's'}` : ''}
                  </span>
                  {m.body ? `\n${m.body}` : ''}
                </p>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

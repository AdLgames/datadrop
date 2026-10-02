import { Form, data } from 'react-router';
import type { Route } from './+types/app.settings.form';
import {
  REQUIREMENTS,
  parseTemplate,
  type Requirement,
  type TemplateDefinition,
} from '../lib/template';
import { assertSameOrigin, requireAdmin } from '../services/auth.server';
import { activeTemplate, audit, type TemplateRow } from '../services/db.server';
import { readForm } from '../services/request.server';
import { serviceClient } from '../services/supabase.server';

/**
 * The simple form builder (plan Phase 2): required / optional / hidden per field and the exact
 * question the bot asks. Every save is a new version; applications in progress keep theirs.
 * Conditional rules, multiple templates and the printable PDF are the full builder, later.
 */
const text = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v : '');

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireAdmin(request);
  const template = await activeTemplate(serviceClient(ctx.app.env), ctx.tenant.id);
  return data(
    {
      version: template.version,
      name: template.definition.name,
      protectedKeys: template.definition.protectedKeys,
      sections: template.definition.sections.map((s) => ({
        title: s.title,
        fields: s.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          requirement: f.requirement,
          ask: f.ask ?? '',
          sensitive: f.sensitive,
          hasRules: f.rules.length > 0,
          rules: f.rules.map(
            (r) =>
              `${r.then} if ${r.field} ${r.op} ${Array.isArray(r.value) ? r.value.join('/') : String(r.value ?? '')}`,
          ),
        })),
      })),
    },
    { headers: ctx.headers },
  );
};

export const action = async ({ request }: Route.ActionArgs) => {
  const ctx = await requireAdmin(request);
  assertSameOrigin(request, ctx.app.appUrl);
  const form = await readForm(request);
  if (!form)
    return data({ error: 'Bad request.', ok: null }, { status: 400, headers: ctx.headers });
  const service = serviceClient(ctx.app.env);
  const current: TemplateRow = await activeTemplate(service, ctx.tenant.id);
  const next: TemplateDefinition = {
    ...current.definition,
    sections: current.definition.sections.map((s) => ({
      ...s,
      fields: s.fields.map((f) => {
        const req = text(form.get(`req:${f.key}`)) || f.requirement;
        const ask = (text(form.get(`ask:${f.key}`)) || f.ask || '').trim();
        const requirement: Requirement = (REQUIREMENTS as readonly string[]).includes(req)
          ? (req as Requirement)
          : f.requirement;
        const locked = current.definition.protectedKeys.includes(f.key);
        return {
          ...f,
          requirement: locked && requirement === 'hidden' ? f.requirement : requirement,
          ...(ask ? { ask: ask.slice(0, 300) } : {}),
        };
      }),
    })),
  };
  try {
    parseTemplate(next);
  } catch (err) {
    return data(
      { error: err instanceof Error ? err.message : 'Invalid template.', ok: null },
      { status: 400, headers: ctx.headers },
    );
  }
  await service.from('form_templates').update({ status: 'archived' }).eq('id', current.id);
  const ins = await service.from('form_templates').insert({
    tenant_id: ctx.tenant.id,
    name: current.name,
    version: current.version + 1,
    status: 'active',
    definition: next,
    created_by: ctx.user.id,
  });
  if (ins.error)
    return data(
      { error: 'Could not save the template.', ok: null },
      { status: 400, headers: ctx.headers },
    );
  await audit(ctx.supabase, {
    tenant_id: ctx.tenant.id,
    application_id: null,
    actor: `user:${ctx.user.id}`,
    action: 'template.published',
    detail: { version: current.version + 1 },
  });
  return data(
    {
      error: null,
      ok: `Published version ${current.version + 1}. Applications already in progress keep version ${current.version}.`,
    },
    { headers: ctx.headers },
  );
};

export default function FormSettings({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <>
      <h1>Form: {loaderData.name}</h1>
      <p className="muted">
        Version {loaderData.version}. Set each field to required, optional or hidden, and write the
        exact question the bot asks when it is missing. Fields marked sensitive are hidden by
        default: switching one on means you are capturing personal data, so keep retention short and
        say so in your privacy notice.
      </p>
      {actionData?.error ? <p className="error">{actionData.error}</p> : null}
      {actionData?.ok ? <p className="notice success">{actionData.ok}</p> : null}
      <Form method="post">
        {loaderData.sections.map((s) => (
          <section key={s.title}>
            <h2>{s.title}</h2>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Requirement</th>
                  <th>Question the bot asks</th>
                </tr>
              </thead>
              <tbody>
                {s.fields.map((f) => (
                  <tr key={f.key}>
                    <th scope="row">
                      {f.label}
                      {f.sensitive ? <span className="muted small"> (sensitive)</span> : null}
                      {loaderData.protectedKeys.includes(f.key) ? (
                        <span className="muted small"> (always required)</span>
                      ) : null}
                      {f.hasRules ? <p className="muted small">{f.rules.join('; ')}</p> : null}
                    </th>
                    <td className="small">{f.type}</td>
                    <td>
                      <select name={`req:${f.key}`} defaultValue={f.requirement}>
                        <option value="required">Required</option>
                        <option value="optional">Optional</option>
                        {loaderData.protectedKeys.includes(f.key) ? null : (
                          <option value="hidden">Hidden</option>
                        )}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        name={`ask:${f.key}`}
                        defaultValue={f.ask}
                        maxLength={300}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        <button type="submit">Publish as a new version</button>
      </Form>
    </>
  );
}

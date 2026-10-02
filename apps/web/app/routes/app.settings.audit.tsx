import { data } from 'react-router';
import type { Route } from './+types/app.settings.audit';
import { requireAdmin } from '../services/auth.server';

interface AuditRow {
  id: number;
  application_id: string | null;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireAdmin(request);
  const { data: rows } = await ctx.supabase
    .from('audit_log')
    .select('id, application_id, actor, action, detail, created_at')
    .eq('tenant_id', ctx.tenant.id)
    .order('created_at', { ascending: false })
    .limit(300);
  return data(
    { rows: ((rows ?? []) as AuditRow[]).map((r) => ({ ...r, detail: JSON.stringify(r.detail) })) },
    { headers: ctx.headers },
  );
};

export default function Audit({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">Every view, change and decision, newest first (last 300).</p>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Application</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {loaderData.rows.map((r) => (
            <tr key={r.id}>
              <td className="small">
                {new Date(r.created_at).toLocaleString('en-GB', { timeZone: 'Europe/London' })}
              </td>
              <td className="mono small">{r.actor}</td>
              <td>{r.action}</td>
              <td className="mono small">
                {r.application_id ? r.application_id.slice(0, 8) : '-'}
              </td>
              <td className="mono small">{r.detail === '{}' ? '' : r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

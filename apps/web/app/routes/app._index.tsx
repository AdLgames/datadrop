import { Link, data } from 'react-router';
import type { Route } from './+types/app._index';
import { money } from '../lib/conversation';
import { requireCreditUser } from '../services/auth.server';
import type { ApplicationRow, ApplicationStatus } from '../services/db.server';

const FILTERS: Array<{ key: string; label: string; statuses: ApplicationStatus[] }> = [
  { key: 'new', label: 'New', statuses: ['submitted'] },
  { key: 'review', label: 'Under review', statuses: ['under_review'] },
  { key: 'returned', label: 'Returned to rep', statuses: ['returned'] },
  { key: 'collecting', label: 'Still with rep', statuses: ['collecting', 'awaiting_confirmation'] },
  { key: 'decided', label: 'Decided', statuses: ['approved', 'rejected'] },
  { key: 'all', label: 'All', statuses: [] },
];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireCreditUser(request);
  const url = new URL(request.url);
  const filterKey = url.searchParams.get('f') ?? 'new';
  const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0]!;
  let q = ctx.supabase
    .from('applications')
    .select(
      'id, ref, status, data, missing_fields, flagged_fields, submitted_at, created_at, updated_at, rep_id, reps(name, branch)',
    )
    .eq('tenant_id', ctx.tenant.id)
    .order('updated_at', { ascending: false })
    .limit(200);
  if (filter.statuses.length > 0) q = q.in('status', filter.statuses);
  const { data: rows, error } = await q;
  if (error) throw new Error(error.message);
  const list = (
    rows as unknown as Array<
      ApplicationRow & { reps: { name: string; branch: string | null } | null }
    >
  ).map((r) => ({
    id: r.id,
    ref: r.ref,
    status: r.status,
    legalName: r.data.legal_name ?? '(no name yet)',
    rep: r.reps?.name ?? '-',
    branch: r.reps?.branch ?? null,
    limit: r.data.credit_limit_requested ?? null,
    flags: r.flagged_fields.length,
    missing: r.missing_fields.length,
    signed: r.data.signature_present === 'yes',
    when: r.submitted_at ?? r.updated_at,
  }));
  return data({ filter: filter.key, list }, { headers: ctx.headers });
};

export default function Queue({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <h1>Applications</h1>
      <nav className="filters" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            to={`/app?f=${f.key}`}
            className={loaderData.filter === f.key ? 'active' : ''}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      {loaderData.list.length === 0 ? (
        <p className="muted">
          Nothing here. New applications arrive when a rep sends a form on WhatsApp.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Ref</th>
              <th>Business</th>
              <th>Rep</th>
              <th>Limit</th>
              <th>Status</th>
              <th>Checks</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {loaderData.list.map((a) => (
              <tr key={a.id}>
                <td className="mono">
                  <Link to={`/app/applications/${a.id}`}>{a.ref}</Link>
                </td>
                <td>{a.legalName}</td>
                <td>
                  {a.rep}
                  {a.branch ? <span className="muted small"> · {a.branch}</span> : null}
                </td>
                <td>{a.limit ? `£${money(a.limit)}` : '-'}</td>
                <td>
                  <span className={`pill ${a.status}`}>{a.status.replace('_', ' ')}</span>
                </td>
                <td className="small">
                  {a.signed ? 'signed' : <span className="error">unsigned</span>}
                  {a.flags > 0 ? ` · ${a.flags} flag${a.flags === 1 ? '' : 's'}` : ''}
                  {a.missing > 0 ? ` · ${a.missing} missing` : ''}
                </td>
                <td className="small">
                  {new Date(a.when).toLocaleString('en-GB', { timeZone: 'Europe/London' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

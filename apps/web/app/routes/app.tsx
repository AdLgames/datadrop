import { Form, Link, NavLink, Outlet, data } from 'react-router';
import type { Route } from './+types/app';
import { requireCreditUser } from '../services/auth.server';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const ctx = await requireCreditUser(request);
  return data(
    { tenantName: ctx.tenant.name, email: ctx.member.email, role: ctx.member.role },
    { headers: ctx.headers },
  );
};

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <header className="site-header">
        <nav className="container" aria-label="Main">
          <Link to="/app" className="brand">
            <span className="brand-mark" aria-hidden="true" />
            AccountDrop
          </Link>
          <NavLink to="/app" end>
            Queue
          </NavLink>
          {loaderData.role === 'admin' ? (
            <>
              <NavLink to="/app/settings/reps">Reps</NavLink>
              <NavLink to="/app/settings/users">Users</NavLink>
              <NavLink to="/app/settings/form">Form</NavLink>
              <NavLink to="/app/settings/audit">Audit</NavLink>
            </>
          ) : null}
          <span className="nav-end small">
            {loaderData.tenantName} · {loaderData.email}
          </span>
          <Form method="post" action="/logout">
            <button type="submit" className="secondary small">
              Sign out
            </button>
          </Form>
        </nav>
      </header>
      <main id="main" className="container">
        <Outlet />
      </main>
    </>
  );
}

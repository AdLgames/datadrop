import type { ReactNode } from 'react';
import {
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from 'react-router';
import type { Route } from './+types/root';
import { pageErrorSchema } from './services/page-error';
import stylesheet from './styles.css?url';

export const links: Route.LinksFunction = () => [{ rel: 'stylesheet', href: stylesheet }];

export const meta: Route.MetaFunction = () => [
  { title: 'AccountDrop' },
  {
    name: 'description',
    content:
      'Reps WhatsApp a photo of the trade-account form. Credit control gets a complete, readable application.',
  },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/** Never leaks stack traces in production (React Router sanitises server errors outside dev). */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = 'Something went wrong';
  let detail = 'Please try again in a moment. If it keeps happening, let us know.';
  let stack: string | undefined;
  let hint: string | null = null;
  const page = isRouteErrorResponse(error) ? pageErrorSchema.safeParse(error.data) : null;

  if (page?.success) {
    title = page.data.title;
    detail = page.data.message;
    hint = page.data.hint;
  } else if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? 'Page not found' : `Error ${error.status}`;
    detail =
      error.status === 404
        ? 'The page you are looking for does not exist.'
        : error.statusText || detail;
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
    stack = error.stack;
  }

  return (
    <main id="main" className="container">
      <section className="error-page">
        <h1>{title}</h1>
        <p>{detail}</p>
        {hint ? <p className="hint">{hint}</p> : null}
        {stack ? (
          <pre className="stack">
            <code>{stack}</code>
          </pre>
        ) : null}
        <p>
          <Link to="/">Back to the start</Link>
        </p>
      </section>
    </main>
  );
}

import { type RouteConfig, index, route, prefix, layout } from '@react-router/dev/routes';

export default [
  index('routes/_index.tsx'),
  route('healthz', 'routes/healthz.tsx'),
  route('login', 'routes/login.tsx'),
  route('login/code', 'routes/login.code.tsx'),
  route('logout', 'routes/logout.tsx'),
  route('webhooks/twilio', 'routes/webhooks.twilio.tsx'),
  route('webhooks/meta', 'routes/webhooks.meta.tsx'),
  route('api/cron/retention', 'routes/api.cron.retention.tsx'),
  layout('routes/app.tsx', [
    ...prefix('app', [
      index('routes/app._index.tsx'),
      route('applications/:id', 'routes/app.applications.$id.tsx'),
      route(
        'applications/:id/documents/:documentId',
        'routes/app.applications.$id.documents.$documentId.tsx',
      ),
      route('settings/reps', 'routes/app.settings.reps.tsx'),
      route('settings/users', 'routes/app.settings.users.tsx'),
      route('settings/form', 'routes/app.settings.form.tsx'),
      route('settings/audit', 'routes/app.settings.audit.tsx'),
    ]),
  ]),
] satisfies RouteConfig;

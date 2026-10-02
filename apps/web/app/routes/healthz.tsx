import { getApp } from '../services/app.server';

export const loader = () => {
  const app = getApp();
  return Response.json({
    ok: true,
    database: app.databaseConfigured,
    twilio: app.twilio !== null,
    extraction: app.anthropic !== null,
    email: app.email?.name ?? null,
    startedAt: app.startedAt.toISOString(),
  });
};

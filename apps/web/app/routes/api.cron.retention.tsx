import { createHash, timingSafeEqual } from 'node:crypto';
import type { Route } from './+types/api.cron.retention';
import { getApp } from '../services/app.server';
import { audit } from '../services/db.server';
import { serviceClient } from '../services/supabase.server';

/**
 * GET /api/cron/retention (Vercel Cron, daily): deletes form images whose `delete_after` has
 * passed (set at decision time from the tenant's retention) and expires applications left
 * unfinished for 48 hours. Every deletion is written to the audit log.
 */
const bearerOk = (header: string | null, secret: string): boolean => {
  const given = header?.replace(/^Bearer\s+/i, '') ?? '';
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b) && given.length === secret.length;
};

export const loader = async ({ request }: Route.LoaderArgs) => {
  const app = getApp();
  if (!app.env.CRON_SECRET) return new Response('cron not configured', { status: 503 });
  if (!bearerOk(request.headers.get('authorization'), app.env.CRON_SECRET)) {
    return new Response('unauthorised', { status: 401 });
  }
  if (!app.databaseConfigured) return new Response('database not configured', { status: 503 });
  const db = serviceClient(app.env);
  const nowIso = new Date().toISOString();

  const due = await db
    .from('documents')
    .select('id, tenant_id, application_id, storage_path')
    .is('deleted_at', null)
    .lt('delete_after', nowIso)
    .limit(500);
  let deleted = 0;
  for (const d of (due.data ?? []) as Array<{
    id: string;
    tenant_id: string;
    application_id: string;
    storage_path: string;
  }>) {
    const rm = await db.storage.from('forms').remove([d.storage_path]);
    if (rm.error) {
      app.logger.warn('retention.remove_failed', { documentId: d.id, error: rm.error.message });
      continue;
    }
    await db.from('documents').update({ deleted_at: nowIso }).eq('id', d.id);
    await audit(db, {
      tenant_id: d.tenant_id,
      application_id: d.application_id,
      actor: 'system',
      action: 'document.deleted',
      detail: { documentId: d.id },
    });
    deleted += 1;
  }

  const staleBefore = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const stale = await db
    .from('applications')
    .update({ status: 'expired' })
    .in('status', ['collecting', 'awaiting_confirmation'])
    .lt('updated_at', staleBefore)
    .select('id, tenant_id');
  for (const a of (stale.data ?? []) as Array<{ id: string; tenant_id: string }>) {
    await audit(db, {
      tenant_id: a.tenant_id,
      application_id: a.id,
      actor: 'system',
      action: 'application.expired',
    });
  }
  app.logger.info('retention.ran', { deleted, expired: stale.data?.length ?? 0 });
  return Response.json({ ok: true, deleted, expired: stale.data?.length ?? 0 });
};

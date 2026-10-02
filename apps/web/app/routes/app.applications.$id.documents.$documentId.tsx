import { z } from 'zod';
import type { Route } from './+types/app.applications.$id.documents.$documentId';
import { requireCreditUser } from '../services/auth.server';
import { audit, type DocumentRow } from '../services/db.server';
import { serviceClient } from '../services/supabase.server';

/** Same-origin image proxy: RLS proves the user may see the application, the service role fetches the bytes. */
export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const ctx = await requireCreditUser(request);
  const ids = z.object({ id: z.string().uuid(), documentId: z.string().uuid() }).safeParse(params);
  if (!ids.success) return new Response('not found', { status: 404 });
  const { data: doc } = await ctx.supabase
    .from('documents')
    .select('*')
    .eq('id', ids.data.documentId)
    .eq('application_id', ids.data.id)
    .eq('tenant_id', ctx.tenant.id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!doc) return new Response('not found', { status: 404 });
  const d = doc as DocumentRow;
  const service = serviceClient(ctx.app.env);
  const file = await service.storage.from('forms').download(d.storage_path);
  if (file.error || !file.data) return new Response('not found', { status: 404 });
  await audit(ctx.supabase, {
    tenant_id: ctx.tenant.id,
    application_id: d.application_id,
    actor: `user:${ctx.user.id}`,
    action: 'document.viewed',
    detail: { documentId: d.id },
  });
  const headers = new Headers(ctx.headers);
  headers.set('content-type', d.content_type);
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-disposition', 'inline');
  return new Response(await file.data.arrayBuffer(), { status: 200, headers });
};

import type { SupabaseClient } from '@supabase/supabase-js';
import defaultTemplateJson from '../data/default-template.json';
import { parseTemplate, type ApplicationData, type TemplateDefinition } from '../lib/template';
import type { Flag } from '../lib/rules';
import type { CompaniesHouseResult } from './lookups.server';

/**
 * Typed access to the tables. Every function takes the client it should use: the service client
 * in intake/cron (tenant filters written explicitly), the user's client in loaders (RLS does the
 * filtering, the explicit filter is belt and braces).
 */
export type ApplicationStatus =
  | 'collecting'
  | 'awaiting_confirmation'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'returned'
  | 'rejected'
  | 'expired';

export const OPEN_STATUSES: ApplicationStatus[] = [
  'collecting',
  'awaiting_confirmation',
  'returned',
];

export interface TenantRow {
  id: string;
  name: string;
  settings: TenantSettings;
}
export interface TenantSettings {
  retention_days?: number;
  notify_emails?: string[];
  allowed_domains?: string[];
  rep_notifications?: boolean;
}
export interface RepRow {
  id: string;
  tenant_id: string;
  phone: string;
  name: string;
  branch: string | null;
  active: boolean;
}
export interface CreditUserRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  email: string;
  name: string | null;
  role: 'admin' | 'reviewer';
}
export interface TemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  definition: TemplateDefinition;
}
export interface ApplicationLookups {
  companies_house?: CompaniesHouseResult | { notFound: true } | null;
  postcode_valid?: Record<string, boolean>;
}
export interface ApplicationRow {
  id: string;
  tenant_id: string;
  rep_id: string;
  template_id: string | null;
  template_version: number | null;
  ref: string;
  status: ApplicationStatus;
  data: ApplicationData;
  missing_fields: string[];
  flagged_fields: Flag[];
  lookups: ApplicationLookups;
  last_question: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  account_number: string | null;
  approved_limit: string | null;
  created_at: string;
  updated_at: string;
}
export interface MessageRow {
  id: string;
  application_id: string | null;
  direction: 'in' | 'out';
  body: string | null;
  media_count: number;
  created_at: string;
}
export interface DocumentRow {
  id: string;
  application_id: string;
  storage_path: string;
  kind: string;
  content_type: string;
  delete_after: string | null;
  deleted_at: string | null;
  created_at: string;
}

export const DEFAULT_TEMPLATE: TemplateDefinition = parseTemplate(defaultTemplateJson);

/** supabase-js without generated types returns `any` rows; this names the row type at the boundary. */
export const rowAs = <T>(value: unknown): T => value as T;

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? 'unknown error'}`);
};

export const repByPhone = async (db: SupabaseClient, phone: string): Promise<RepRow | null> => {
  const { data, error } = await db.from('reps').select('*').eq('phone', phone).maybeSingle();
  if (error) fail('reps.select', error);
  return (data as RepRow | null) ?? null;
};

export const tenantById = async (db: SupabaseClient, id: string): Promise<TenantRow | null> => {
  const { data, error } = await db.from('tenants').select('*').eq('id', id).maybeSingle();
  if (error) fail('tenants.select', error);
  return (data as TenantRow | null) ?? null;
};

/** The tenant's active template, or the built-in default (seeded as version 1 on first use). */
export const activeTemplate = async (
  db: SupabaseClient,
  tenantId: string,
): Promise<TemplateRow> => {
  const { data, error } = await db
    .from('form_templates')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail('form_templates.select', error);
  if (data) {
    const row = data as TemplateRow;
    return { ...row, definition: parseTemplate(row.definition) };
  }
  const inserted = await db
    .from('form_templates')
    .insert({
      tenant_id: tenantId,
      name: DEFAULT_TEMPLATE.name,
      version: 1,
      status: 'active',
      definition: DEFAULT_TEMPLATE,
    })
    .select('*')
    .single();
  if (inserted.error) fail('form_templates.insert', inserted.error);
  const row = inserted.data as TemplateRow;
  return { ...row, definition: DEFAULT_TEMPLATE };
};

export const openApplicationFor = async (
  db: SupabaseClient,
  repId: string,
): Promise<ApplicationRow | null> => {
  const { data, error } = await db
    .from('applications')
    .select('*')
    .eq('rep_id', repId)
    .in('status', OPEN_STATUSES)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail('applications.select', error);
  return (data as ApplicationRow | null) ?? null;
};

export const latestApplicationFor = async (
  db: SupabaseClient,
  repId: string,
): Promise<ApplicationRow | null> => {
  const { data, error } = await db
    .from('applications')
    .select('*')
    .eq('rep_id', repId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) fail('applications.select', error);
  return (data as ApplicationRow | null) ?? null;
};

export const createApplication = async (
  db: SupabaseClient,
  input: { tenantId: string; repId: string; template: TemplateRow },
): Promise<ApplicationRow> => {
  const ref = await db.rpc('next_ref', { p_tenant: input.tenantId });
  if (ref.error || typeof ref.data !== 'string') fail('next_ref', ref.error);
  const refValue = ref.data as string;
  const { data, error } = await db
    .from('applications')
    .insert({
      tenant_id: input.tenantId,
      rep_id: input.repId,
      template_id: input.template.id,
      template_version: input.template.version,
      ref: refValue,
      status: 'collecting',
    })
    .select('*')
    .single();
  if (error) fail('applications.insert', error);
  return data as ApplicationRow;
};

export const updateApplication = async (
  db: SupabaseClient,
  id: string,
  patch: Partial<Omit<ApplicationRow, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>>,
): Promise<ApplicationRow> => {
  const { data, error } = await db
    .from('applications')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) fail('applications.update', error);
  return data as ApplicationRow;
};

export const recordMessage = async (
  db: SupabaseClient,
  row: {
    tenant_id: string | null;
    application_id: string | null;
    rep_id: string | null;
    direction: 'in' | 'out';
    wa_message_id: string | null;
    from_phone: string | null;
    body: string | null;
    media_count: number;
  },
): Promise<{ id: string } | 'duplicate'> => {
  const { data, error } = await db.from('messages').insert(row).select('id').single();
  if (error) {
    if (error.code === '23505') return 'duplicate';
    fail('messages.insert', error);
  }
  return { id: (data as { id: string }).id };
};

/**
 * True when another inbound message for this application arrived after `sinceIso`. The triggering
 * message is excluded by id: its own row is stamped by the database a few milliseconds after the
 * timestamp the caller took, so it would otherwise count as newer than itself.
 */
export const newerInboundExists = async (
  db: SupabaseClient,
  applicationId: string,
  sinceIso: string,
  excludeMessageId: string | null = null,
): Promise<boolean> => {
  let q = db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('application_id', applicationId)
    .eq('direction', 'in')
    .gt('created_at', sinceIso);
  if (excludeMessageId) q = q.neq('id', excludeMessageId);
  const { count, error } = await q;
  if (error) fail('messages.count', error);
  return (count ?? 0) > 0;
};

export const audit = async (
  db: SupabaseClient,
  row: {
    tenant_id: string | null;
    application_id: string | null;
    actor: string;
    action: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> => {
  const { error } = await db.from('audit_log').insert({ ...row, detail: row.detail ?? {} });
  if (error) fail('audit_log.insert', error);
};

export const storeDocument = async (
  db: SupabaseClient,
  input: {
    tenantId: string;
    applicationId: string;
    messageId: string | null;
    bytes: Uint8Array;
    contentType: string;
    retentionDays: number;
    now: Date;
  },
): Promise<DocumentRow> => {
  const ext = input.contentType.includes('png')
    ? 'png'
    : input.contentType.includes('pdf')
      ? 'pdf'
      : input.contentType.includes('webp')
        ? 'webp'
        : 'jpg';
  const path = `${input.tenantId}/${input.applicationId}/${input.now.getTime()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const up = await db.storage
    .from('forms')
    .upload(path, input.bytes, { contentType: input.contentType, upsert: false });
  if (up.error) fail('storage.upload', up.error);
  const { data, error } = await db
    .from('documents')
    .insert({
      tenant_id: input.tenantId,
      application_id: input.applicationId,
      message_id: input.messageId,
      storage_path: path,
      kind: 'form_page',
      content_type: input.contentType,
      bytes: input.bytes.byteLength,
      // Set at decision time from the tenant's retention; until then keep for the app's life.
      delete_after: null,
    })
    .select('*')
    .single();
  if (error) fail('documents.insert', error);
  return data as DocumentRow;
};

export const documentsFor = async (
  db: SupabaseClient,
  applicationId: string,
): Promise<DocumentRow[]> => {
  const { data, error } = await db
    .from('documents')
    .select('*')
    .eq('application_id', applicationId)
    .is('deleted_at', null)
    .order('created_at');
  if (error) fail('documents.select', error);
  return (data as DocumentRow[]) ?? [];
};

/** Bytes of all live form images for an application (for re-extraction with every page). */
export const downloadDocuments = async (
  db: SupabaseClient,
  docs: DocumentRow[],
): Promise<Array<{ bytes: Uint8Array; contentType: string }>> => {
  const out: Array<{ bytes: Uint8Array; contentType: string }> = [];
  for (const d of docs) {
    const { data, error } = await db.storage.from('forms').download(d.storage_path);
    if (error || !data) continue;
    out.push({ bytes: new Uint8Array(await data.arrayBuffer()), contentType: d.content_type });
  }
  return out;
};

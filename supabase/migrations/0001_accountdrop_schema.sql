-- Applied 2026-10-02 to project uljmvekfltkinfnnisvt as "accountdrop_schema".
-- Every tenant-owned row carries tenant_id so RLS never depends on a join.
create extension if not exists pgcrypto;
create schema if not exists app;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  settings jsonb not null default '{}'::jsonb, -- retention_days, notify_emails[], allowed_domains[], rep_notifications
  created_at timestamptz not null default now()
);
create table public.form_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, version integer not null,
  status text not null check (status in ('draft', 'active', 'archived')),
  definition jsonb not null, created_by uuid, created_at timestamptz not null default now(),
  unique (tenant_id, name, version)
);
create table public.reps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  phone text not null unique, name text not null, branch text,
  active boolean not null default true, created_by uuid, created_at timestamptz not null default now()
);
create table public.credit_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid unique references auth.users(id) on delete cascade,
  email text not null unique, name text,
  role text not null check (role in ('admin', 'reviewer')),
  invited_by uuid, created_at timestamptz not null default now()
);
create table public.tenant_counters (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  next_ref integer not null default 1
);
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  rep_id uuid not null references public.reps(id),
  template_id uuid references public.form_templates(id), template_version integer,
  ref text not null,
  status text not null check (status in ('collecting','awaiting_confirmation','submitted','under_review','approved','returned','rejected','expired')),
  data jsonb not null default '{}'::jsonb,
  missing_fields text[] not null default '{}',
  flagged_fields jsonb not null default '[]'::jsonb,
  lookups jsonb not null default '{}'::jsonb,
  last_question text, submitted_at timestamptz, decided_at timestamptz, decided_by uuid,
  decision_note text, account_number text, approved_limit text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, ref)
);
create index applications_tenant_status on public.applications (tenant_id, status, created_at desc);
create index applications_rep_open on public.applications (rep_id, updated_at desc)
  where status in ('collecting', 'awaiting_confirmation', 'returned');
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  application_id uuid references public.applications(id) on delete cascade,
  rep_id uuid references public.reps(id),
  direction text not null check (direction in ('in', 'out')),
  wa_message_id text unique, from_phone text, body text,
  media_count integer not null default 0, created_at timestamptz not null default now()
);
create index messages_application on public.messages (application_id, created_at);
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  application_id uuid not null references public.applications(id) on delete cascade,
  message_id uuid references public.messages(id),
  storage_path text not null, kind text not null default 'form_page', content_type text not null,
  bytes integer, delete_after timestamptz, deleted_at timestamptz, created_at timestamptz not null default now()
);
create index documents_delete_after on public.documents (delete_after) where deleted_at is null;
create table public.audit_log (
  id bigserial primary key,
  tenant_id uuid references public.tenants(id) on delete cascade,
  application_id uuid, actor text not null, action text not null,
  detail jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index audit_log_tenant on public.audit_log (tenant_id, created_at desc);

create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger applications_touch before update on public.applications
  for each row execute function app.touch_updated_at();

create or replace function app.next_ref(p_tenant uuid) returns text
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.tenant_counters (tenant_id, next_ref) values (p_tenant, 2)
    on conflict (tenant_id) do update set next_ref = public.tenant_counters.next_ref + 1
    returning next_ref - 1 into n;
  return 'AC-' || lpad(n::text, 4, '0');
end $$;
revoke all on function app.next_ref(uuid) from public, anon, authenticated;

create or replace function app.user_tenant_id() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from public.credit_users where user_id = auth.uid() $$;
create or replace function app.user_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.credit_users where user_id = auth.uid() $$;
grant usage on schema app to authenticated, service_role;
grant execute on function app.user_tenant_id() to authenticated;
grant execute on function app.user_role() to authenticated;

alter table public.tenants enable row level security;
alter table public.form_templates enable row level security;
alter table public.reps enable row level security;
alter table public.credit_users enable row level security;
alter table public.tenant_counters enable row level security;
alter table public.applications enable row level security;
alter table public.messages enable row level security;
alter table public.documents enable row level security;
alter table public.audit_log enable row level security;

create policy tenants_read on public.tenants for select to authenticated using (id = app.user_tenant_id());
create policy tenants_admin_update on public.tenants for update to authenticated
  using (id = app.user_tenant_id() and app.user_role() = 'admin') with check (id = app.user_tenant_id());
create policy templates_read on public.form_templates for select to authenticated using (tenant_id = app.user_tenant_id());
create policy templates_admin_write on public.form_templates for all to authenticated
  using (tenant_id = app.user_tenant_id() and app.user_role() = 'admin')
  with check (tenant_id = app.user_tenant_id() and app.user_role() = 'admin');
create policy reps_read on public.reps for select to authenticated using (tenant_id = app.user_tenant_id());
create policy reps_admin_write on public.reps for all to authenticated
  using (tenant_id = app.user_tenant_id() and app.user_role() = 'admin')
  with check (tenant_id = app.user_tenant_id() and app.user_role() = 'admin');
create policy credit_users_read on public.credit_users for select to authenticated using (tenant_id = app.user_tenant_id());
create policy credit_users_admin_write on public.credit_users for all to authenticated
  using (tenant_id = app.user_tenant_id() and app.user_role() = 'admin')
  with check (tenant_id = app.user_tenant_id() and app.user_role() = 'admin');
create policy applications_read on public.applications for select to authenticated using (tenant_id = app.user_tenant_id());
create policy applications_decide on public.applications for update to authenticated
  using (tenant_id = app.user_tenant_id()) with check (tenant_id = app.user_tenant_id());
create policy messages_read on public.messages for select to authenticated using (tenant_id = app.user_tenant_id());
create policy documents_read on public.documents for select to authenticated using (tenant_id = app.user_tenant_id());
create policy audit_read on public.audit_log for select to authenticated using (tenant_id = app.user_tenant_id());
create policy audit_insert on public.audit_log for insert to authenticated with check (tenant_id = app.user_tenant_id());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('forms', 'forms', false, 20971520, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

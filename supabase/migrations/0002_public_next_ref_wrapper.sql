-- Applied 2026-10-02 as "public_next_ref_wrapper". PostgREST exposes only `public`.
create or replace function public.next_ref(p_tenant uuid) returns text
language sql security definer set search_path = public, app as $$
  select app.next_ref(p_tenant)
$$;
revoke all on function public.next_ref(uuid) from public, anon, authenticated;
grant execute on function public.next_ref(uuid) to service_role;

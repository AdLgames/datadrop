-- Applied 2026-10-02 as "harden_touch_updated_at" (Supabase linter: mutable search_path).
-- tenant_counters intentionally has no policies: only the service role touches it via next_ref().
alter function app.touch_updated_at() set search_path = public;

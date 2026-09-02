-- Defense-in-depth hardening for profiles.is_admin.
--
-- The only existing protection against a user granting themselves admin was
-- the protect_profiles_is_admin_trigger (BEFORE UPDATE, SECURITY DEFINER),
-- which silently reverts any is_admin change unless auth.role() =
-- 'service_role'. RLS alone does NOT block this: the single "Own profile
-- only" FOR ALL policy on profiles has no column-level restriction, so an
-- authenticated user's own UPDATE would satisfy RLS even when it changes
-- is_admin -- the trigger was carrying all of the weight by itself.
--
-- This adds a second, independent layer enforced by Postgres itself before
-- RLS or triggers ever run: authenticated/anon lose UPDATE privilege on the
-- is_admin column specifically. Every other column keeps its existing
-- table-level UPDATE grant untouched.
-- Applied directly to production via Supabase MCP on 2026-09-02.

revoke update (is_admin) on public.profiles from authenticated, anon;

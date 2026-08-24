-- Task 6 security audit (2026-08-24) found a real, exploitable privilege-
-- escalation gap in public.profiles' RLS.
--
-- The only policy on this table is "Own profile only" — a single FOR ALL
-- policy with USING (auth.uid() = id) and no explicit WITH CHECK (which
-- Postgres then defaults to the same USING expression for INSERT/UPDATE).
-- That correctly restricts a customer to their OWN row, but says nothing
-- about which COLUMNS they can change on that row — RLS is row-level, not
-- column-level. Since is_admin lives on the exact same row a customer is
-- otherwise allowed to freely update (their own profile — Settings.jsx
-- updates full_name/firm_name/job_title/phone this way today), any signed-in
-- customer could call:
--   supabase.from('profiles').update({ is_admin: true }).eq('id', user.id)
-- directly from the browser and it would succeed — no policy anywhere
-- blocks it. From there, get_account_requests() / get_error_logs() /
-- get_support_conversations() / get_support_insights() (all SECURITY
-- DEFINER, all gated only by "is the caller's own profiles.is_admin true")
-- would all start returning full data to that now-self-promoted customer:
-- every customer's support conversations, every error_logs row (stack
-- traces, context, PII), and the GDPR export/delete request queue.
--
-- Confirmed nothing in the app itself ever legitimately writes is_admin
-- from the client (grep across src/ — it's read-only there, gating the
-- Insights nav item and route). So the fix below has zero effect on any
-- real user flow: it only ever fires on an attempt to change is_admin that
-- was never a legitimate write to begin with.
--
-- Fix: a BEFORE UPDATE trigger that silently reverts is_admin back to its
-- previous value unless the write comes from service_role (Netlify
-- Functions, using the service key — the only place is_admin should ever
-- actually be promoted from, by Michael running a one-off SQL statement or
-- a future admin tool). Silent revert rather than RAISE EXCEPTION so an
-- unrelated legitimate update that happens to echo back the current
-- is_admin value in its payload (e.g. a naive `{ ...form }` spread) doesn't
-- get rejected outright — only an actual attempted CHANGE to the value is
-- what's neutralized.
CREATE OR REPLACE FUNCTION public.protect_profiles_is_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin AND current_user <> 'service_role' THEN
    NEW.is_admin := OLD.is_admin;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profiles_is_admin_trigger ON public.profiles;
CREATE TRIGGER protect_profiles_is_admin_trigger
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.protect_profiles_is_admin();

REVOKE EXECUTE ON FUNCTION public.protect_profiles_is_admin() FROM PUBLIC, anon, authenticated;

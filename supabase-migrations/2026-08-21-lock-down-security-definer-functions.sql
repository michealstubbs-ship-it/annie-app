-- Applied live to the annie app project via direct database connection —
-- kept here for the record, same as every other migration in this folder.
--
-- Tightens access on SECURITY DEFINER functions the security advisor
-- flagged after connecting the correct Supabase project.
--
-- 1. apollo_reserve_credits: this had NO restriction on who could call it —
-- literally any visitor, logged in or not, could hit
-- /rest/v1/rpc/apollo_reserve_credits directly and deliberately burn through
-- the daily Apollo credit cap just to disrupt real customers' scans. It's
-- only ever meant to be called server-side (Netlify functions, using the
-- service role), so it's restricted to that now.
REVOKE EXECUTE ON FUNCTION public.apollo_reserve_credits(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apollo_reserve_credits(integer, integer) TO service_role;
ALTER FUNCTION public.apollo_reserve_credits(integer, integer) SET search_path = public;

-- 2. handle_new_user: the new-signup trigger. Triggers fire independent of
-- EXECUTE grants (the trigger mechanism doesn't need this function directly
-- callable by anyone), so restricting it the same way doesn't break signup.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
ALTER FUNCTION public.handle_new_user() SET search_path = public;

-- 3. get_support_conversations / get_support_insights: these already check
-- for an admin internally (RAISE EXCEPTION for anyone else), so this was
-- never an actual open leak — but there's no reason an anonymous, not-even-
-- logged-in visitor should be able to call them at all. Closed the door for
-- anon specifically (both the per-role grant and the underlying PUBLIC
-- grant, which is what actually controls anon's access in Postgres), kept
-- authenticated since that's how real admin calls work.
REVOKE EXECUTE ON FUNCTION public.get_support_conversations() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_support_insights() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_support_conversations() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_support_insights() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_support_conversations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_support_insights() TO authenticated;

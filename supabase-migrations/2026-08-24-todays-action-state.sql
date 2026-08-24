-- Applied live to the annie app project via direct database connection —
-- kept here for the record, same as every other migration in this folder.
--
-- Replaces actions_cache's role for Today's Actions. actions_cache stored a
-- full frozen JSONB snapshot of every rendered card, and "merge" logic
-- (mergeActions/stillActive in the old src/lib/actionsEngine.js) had to
-- reach back into that snapshot and manually decide, on every load, whether
-- each cached item still deserved to be there. That's the direct cause of
-- the 2026-08 bugs: two independent copies of "does this qualify" (one at
-- pool-build time, one at merge time) that could silently disagree, and a
-- snapshot that couldn't reflect a rule change or a data fix without a
-- manual cache-clear alongside it (see the DP World card and the Apollo
-- contact-masking bug, both traced this way).
--
-- todays_action_state fixes this by storing nothing but state: for a given
-- user and a given stable item (see actionKey in
-- src/lib/todaysActions/actionKey.js), has it been seen before, and is it
-- done. Every load recomputes the actually-eligible list fresh from live
-- data (contacts, deals, intelligence_signals) — there is exactly one
-- function that decides eligibility (src/lib/todaysActions/pools/*.js), and
-- resolve.js does nothing more than join that live list against this table:
-- done items drop out because their state row says so, everything else is
-- simply whatever's eligible right now. There's no second copy of the
-- eligibility rule to drift out of sync, because there's nothing left for a
-- second copy to check — an item's presence is either "still eligible" or
-- "marked done", never a frozen guess about either.
--
-- actions_cache itself is NOT dropped here — nothing else reads/writes it
-- once the frontend cuts over, but leaving it in place avoids a destructive
-- migration paired with a frontend deploy that has to land in the same
-- instant. It can be dropped in a follow-up once the new table's been live
-- and verified for a while.
CREATE TABLE IF NOT EXISTS public.todays_action_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
  first_shown_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  UNIQUE (user_id, item_key)
);

CREATE INDEX IF NOT EXISTS todays_action_state_user_id_idx ON public.todays_action_state(user_id);

ALTER TABLE public.todays_action_state ENABLE ROW LEVEL SECURITY;

-- Same shape as every other per-user table in this app (see "Own cache
-- only" on actions_cache, "Own contacts only" on contacts, etc.) — a user
-- can only ever see or write their own state rows.
CREATE POLICY "Own action state only" ON public.todays_action_state
  FOR ALL USING ((SELECT auth.uid()) = user_id);

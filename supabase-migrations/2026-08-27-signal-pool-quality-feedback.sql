-- "Annie always learning" extension #1 (2026-08-27, following on from the
-- signal_pool migration): signal_outcomes has been quietly logging what
-- customers actually DO with a signal (seen / dismissed / added_to_bd_
-- actions / placed — see src/lib/signalOutcomes.js) since 21 Aug 2026, but
-- nothing has ever read it back — its own file header says so explicitly
-- ("Nothing reads this data yet"). This is the same "an objective fact,
-- once learned, benefits every other account" principle the signal pool
-- itself and annie_learned_sources already use, applied to signal QUALITY
-- instead of signal discovery: if several independent customers dismiss
-- the same pooled signal and none of them ever act on it, that's a real,
-- learnable fact about that signal, not something every future overlapping
-- customer should have to discover for themselves by also dismissing it.
--
-- Deliberately a trigger, not application code that has to remember to
-- call it — this table already has a real, established SECURITY DEFINER
-- trigger precedent in this schema (handle_new_user() on auth.users), and
-- a trigger means every existing call site that already logs an outcome
-- (IntelligenceFeed.jsx, Candidates.jsx) starts contributing automatically,
-- with no frontend change needed at all.
--
-- Stage values matched here are the REAL ones actually written today
-- (verified directly in src/components/IntelligenceFeed.jsx and
-- Candidates.jsx: 'seen', 'dismissed', 'added_to_bd_actions', 'placed') —
-- not signal_outcomes' own original migration comment, which lists
-- 'added_to_crm'/'outreach_drafted' that are never actually inserted
-- anywhere in this codebase. Any stage not explicitly matched (including
-- 'seen', and either of those two unused ones if they're ever wired up
-- later) is treated as neutral on purpose — safer to undercount than to
-- guess at what an unrecognised stage means.
ALTER TABLE public.signal_pool
  ADD COLUMN IF NOT EXISTS dismiss_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS positive_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.record_signal_pool_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dedup_key text;
BEGIN
  -- signal_id is nullable (ON DELETE SET NULL) — a signal that's since been
  -- deleted leaves nothing to attribute this outcome back to.
  IF NEW.signal_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT dedup_key INTO v_dedup_key
  FROM public.intelligence_signals
  WHERE id = NEW.signal_id;

  -- No matching pool entry is the common case for anything that isn't
  -- itself a company-fact-level signal (or predates the pool existing) —
  -- not an error, just nothing to update.
  IF v_dedup_key IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.stage = 'dismissed' THEN
    UPDATE public.signal_pool SET dismiss_count = dismiss_count + 1 WHERE dedup_key = v_dedup_key;
  ELSIF NEW.stage IN ('added_to_bd_actions', 'placed') THEN
    UPDATE public.signal_pool SET positive_count = positive_count + 1 WHERE dedup_key = v_dedup_key;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS signal_outcomes_record_pool_quality ON public.signal_outcomes;
CREATE TRIGGER signal_outcomes_record_pool_quality
  AFTER INSERT ON public.signal_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION public.record_signal_pool_outcome();

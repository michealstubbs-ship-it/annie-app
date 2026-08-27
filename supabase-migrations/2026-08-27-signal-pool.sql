-- Cross-customer signal pool (2026-08-27, Michael's idea: "if one customer
-- has the same market choices as another... share the same data... maybe
-- this could also save credits?").
--
-- Extends a pattern already in production at two other levels —
-- company_enrichment/company_contacts (an objective company fact, once
-- discovered, is reused by every account researching that company) and
-- annie_learned_sources (which companies/sources are worth checking for a
-- sector/market, grown by every account's own scan) — up one more level, to
-- the actual signal EVENT itself: the funding round, the leadership
-- appointment, the live job posting. See scanShared.js's own header above
-- writeToSignalPool for the full reasoning, including exactly what is and
-- isn't pooled (never intro_message, which names one specific recruiter's
-- firm and can't be reused for another).
--
-- No per-customer owner column on purpose — this is a global, cross-account
-- cache, written and read only by the backend scan functions using the
-- service-role key (which bypasses RLS regardless), same shape as
-- company_enrichment/company_contacts. The read policy below matches those
-- tables' own established convention: readable by any logged-in customer
-- (in case a future frontend feature ever wants to show pool state), not
-- writable by one — writes only ever happen server-side.
CREATE TABLE IF NOT EXISTS public.signal_pool (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key text NOT NULL,
  entry_type text NOT NULL DEFAULT 'signal', -- 'signal' | 'live_job'
  signal_type text,
  company text NOT NULL,
  headline text NOT NULL,
  why_it_matters text,
  source_url text,
  source_label text,
  event_at timestamptz,
  who_to_approach text,
  appointed_name text,
  title_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidate_angle text,
  bench_strength_angle text,
  candidate_profile jsonb,
  likely_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The discovering customer's own onboarding selections at the moment this
  -- was found — how a LATER, different customer's overlapping profile is
  -- matched back to this entry (see fetchSignalPoolMatches in
  -- scanShared.js), not Apollo's own free-text industry classification,
  -- which uses a different taxonomy than Annie's sector/function lists and
  -- would be an unreliable match key.
  sectors_hint jsonb NOT NULL DEFAULT '[]'::jsonb,
  locations_hint jsonb NOT NULL DEFAULT '[]'::jsonb,
  functions_hint jsonb NOT NULL DEFAULT '[]'::jsonb,
  found_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per genuinely distinct event, globally — the same fact
-- rediscovered by a second customer's scan is a write-through no-op
-- (ignoreDuplicates), not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS signal_pool_dedup_key_idx ON public.signal_pool (dedup_key);
-- fetchSignalPoolMatches always filters by a recency cutoff first (see its
-- own header — SIGNAL_LOOKBACK_DAYS) before scanning further, same shape as
-- every other recency-ordered read in this schema.
CREATE INDEX IF NOT EXISTS signal_pool_found_at_idx ON public.signal_pool (found_at DESC);

ALTER TABLE public.signal_pool ENABLE ROW LEVEL SECURITY;
CREATE POLICY "signal_pool_select_authenticated" ON public.signal_pool
  FOR SELECT TO authenticated
  USING (true);

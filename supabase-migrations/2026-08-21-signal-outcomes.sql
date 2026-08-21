-- Run this once in the Supabase SQL Editor, same as the other migration file.
-- Foundation for the "signal flywheel" idea: an append-only log of what
-- actually happened after Annie surfaced a signal (seen it, dismissed it,
-- added a contact from it, drafted outreach, or it led to a real placement).
-- Nothing reads or weights this yet, that needs real usage history to build
-- against, this just starts capturing it now so that history exists later.
CREATE TABLE IF NOT EXISTS signal_outcomes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  signal_id uuid references intelligence_signals(id) on delete set null,
  company_name text,
  signal_type text,
  stage text not null, -- seen | dismissed | added_to_crm | outreach_drafted | placed
  created_at timestamptz not null default now()
);

ALTER TABLE signal_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signal_outcomes_select_own" ON signal_outcomes;
CREATE POLICY "signal_outcomes_select_own" ON signal_outcomes
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "signal_outcomes_insert_own" ON signal_outcomes;
CREATE POLICY "signal_outcomes_insert_own" ON signal_outcomes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS signal_outcomes_user_id_idx ON signal_outcomes(user_id);
CREATE INDEX IF NOT EXISTS signal_outcomes_signal_id_idx ON signal_outcomes(signal_id);

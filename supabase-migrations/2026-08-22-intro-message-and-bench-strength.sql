-- Replaces the short-lived "3 generic candidate angle variations" design
-- (candidate_angles jsonb, added 2026-08-21) with a proper 3-part outreach
-- structure per the actual product spec: a ready-to-send intro message, a
-- single speculative/pipeline-aware candidate pitch (candidate_angle,
-- unchanged column from before that experiment), and a bench-strength
-- positioning pitch that names real competitor/peer companies instead of
-- one candidate. candidate_angles is left in place but unused going
-- forward — harmless, not worth a destructive drop.
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-22.
-- Run this once in the Supabase SQL Editor if setting up a fresh environment.
alter table public.intelligence_signals
  add column if not exists intro_message text,
  add column if not exists bench_strength_angle text;

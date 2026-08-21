-- Run this once in the Supabase SQL Editor (Supabase dashboard -> SQL Editor -> New query -> paste -> Run).
-- Adds a column to store the 2-4 job-title keywords Annie's AI already generates
-- for every signal (previously used once for the Apollo contact lookup, then
-- thrown away). Persisting them is what lets the candidate-pool cross-reference
-- match a signal against a recruiter's own candidates.
ALTER TABLE intelligence_signals ADD COLUMN IF NOT EXISTS title_keywords jsonb DEFAULT '[]'::jsonb;

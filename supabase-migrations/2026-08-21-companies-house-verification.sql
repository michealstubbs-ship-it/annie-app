-- Run this once in the Supabase SQL Editor, same as the other migration files.
-- Stores whether a leadership_change signal was independently confirmed
-- against Companies House's public director register, and a short
-- human-readable detail string of what was confirmed.
ALTER TABLE intelligence_signals ADD COLUMN IF NOT EXISTS ch_verified boolean DEFAULT false;
ALTER TABLE intelligence_signals ADD COLUMN IF NOT EXISTS ch_verified_detail text;

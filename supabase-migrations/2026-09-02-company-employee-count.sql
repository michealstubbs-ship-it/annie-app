-- Powers the mega-employer live_job filter (see MEGA_EMPLOYER_HEADCOUNT_THRESHOLD
-- in netlify/functions/lib/scanShared.js): Apollo's own headcount estimate,
-- already fetched on the same companies/search call enrichCompany makes for
-- every entry, just not previously captured or cached. Additive, nullable —
-- a cache row written before this column existed simply reads back null here
-- (treated as "not a known mega-employer", never treated as an error) until
-- that company is next looked up for any other reason and this backfills.
ALTER TABLE public.company_enrichment ADD COLUMN IF NOT EXISTS employee_count integer;

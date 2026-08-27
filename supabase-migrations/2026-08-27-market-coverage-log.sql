-- "Annie always learning" extension #2 (2026-08-27): the 19-scenario staged
-- audit earlier this session was a one-time manual snapshot of which
-- sector/location combinations produce thin results. This makes that an
-- ongoing, self-updating fact Annie tracks from her own real scan history,
-- not something that needs a manual re-audit every few months.
--
-- One row per scan attempt (both scan-now-background.js's first-scan rounds
-- and intelligence-scan.js's recurring per-customer runs), whether or not
-- it found anything — the zero-result runs are exactly the signal this
-- exists to capture; a table of only successes could never tell "genuinely
-- thin market" apart from "just hasn't come up yet". See logMarketCoverage/
-- getMarketCoverageReport in scanShared.js for how this gets written and
-- read.
create table if not exists public.market_coverage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  sectors jsonb not null default '[]'::jsonb,
  locations jsonb not null default '[]'::jsonb,
  functions jsonb not null default '[]'::jsonb,
  found_count integer not null default 0,
  ran_at timestamptz not null default now()
);
create index if not exists market_coverage_log_ran_at_idx on public.market_coverage_log (ran_at desc);

alter table public.market_coverage_log enable row level security;
create policy "market_coverage_log_select_authenticated" on public.market_coverage_log
  for select to authenticated using (true);
-- Server-side only (written from the two scan functions under the service
-- role, which bypasses RLS) — same shape as every other Annie-written,
-- customer-read table in this repo.

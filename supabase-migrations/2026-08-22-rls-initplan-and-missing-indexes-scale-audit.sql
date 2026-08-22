-- Two small, safe, non-breaking fixes surfaced by a full-stack scale-
-- readiness audit (2026-08-22), both already-established patterns elsewhere
-- in this schema — no new design here, just applying it to the two tables
-- that were missed.
--
-- 1. auth.uid() wrapping: 2026-08-21-performance-rls-and-indexes.sql already
-- rewrote auth.uid() -> (select auth.uid()) across a dozen tables so
-- Postgres evaluates it once per query instead of once per row. signal_outcomes
-- and subscriptions were created after that migration and never got the same
-- treatment — confirmed live via pg_policies before this migration. Fixed
-- here, same pattern, no behavior change (same policy, same predicate,
-- just evaluated once instead of per-row).
--
-- 2. Missing indexes flagged by the Supabase performance advisor
-- (error_logs.user_id, account_requests.user_id — unindexed FKs) plus two
-- found by manually checking the actual query shapes the app runs:
-- intelligence_signals is queried filtered by (user_id, status, signal_type)
-- ordered by found_at in the Intelligence Feed, which the existing
-- (user_id, status) index doesn't fully cover; chat_messages/support_messages
-- are read back in created_at order per user (a conversation thread) and
-- only had a bare user_id index.
--
-- Applied directly to the live DB via the Supabase MCP on 2026-08-22 (named
-- `rls_initplan_and_missing_indexes_scale_audit`). Run this once in the
-- Supabase SQL Editor if setting up a fresh environment.

alter policy "signal_outcomes_select_own" on public.signal_outcomes
  using ((select auth.uid()) = user_id);
alter policy "signal_outcomes_insert_own" on public.signal_outcomes
  with check ((select auth.uid()) = user_id);
alter policy "Own subscription read-only" on public.subscriptions
  using ((select auth.uid()) = user_id);

create index if not exists error_logs_user_id_idx on public.error_logs (user_id);
create index if not exists account_requests_user_id_idx on public.account_requests (user_id);

create index if not exists intelligence_signals_user_status_type_found_idx
  on public.intelligence_signals (user_id, status, signal_type, found_at desc);

create index if not exists chat_messages_user_created_idx on public.chat_messages (user_id, created_at);
create index if not exists support_messages_user_created_idx on public.support_messages (user_id, created_at);

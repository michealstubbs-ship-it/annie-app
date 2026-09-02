-- Adds covering indexes for 5 foreign keys the Supabase performance advisor
-- flagged as unindexed (each FK lookup was doing a sequential scan on the
-- referencing table).
-- Applied directly to production via Supabase MCP on 2026-09-02.

create index if not exists admin_ai_insights_reviewed_by_idx on public.admin_ai_insights (reviewed_by);
create index if not exists invoices_candidate_id_idx on public.invoices (candidate_id);
create index if not exists invoices_user_id_idx on public.invoices (user_id);
create index if not exists market_coverage_log_user_id_idx on public.market_coverage_log (user_id);
create index if not exists support_escalations_user_id_idx on public.support_escalations (user_id);

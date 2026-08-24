-- 2026-08-24 Task 3 (performance) finding from the whole-app audit:
-- get_advisors flagged teams.created_by as a foreign key with no covering
-- index — the one genuinely new gap introduced by the same day's
-- teams-and-shared-crm migration. Applied live via the Supabase MCP
-- (`add_index_teams_created_by`).

create index if not exists teams_created_by_idx on public.teams(created_by);

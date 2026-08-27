-- Gap #1 of 2 flagged and fixed at Michael's request (2026-08-27): "are you
-- happy how Annie applies these learnings, or do you see any gaps?" ->
-- "Fix the other two gaps now."
--
-- A company name typed into a customer's own CRM (companies.name, or a
-- candidate's current employer) feeds straight into annie_learned_sources
-- via learn_company_for_sectors (2026-08-27-learn-from-customer-crm.sql),
-- with no verification at all — unlike Annie's own AI-discovered entries,
-- which at least came from a real, found web page. A typo, a placeholder
-- ("Test", "TBC", "N/A"), or leftover test data typed by any one customer
-- would otherwise permanently seed itself into every OTHER customer's scan
-- prompt in that sector, forever, with no cleanup path.
--
-- Two independent guards added to the one shared helper both triggers
-- already call (so both companies and candidates get this for free, no
-- duplicate logic):
--   1. Minimum length of 2 on the normalized key — catches a single
--      stray character, while still allowing real short/initialism company
--      names ("EY", "BP", "3M" all normalize to a 2-character key and pass).
--   2. A small denylist of common CRM placeholder/junk values, checked
--      against the same normalized key so casing/punctuation variants
--      ("N/A", "n/a", "n.a.") all collapse to the same check.
-- Deliberately NOT a stronger content check (e.g. requiring a real-looking
-- company suffix) — that would risk false-positive-rejecting genuine short
-- or unusually-named companies, a worse failure mode than occasionally
-- letting through a plausible-looking but wrong name. This catches the
-- obvious, common junk without guessing at what a "real" company name looks
-- like.
--
-- Near-duplicate casing/whitespace/punctuation variants of the SAME real
-- company ("Acme Corp" vs "acme corp" vs "Acme Corp.") were already handled
-- before this migration — value_key already normalizes and collapses those
-- onto the same row via the table's own unique constraint. This migration
-- only adds the missing piece: rejecting values that are junk in the first
-- place, before they ever reach that dedup step.
create or replace function public.learn_company_for_sectors(p_user_id uuid, p_team_id uuid, p_company text, p_found_via text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sector text;
  v_key text;
  v_sectors text[];
  v_junk_values text[] := array[
    'na', 'n a', 'none', 'unknown', 'test', 'testing', 'tbc', 'tbd', 'tba',
    'xxx', 'asdf', 'nil', 'temp', 'temporary', 'sample', 'example', 'dummy',
    'placeholder', 'company', 'client', 'prospect', 'various', 'n', 'x'
  ];
begin
  if p_company is null or btrim(p_company) = '' then
    return;
  end if;
  v_key := btrim(lower(regexp_replace(btrim(p_company), '[^a-zA-Z0-9]+', ' ', 'g')));
  if v_key = '' or length(v_key) < 2 then
    return;
  end if;
  if v_key = any (v_junk_values) then
    return;
  end if;

  select o.sectors into v_sectors from public.onboarding o where o.user_id = p_user_id;
  if v_sectors is null and p_team_id is not null then
    select o.sectors into v_sectors
    from public.onboarding o
    join public.team_members tm on tm.user_id = o.user_id
    where tm.team_id = p_team_id
    limit 1;
  end if;
  if v_sectors is null then
    return;
  end if;

  foreach v_sector in array v_sectors loop
    insert into public.annie_learned_sources (kind, sector, location, value, value_key, found_via)
    values ('company', v_sector, 'Global', p_company, v_key, p_found_via)
    on conflict (kind, sector, location, value_key) do update set last_confirmed_at = now();
  end loop;
end;
$$;

-- learn_from_customer_company()/learn_from_customer_candidate() and their
-- triggers are untouched — CREATE OR REPLACE above is enough, since they
-- call this function by name and don't need to know its internals changed.

-- Gap #2 of 2: admin visibility. Nothing let anyone browse, search, or
-- remove a bad entry from annie_learned_sources before this — the only way
-- to inspect or clean it was direct SQL. Same SECURITY DEFINER + explicit
-- is_admin check pattern as every function in
-- 2026-08-24-admin-operator-dashboard.sql, applied here for a read (list/
-- search) and a write (delete) — the first admin-gated MUTATION function in
-- this codebase, since every admin action until now has been a read.
create or replace function public.get_admin_learned_sources(p_sector text default null, p_search text default null, p_limit integer default 200)
returns table (
  id uuid, kind text, sector text, location text, value text, found_via text,
  first_seen_at timestamptz, last_confirmed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Aliased as p, not left bare: this function's own RETURNS TABLE
  -- declares an `id` column, which becomes an implicit OUT parameter in
  -- scope for the whole function body — an unqualified `id` here collides
  -- with it instead of clearly meaning profiles.id. This is exactly the
  -- same ambiguous-id bug get_account_requests() already hit and fixed
  -- (see 2026-08-26-recovered-undocumented-schema-gaps-2.sql) — caught here
  -- immediately on first real test, same fix applied.
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true) then
    raise exception 'Not authorized';
  end if;

  return query
  select a.id, a.kind, a.sector, a.location, a.value, a.found_via, a.first_seen_at, a.last_confirmed_at
  from public.annie_learned_sources a
  where (p_sector is null or a.sector = p_sector)
    and (p_search is null or btrim(p_search) = '' or a.value ilike '%' || p_search || '%')
  order by a.last_confirmed_at desc
  limit least(greatest(p_limit, 1), 1000);
end;
$$;

revoke execute on function public.get_admin_learned_sources(text, text, integer) from public, anon;
grant execute on function public.get_admin_learned_sources(text, text, integer) to authenticated;
alter function public.get_admin_learned_sources(text, text, integer) set search_path = public;

create or replace function public.admin_delete_learned_source(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No RETURNS TABLE here, so no OUT-parameter collision risk like
  -- get_admin_learned_sources above — aliased as p anyway, for the same
  -- reason and so the two functions read consistently.
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true) then
    raise exception 'Not authorized';
  end if;

  delete from public.annie_learned_sources where id = p_id;
end;
$$;

revoke execute on function public.admin_delete_learned_source(uuid) from public, anon;
grant execute on function public.admin_delete_learned_source(uuid) to authenticated;
alter function public.admin_delete_learned_source(uuid) set search_path = public;

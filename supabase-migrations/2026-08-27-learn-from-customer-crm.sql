-- "Annie always learning" extension #3 (2026-08-27), Michael: "if someone
-- does join with industries/functions that are harder to get information
-- on, annie should be learning what companies exist in that space through
-- what the customer adds... with every customer that joins and adds
-- information through the CRM, annie is learning new companies, markets,
-- competitors that it should also look into."
--
-- This is exactly annie_learned_sources' own existing mechanism (see that
-- table's header in 2026-08-26-recovered-undocumented-schema-gaps-2.sql
-- and getLearnedSources/recordLearnedDiscoveries in scanShared.js) — Annie
-- already grows her list of companies worth proactively checking per
-- sector/market every time her OWN AI web search discovers a new one. This
-- adds the other real source of that same knowledge: a recruiter who
-- already works a niche Annie's own search struggles with (the exact
-- "harder to get information on" markets the earlier audit flagged) is
-- sitting on ground-truth company knowledge the moment they add a company
-- record or a candidate's current employer to their own CRM. That's
-- exactly the kind of fact this table exists to accumulate — an objective
-- "this company is active in this space" fact, not a customer opinion, so
-- it's shared the same way every other learned source is: across every
-- account researching that sector, not just the one that entered it.
--
-- Deliberately triggers, not application code some future call site has to
-- remember to invoke — same reasoning as record_signal_pool_outcome
-- (2026-08-27-signal-pool-quality-feedback.sql) and the established
-- handle_new_user() precedent on auth.users. A trigger on companies/
-- candidates fires no matter which UI flow added the row today (manual add
-- via CompanySelect.jsx, CSV/LinkedIn import) or however a future one adds
-- rows tomorrow — nothing to keep in sync by hand.
--
-- Sector attribution: resolved from the adding user's own onboarding row
-- first: for a team account where the user who added the record isn't the
-- one who completed onboarding, falls back to any teammate's onboarding row
-- via team_id (companies/candidates carry team_id, auto-populated by an
-- existing trigger before this one runs, since this is AFTER INSERT). No
-- onboarding found either way (a company added before onboarding finished,
-- or test/seed data) is a silent no-op, not an error — there's nothing
-- reliable to attribute it to yet.
--
-- Location is tagged 'Global' rather than guessing which of a multi-market
-- customer's locations this specific company belongs to — getLearnedSources
-- already always includes 'Global' in its own location match regardless of
-- which markets the QUERYING customer selected (see its own header), so a
-- 'Global'-tagged entry is picked up by every future scan researching that
-- sector, in any market, exactly as intended for "a real company known to
-- be active in this space" rather than a market-specific claim nobody
-- actually made.
--
-- value_key here is a simple lowercase/punctuation-stripped approximation,
-- not the exact same normalizeCompanyKey() scanShared.js uses (a SQL
-- trigger can't easily import a JS legal-suffix list without real drift
-- risk) — this is an acceptable, existing tolerance: getLearnedSources'
-- own read path already dedupes by exact string equality only, not
-- normalized variants, so a small amount of near-duplicate tolerance is
-- already baked into how this table has always worked, not a new gap this
-- introduces.
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
begin
  if p_company is null or btrim(p_company) = '' then
    return;
  end if;
  v_key := lower(regexp_replace(btrim(p_company), '[^a-zA-Z0-9]+', ' ', 'g'));
  if v_key = '' then
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

create or replace function public.learn_from_customer_company()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.learn_company_for_sectors(NEW.user_id, NEW.team_id, NEW.name, 'customer-crm-company');
  return NEW;
end;
$$;

drop trigger if exists companies_learn_source on public.companies;
create trigger companies_learn_source
  after insert on public.companies
  for each row execute function public.learn_from_customer_company();

-- A candidate's CURRENT employer (candidates.company, free text — not FK'd
-- to the companies table the way jobs.company_id is) is genuinely
-- additional ground truth beyond what's already captured above: a passive
-- candidate's employer is often a real competitor or peer firm the
-- recruiter never separately logged as a target company, especially via a
-- bulk LinkedIn import.
create or replace function public.learn_from_customer_candidate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.learn_company_for_sectors(NEW.user_id, NEW.team_id, NEW.company, 'customer-crm-candidate');
  return NEW;
end;
$$;

drop trigger if exists candidates_learn_source on public.candidates;
create trigger candidates_learn_source
  after insert on public.candidates
  for each row execute function public.learn_from_customer_candidate();

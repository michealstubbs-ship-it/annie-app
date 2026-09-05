-- Email formats, pooled across customers. Formats only, never addresses.
--
-- Michael, 2026-09-05, verbatim: "We will not steal exact emails of contacts
-- from our customers. What annie does, is learns the exact email format of
-- clients from peoples emails and is able to recommend quality emails to other
-- customers if they have a different contact from the same organisation."
--
-- The general rule this belongs to: SHARE THE FACT ABOUT THE ORGANISATION,
-- NEVER THE RECORD ABOUT THE PERSON. company_enrichment has been a
-- cross-customer cache of exactly that class of fact (domain, industry, logo)
-- since long before this, and is readable by every authenticated user. An
-- email FORMAT is the same class of fact. An email ADDRESS is not, and never
-- crosses a tenant boundary.
--
-- The boundary is enforced by the schema, not by discipline: there is no
-- column here that can hold an address or a name, and the only way to write to
-- this table is an RPC whose signature takes a domain and a format key. A
-- caller could not leak an address through it if they tried.

create table if not exists public.company_email_pattern_votes (
  domain        text not null,
  pattern       text not null,
  user_id       uuid not null references auth.users(id) on delete cascade,
  sample_count  integer not null default 1,
  updated_at    timestamptz not null default now(),
  primary key (domain, pattern, user_id),
  -- Belt and braces. Neither column can hold an address even by accident.
  constraint company_email_pattern_votes_domain_shape check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$' and domain not like '%@%'),
  constraint company_email_pattern_votes_pattern_shape check (pattern ~ '^[a-z._-]{4,20}$' and pattern not like '%@%')
);

comment on table public.company_email_pattern_votes is
  'One row per (organisation domain, email format, customer). Holds no addresses and no names by construction — see 20260905160000_email_patterns.sql.';

alter table public.company_email_pattern_votes enable row level security;

-- No SELECT policy for authenticated on purpose. A row here says "this
-- customer has contacts at this domain", which is a fact about the CUSTOMER.
-- Reads go through email_pattern_for(), which returns only the aggregate.
create policy company_email_pattern_votes_own_write
  on public.company_email_pattern_votes
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index if not exists company_email_pattern_votes_domain_idx
  on public.company_email_pattern_votes (domain);

-- Contribute what this customer's own contacts show about a domain.
--
-- One vote per customer per format per domain, so no single tenant can shout
-- down the others and re-importing the same CSV cannot inflate a count.
create or replace function public.record_email_pattern(p_domain text, p_pattern text, p_samples integer default 1)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.company_email_pattern_votes (domain, pattern, user_id, sample_count, updated_at)
  values (lower(trim(p_domain)), lower(trim(p_pattern)), auth.uid(), greatest(1, coalesce(p_samples, 1)), now())
  on conflict (domain, pattern, user_id) do update
    set sample_count = greatest(public.company_email_pattern_votes.sample_count, excluded.sample_count),
        updated_at = now();
end;
$$;

-- Read the pooled format for one organisation.
--
-- SECURITY DEFINER because the underlying table is deliberately unreadable:
-- the aggregate is a fact about the organisation, the rows are facts about
-- customers. Returns the format the most DISTINCT customers agree on.
create or replace function public.email_pattern_for(p_domain text)
returns table (pattern text, voters integer, samples integer)
language sql
security definer
set search_path = public
stable
as $$
  select v.pattern,
         count(*)::integer as voters,
         sum(v.sample_count)::integer as samples
  from public.company_email_pattern_votes v
  where v.domain = lower(trim(p_domain))
  group by v.pattern
  order by count(*) desc, sum(v.sample_count) desc, v.pattern
  limit 1;
$$;

revoke all on function public.email_pattern_for(text) from public;
grant execute on function public.email_pattern_for(text) to authenticated;
grant execute on function public.record_email_pattern(text, text, integer) to authenticated;

-- Employer quality, pooled across customers. Companies only, never people.
--
-- Michael, 2026-09-05, verbatim, and the rule the whole of this class of
-- feature lives under: "share the fact about the ORGANISATION, never the
-- record about the PERSON."
--
-- WHAT THIS LEARNS. signal_outcomes has been logging what a recruiter
-- actually does with a lead since 21 Aug 2026 — its own file header said
-- "Nothing reads this data yet", and that was still true a fortnight later.
-- Every judgment every customer has ever made about every lead was written
-- down and thrown away. The one thing worth pooling out of it is this: when
-- many DIFFERENT customers park leads at the same company and none of them
-- ever work one, that company is probably not worth a recruiter's morning.
-- That is a fact about the company, in the same class as its domain or its
-- industry, both of which company_enrichment has shared across customers
-- since long before any of this.
--
-- WHAT THIS IS NOT. It is a WEIGHT, not a ban. A firm that is wrong for a
-- retained search desk may be exactly right for a contingency recruiter on
-- smaller roles, so nothing here may hide a lead — it may only rank one
-- lower. The cap is enforced in JS (MAX_EMPLOYER_PENALTY in
-- src/lib/employerSignal.js) and is deliberately smaller than the gap
-- between two rungs of the way-in ladder, so a pooled park can never push a
-- lead you have a real route into below one you do not.
--
-- THE PRIVACY ARGUMENT, in the shape of the precedent this copies exactly
-- (20260905160000_email_patterns.sql):
--
--   1. NO COLUMN CAN HOLD A PERSON. There are three data columns. company_key
--      is a normalised company name. desk is a slug from a closed function
--      taxonomy. verdict is a CHECK-constrained two-value enum. There is no
--      contact id, no signal id, no name, no address, no title, no free text.
--   2. THE RPC SIGNATURE CANNOT CARRY IDENTITY. The only write path is
--      record_parked_employers(desk, parked_keys[], worked_keys[]) — a desk
--      slug and two lists of company keys. A caller could not leak a person
--      through it if they tried.
--   3. A RAW ROW IS A FACT ABOUT A CUSTOMER, so nobody may read one. A row
--      here says "this customer had a lead at this company" — which is
--      exactly the kind of thing that must not cross a tenant boundary. There
--      is no SELECT policy for authenticated. Reads go through
--      parked_employer_signal(), SECURITY DEFINER, which returns counts only.
--   4. THE FLOOR IS THE REAL GUARANTEE. A shape check on company_key cannot
--      tell "aldar properties" from "sarah mansour" — no regex can. So the
--      reader refuses to return anything for a company fewer than
--      MIN_DISTINCT_CUSTOMERS (4) distinct customers have voted on, and that
--      refusal is in SQL, not in the client. Anything a single tenant writes
--      — including anything it wrote maliciously — is unreadable by everyone,
--      its own author included. You cannot probe this table to discover that
--      any particular customer knows anybody anywhere.
--   5. ONE VOTE PER CUSTOMER PER COMPANY, by primary key. Not per park, not
--      per lead. Re-parking the same company ten times, or arriving with a
--      100,000-row CRM, still buys exactly one opinion.

create table if not exists public.parked_employer_votes (
  -- normalizeCompanyName() output: lowercase, legal suffixes stripped,
  -- punctuation collapsed to single spaces. The same key the stream already
  -- uses to decide two names are the same company.
  company_key text not null,
  -- The desk this customer works, slugged from the parent function taxonomy
  -- they chose at onboarding ('finance-accounting', 'construction-built-
  -- environment'). Segmenting is the main defence against Annie getting
  -- NARROWER as she gets more popular — see parked_employer_signal() below.
  desk        text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  verdict     text not null,
  updated_at  timestamptz not null default now(),
  primary key (company_key, user_id),
  -- Belt and braces, same as the email-pattern table. None of these can hold
  -- an address, and verdict cannot hold anything at all but two literals.
  constraint parked_employer_votes_verdict_shape check (verdict in ('parked', 'worked')),
  constraint parked_employer_votes_company_shape check (company_key ~ '^[a-z0-9 ]{2,80}$' and company_key not like '%@%'),
  constraint parked_employer_votes_desk_shape check (desk ~ '^[a-z0-9-]{2,40}$' and desk not like '%@%')
);

comment on table public.parked_employer_votes is
  'One row per (company, customer): did this customer park leads at this employer, or work one? Holds no people and no signals by construction, and is unreadable except as an aggregate over 4+ distinct customers — see 20260905170000_parked_employer_signal.sql.';

alter table public.parked_employer_votes enable row level security;

-- No SELECT policy for authenticated, on purpose and by the same reasoning as
-- company_email_pattern_votes: a row is a fact about a CUSTOMER, the aggregate
-- is a fact about a COMPANY. Only the aggregate is readable, and only through
-- parked_employer_signal().
create policy parked_employer_votes_own_write
  on public.parked_employer_votes
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create index if not exists parked_employer_votes_company_desk_idx
  on public.parked_employer_votes (company_key, desk);

-- Contribute this customer's own verdicts.
--
-- THE SIGNATURE IS THE PRIVACY GUARANTEE, so look at it before anything else:
-- a desk slug and two lists of company keys. Not a signal id, not a contact,
-- not a name, not a date, not a count. There is no argument here through which
-- a person could be passed even by a caller trying to.
--
-- Batched because it is called once per load over the customer's whole outcome
-- history. The email-pattern reader's own comment apologises for being one
-- round trip per domain; this is one round trip, full stop.
--
-- WORKED IS STICKY, AND THAT IS AN ANTI-NARROWING RULE, not a rounding
-- decision. If a customer ever worked a lead at this company, their vote stays
-- positive even when they later park a different lead there: evidence that
-- real business happened is stronger than evidence that somebody triaged a
-- card on a Tuesday, and the asymmetry biases the pool structurally AGAINST
-- suppressing employers. The one thing it must not do is keep a stale positive
-- alive forever, so a park landing on top of a worked vote deliberately does
-- NOT touch updated_at — the positive vote is left to age out of the 180-day
-- window on its own schedule.
create or replace function public.record_parked_employers(p_desk text, p_parked text[], p_worked text[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_desk text := lower(trim(coalesce(p_desk, '')));
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- A vote with no desk is refused rather than pooled into a general bucket.
  -- An unsegmented vote mixes a finance recruiter's judgment with a
  -- construction recruiter's, which is the exact mechanism by which this
  -- feature would make Annie narrower for everybody. Silence is the safe
  -- direction.
  if v_desk = '' or v_desk !~ '^[a-z0-9-]{2,40}$' then
    return;
  end if;

  -- `distinct on (k)` with worked ordered first: a key can arrive in both
  -- lists, and ON CONFLICT DO UPDATE cannot touch the same row twice in one
  -- statement, so the duplicate has to be resolved here — resolved the same
  -- way the sticky rule below resolves it, in favour of worked. The shape
  -- filter is here so one malformed key cannot abort a customer's entire
  -- contribution on a CHECK violation.
  insert into public.parked_employer_votes (company_key, desk, user_id, verdict, updated_at)
  select distinct on (v.k) v.k, v_desk, auth.uid(), v.verdict, now()
  from (
    select unnest((coalesce(p_parked, '{}'::text[]))[1:500]) as k, 'parked'::text as verdict
    union all
    select unnest((coalesce(p_worked, '{}'::text[]))[1:500]) as k, 'worked'::text as verdict
  ) v
  where v.k ~ '^[a-z0-9 ]{2,80}$'
  order by v.k, v.verdict desc  -- 'worked' sorts after 'parked', so desc wins
  on conflict (company_key, user_id) do update
    set desk = excluded.desk,
        verdict = case when public.parked_employer_votes.verdict = 'worked' then 'worked' else excluded.verdict end,
        updated_at = case
          when public.parked_employer_votes.verdict = 'worked' and excluded.verdict = 'parked'
            then public.parked_employer_votes.updated_at
          else now()
        end;
end;
$$;

-- Read the pooled verdict on a batch of employers, for one set of desks.
--
-- SECURITY DEFINER because the underlying table is deliberately unreadable.
-- Returns counts of DISTINCT CUSTOMERS only — count(*) is a distinct-customer
-- count here by construction, because the primary key allows each customer
-- exactly one row per company.
--
-- Three things in this function are the anti-narrowing design, and each one is
-- here to stop a specific failure:
--
--   THE DESK FILTER. Ten finance recruiters parking leads at a contracting
--   firm says nothing about whether that firm is worth a construction desk's
--   time. Votes are only ever counted against callers who work the same desk.
--
--   THE 180-DAY WINDOW. Companies change: new leadership, new funding, a
--   hiring freeze that ended. An employer that was dead for recruiters last
--   year gets a clean hearing this year rather than carrying a permanent
--   record. It also means the pool cannot only ever grow more negative.
--
--   THE FLOOR (4 distinct customers). Below it this returns nothing at all, so
--   the weight does nothing at all. Three was rejected: with three voters a
--   single tenant is a third of the evidence and two customers with similar
--   taste are a "consensus". Four is the smallest number where no one tenant
--   is more than a quarter of the verdict and a majority means more than a
--   pair agreeing. It is also the k in the k-anonymity argument above, which
--   is why it lives in SQL and not in the client.
--
-- Note what is NOT returned: no user ids, no counts of parks (only of
-- customers), and nothing at all about which customer said what.
create or replace function public.parked_employer_signal(p_company_keys text[], p_desks text[])
returns table (company_key text, parked_voters integer, worked_voters integer)
language sql
security definer
set search_path = public
stable
as $$
  select v.company_key,
         count(*) filter (where v.verdict = 'parked')::integer as parked_voters,
         count(*) filter (where v.verdict = 'worked')::integer as worked_voters
  from public.parked_employer_votes v
  -- Sliced rather than rejected: the stream asks about the companies on
  -- screen, which is tens, and a caller asking about ten thousand is either
  -- confused or enumerating.
  where v.company_key = any((coalesce(p_company_keys, '{}'::text[]))[1:100])
    and v.desk = any((coalesce(p_desks, '{}'::text[]))[1:10])
    and v.updated_at > now() - interval '180 days'
  group by v.company_key
  having count(*) >= 4;
$$;

revoke all on function public.parked_employer_signal(text[], text[]) from public;
revoke all on function public.record_parked_employers(text, text[], text[]) from public;
grant execute on function public.parked_employer_signal(text[], text[]) to authenticated;
grant execute on function public.record_parked_employers(text, text[], text[]) to authenticated;

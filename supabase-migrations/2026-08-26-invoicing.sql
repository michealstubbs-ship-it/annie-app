-- Invoicing: lets a recruiter generate and send a real, professional
-- placement-fee invoice to their own client (the company they placed a
-- candidate with), naming the role and the candidate, with the firm's own
-- bank details on it for the client to pay by transfer. This does NOT
-- collect payment itself (no card charge, no payment link, nobody's money
-- moves through this) — it produces a document and emails it, exactly like
-- any standalone invoice-generator tool. "Paid" is a status the recruiter
-- sets themselves once they've actually been paid by their own bank
-- transfer, not something Annie verifies.
--
-- Team-scoped throughout, same pattern as every other CRM table added
-- since 2026-08-24 (contacts/companies/jobs/etc): a `team_id` column,
-- backfilled by the existing `fill_team_id()` trigger from the inserting
-- user's active team membership, RLS scoped to team membership. Unlike
-- those tables, there's no legacy per-user data to stay backward-
-- compatible with here — invoicing is brand new — so the RLS below is the
-- simpler pure-team check, no `team_id is null` fallback branch needed.

-- ---------------------------------------------------------------------
-- 1. invoicing_details — one row per team: the firm's own info that goes
--    on every invoice (business details, bank details for the client to
--    pay into, default currency/payment terms), plus the atomic invoice-
--    number counter.
-- ---------------------------------------------------------------------
create table if not exists public.invoicing_details (
  team_id uuid primary key references public.teams(id) on delete cascade,
  business_name text,
  business_address text,
  business_email text,
  business_phone text,
  tax_number text, -- VAT / Tax Registration Number, optional — not every market requires one
  bank_account_name text,
  bank_name text,
  bank_account_number text,
  bank_sort_code text, -- UK-style sort code; leave blank outside markets that use one
  bank_iban text,
  bank_swift_bic text,
  default_currency text not null default 'AED', -- matches Jobs.jsx's own fee_value display and Annie's core UAE/GCC market
  default_payment_terms_days integer not null default 14,
  invoice_footer_note text,
  next_invoice_number integer not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.invoicing_details enable row level security;

create policy "invoicing_details_team_only" on public.invoicing_details
  for all using (
    team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active')
  ) with check (
    team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active')
  );

-- ---------------------------------------------------------------------
-- 2. invoices
-- ---------------------------------------------------------------------
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade, -- who created it; fill_team_id() resolves team_id from this
  created_by_name text, -- best-effort snapshot of the creator's name at send time, for the invoice's own "prepared by" line
  invoice_number text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'void')),
  company_id uuid references public.companies(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  candidate_id uuid references public.candidates(id) on delete set null,
  bill_to_name text not null,
  bill_to_email text,
  bill_to_address text,
  currency text not null default 'AED',
  issue_date date not null default current_date,
  due_date date,
  subtotal numeric(12,2) not null default 0,
  tax_rate numeric(5,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  notes text,
  sent_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, invoice_number)
);
alter table public.invoices enable row level security;
create index if not exists invoices_team_id_idx on public.invoices(team_id);
create index if not exists invoices_company_id_idx on public.invoices(company_id);
create index if not exists invoices_job_id_idx on public.invoices(job_id);

create policy "invoices_team_only" on public.invoices
  for all using (
    team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active')
  ) with check (
    team_id in (select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active')
  );

drop trigger if exists trg_fill_team_id on public.invoices;
create trigger trg_fill_team_id before insert on public.invoices
  for each row execute function public.fill_team_id();

-- ---------------------------------------------------------------------
-- 3. invoice_line_items — most invoices are one placement-fee line, but a
--    real agency invoice sometimes needs a second line (an adjustment, a
--    rebate, a second fee) — supporting more than one from the start
--    avoids a schema change the first time that comes up.
-- ---------------------------------------------------------------------
create table if not exists public.invoice_line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  description text not null,
  quantity numeric(10,2) not null default 1,
  unit_amount numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  sort_order integer not null default 0
);
alter table public.invoice_line_items enable row level security;
create index if not exists invoice_line_items_invoice_id_idx on public.invoice_line_items(invoice_id);

-- Scoped through the parent invoice's own team check rather than
-- duplicating a team_id column onto line items — a line item's access
-- rule is always "can you access the invoice it belongs to."
create policy "invoice_line_items_via_invoice" on public.invoice_line_items
  for all using (
    invoice_id in (
      select id from public.invoices where team_id in (
        select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'
      )
    )
  ) with check (
    invoice_id in (
      select id from public.invoices where team_id in (
        select team_id from public.team_members where user_id = (select auth.uid()) and status = 'active'
      )
    )
  );

-- ---------------------------------------------------------------------
-- 4. Atomic invoice numbering — INSERT/UPDATE...RETURNING, the same
--    concurrency-safe pattern this codebase already relies on for credit
--    reservation (apollo_reserve_credits etc), not a read-then-write pair
--    two concurrent teammates could race. Format: INV-{year}-{4-digit
--    sequence}. The sequence is a single ever-incrementing per-team
--    counter, not reset each calendar year (INV-2026-0001, INV-2027-0002,
--    ...) — deliberate: a continuous, gapless invoice sequence is what
--    most tax/audit regimes actually expect, not a cosmetic once-a-year
--    reset back to 0001.
-- ---------------------------------------------------------------------
create or replace function public.next_invoice_number(p_team_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  update public.invoicing_details
  set next_invoice_number = next_invoice_number + 1, updated_at = now()
  where team_id = p_team_id
  returning next_invoice_number - 1 into v_next;

  if v_next is null then
    insert into public.invoicing_details (team_id, next_invoice_number)
    values (p_team_id, 2)
    on conflict (team_id) do update set next_invoice_number = invoicing_details.next_invoice_number + 1
    returning next_invoice_number - 1 into v_next;
  end if;

  return 'INV-' || to_char(now(), 'YYYY') || '-' || lpad(v_next::text, 4, '0');
end;
$$;
revoke all on function public.next_invoice_number(uuid) from public, anon;
grant execute on function public.next_invoice_number(uuid) to authenticated;

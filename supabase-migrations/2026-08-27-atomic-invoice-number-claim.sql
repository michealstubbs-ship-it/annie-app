-- Closes a real race condition in send-invoice.js, flagged in the 2026-08-27
-- fresh audit: that function reads invoice.invoice_number, and only calls
-- next_invoice_number() when it's still null. Two "Send" clicks on the same
-- draft invoice at nearly the same moment (a double-click, or two tabs)
-- both read null before either commits its own write back, so both mint a
-- DISTINCT number via next_invoice_number() for what is really one invoice
-- -- gapping the sequence next_invoice_number was specifically built to
-- keep gapless, and (worse, customer-visible) potentially emailing the
-- client two different invoice numbers for what they'll see as the same
-- bill, depending on which request's final UPDATE lands last.
--
-- next_invoice_number() itself is already safe against two DIFFERENT
-- invoices racing for the next number in the sequence (its own UPDATE...
-- RETURNING is a single atomic statement) -- the gap is specifically
-- "did THIS ONE invoice already get a number", which nothing serialized.
--
-- Fix: a single new SECURITY DEFINER function that does the whole
-- check-then-maybe-mint-then-write sequence atomically, using `select ...
-- for update` to take a row-level lock on the specific invoice being sent.
-- A second concurrent call for the SAME invoice_id blocks on that lock
-- until the first call's transaction finishes, then sees invoice_number
-- already set and simply returns it -- no second number is ever minted.
-- Two DIFFERENT invoices (even for the same team) are unaffected and can
-- still be claimed concurrently, since the lock is per-row, not per-team.
--
-- Membership check happens unconditionally, before either branch, using
-- the same team_members.status = 'active' check next_invoice_number()
-- itself already relies on (2026-08-27-next-invoice-number-team-guard.sql)
-- -- this function is reachable directly via PostgREST like any other
-- exposed RPC, not just through send-invoice.js's own RLS-scoped read.
create or replace function public.claim_invoice_number(p_invoice_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_existing text;
  v_new text;
begin
  select team_id, invoice_number into v_team_id, v_existing
  from public.invoices
  where id = p_invoice_id
  for update;

  if v_team_id is null then
    raise exception 'Invoice not found';
  end if;

  if not exists (
    select 1 from public.team_members
    where user_id = auth.uid() and team_id = v_team_id and status = 'active'
  ) then
    raise exception 'Not authorized';
  end if;

  if v_existing is not null then
    return v_existing;
  end if;

  v_new := public.next_invoice_number(v_team_id);

  update public.invoices set invoice_number = v_new where id = p_invoice_id;

  return v_new;
end;
$$;

revoke all on function public.claim_invoice_number(uuid) from public, anon;
grant execute on function public.claim_invoice_number(uuid) to authenticated;

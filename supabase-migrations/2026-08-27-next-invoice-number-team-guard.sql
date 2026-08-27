-- Closes a real gap found during pre-launch review, not an advisor false
-- positive: next_invoice_number(p_team_id uuid) is SECURITY DEFINER and
-- granted to `authenticated` (2026-08-26-invoicing.sql) with no internal
-- check that the caller actually belongs to p_team_id. Its one legitimate
-- caller, send-invoice.js, only ever reaches it with a team_id that came
-- from an RLS-scoped read of the caller's own invoices row, so normal use
-- is fine -- but the RPC itself is directly callable by any authenticated
-- user via PostgREST with an arbitrary team_id, same as any other exposed
-- RPC, and RLS on `invoices`/`invoicing_details` doesn't protect a function
-- called out of that context. A malicious or just curious signed-in
-- customer could call it directly against a team_id they don't belong to
-- and burn/advance another team's invoice sequence -- not a data leak, but
-- a real integrity problem (skipped/duplicated invoice numbers for a team
-- that never asked for either).
--
-- Fix mirrors the same internal-guard pattern already used by every other
-- admin-style SECURITY DEFINER function in this codebase (get_error_logs,
-- get_support_conversations, admin_account_summary, etc) -- those check
-- profiles.is_admin; this one has no single "admin" concept, so it checks
-- the equivalent real membership fact instead: an active row in
-- team_members for (auth.uid(), p_team_id), the same membership check
-- already relied on elsewhere in this file (see the RLS policy above) and
-- in getCustomerWatchlistCompanies (scanShared.js).
create or replace function public.next_invoice_number(p_team_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  if not exists (
    select 1 from public.team_members
    where user_id = auth.uid() and team_id = p_team_id and status = 'active'
  ) then
    raise exception 'Not authorized';
  end if;

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
-- grants unchanged -- the function was already correctly restricted to
-- authenticated (not anon/public); the fix is the internal check above,
-- not the grant.
revoke all on function public.next_invoice_number(uuid) from public, anon;
grant execute on function public.next_invoice_number(uuid) to authenticated;

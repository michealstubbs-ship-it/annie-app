import { supabase } from '../supabase'

// One row per team (invoicing_details.team_id is its primary key) — the
// firm's own business/bank details that go on every invoice, plus the
// atomic invoice-number counter (never read/written directly here; see
// next_invoice_number()/the migration's own comment for why that's an RPC
// rather than a plain read-then-increment).

export async function getInvoicingDetails() {
  // RLS already scopes this to the caller's own team, and team_id is the
  // primary key, so there's at most one row a caller can ever see.
  const { data, error } = await supabase.from('invoicing_details').select('*').maybeSingle()
  if (error) throw error
  return data
}

// Upserts by team_id — but team_id isn't known client-side (it's resolved
// server-side via team_members, same as every other team-scoped write in
// this app), so this always goes through the same
// select-then-insert-or-update flow other team-scoped "settings" writes
// use: try an update first (RLS confines it to the caller's own row if one
// exists), and if nothing existed to update, insert a fresh row — team_id
// on that insert is filled in by whichever policy/trigger the DB already
// uses for this table. invoicing_details has no fill_team_id trigger
// (unlike contacts/companies/etc — see the migration), because team_id is
// its PRIMARY KEY, not an incidental scoping column, so it's resolved
// explicitly here instead via the same team_members lookup the RLS itself
// uses, rather than relying on a trigger to backfill a primary key after
// the fact.
export async function saveInvoicingDetails(fields, userId) {
  const { data: membership, error: memErr } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()
  if (memErr) throw memErr
  if (!membership) throw new Error('No active team found for this account')

  const { data, error } = await supabase
    .from('invoicing_details')
    .upsert({ team_id: membership.team_id, ...fields, updated_at: new Date().toISOString() }, { onConflict: 'team_id' })
    .select()
    .single()
  if (error) throw error
  return data
}

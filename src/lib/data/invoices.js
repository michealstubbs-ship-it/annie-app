import { supabase } from '../supabase'

// Same pattern as jobs.js/candidates.js/companies.js: invoices/
// invoicing_details are team-scoped by RLS, so nothing here adds a
// client-side team_id/user_id filter on top of it — every read/write
// already throws on a Supabase error instead of silently falling back to
// `data || []`, per this codebase's own established fix for that class of
// bug (see contacts.js's header comment for the original reasoning).

export async function listInvoices() {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, companies(name), jobs(title), candidates(name)')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function getInvoice(id) {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, companies(name), jobs(title, fee_value), candidates(name), invoice_line_items(*)')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

// Creates the invoice row and its line items together. Line items are
// inserted as a second call rather than a nested Postgres write — simpler,
// and matches how every other one-to-many write in this codebase already
// works (e.g. team-data-request.mjs's per-table pass) rather than reaching
// for a stored procedure for what's a two-step client-side operation.
export async function createInvoice(invoiceRow, lineItems, userId) {
  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .insert({ ...invoiceRow, user_id: userId })
    .select()
    .single()
  if (invErr) throw invErr

  if (lineItems?.length) {
    const rows = lineItems.map((li, i) => ({
      invoice_id: invoice.id,
      description: li.description,
      quantity: li.quantity,
      unit_amount: li.unitAmount,
      amount: li.amount,
      sort_order: i,
    }))
    const { error: liErr } = await supabase.from('invoice_line_items').insert(rows)
    // The invoice row already exists at this point — a line-item insert
    // failure shouldn't leave an orphaned, empty invoice silently sitting
    // in the list with no indication anything went wrong.
    if (liErr) throw liErr
  }

  return invoice
}

export async function updateInvoice(id, row) {
  const { data, error } = await supabase.from('invoices').update(row).eq('id', id).select().single()
  if (error) throw error
  return data
}

// Replaces every line item on an existing (still-draft) invoice — simpler
// and less error-prone than diffing added/edited/removed rows client-side
// for what's always a short list (a handful of lines at most).
export async function replaceLineItems(invoiceId, lineItems) {
  const { error: delErr } = await supabase.from('invoice_line_items').delete().eq('invoice_id', invoiceId)
  if (delErr) throw delErr
  if (!lineItems?.length) return
  const rows = lineItems.map((li, i) => ({
    invoice_id: invoiceId,
    description: li.description,
    quantity: li.quantity,
    unit_amount: li.unitAmount,
    amount: li.amount,
    sort_order: i,
  }))
  const { error: insErr } = await supabase.from('invoice_line_items').insert(rows)
  if (insErr) throw insErr
}

export async function deleteInvoice(id) {
  const { error } = await supabase.from('invoices').delete().eq('id', id)
  if (error) throw error
}

export async function markInvoicePaid(id) {
  return updateInvoice(id, { status: 'paid', paid_at: new Date().toISOString() })
}

export async function voidInvoice(id) {
  return updateInvoice(id, { status: 'void' })
}

// 2026-08-31: with in-app Send disabled (Michael's own call, after the
// annie@mail.meetannie.ai reply concern) — invoices now leave Annie
// through the recruiter's own email, not a click here. This still does
// what "Send" used to do to the invoice ROW itself: mint its permanent
// number via the same atomic RPC send-invoice.js has always used
// (claim_invoice_number is SECURITY DEFINER and re-checks team
// membership itself — 2026-08-27-atomic-invoice-number-claim.sql — so
// it's safe to call directly from the client, same trust boundary as any
// other RLS-respecting call in this file), then flips status to 'sent'
// so it shows as outstanding and can be marked paid later. It just never
// emails anything — send-invoice.js is left in place, untouched, for if
// this gets switched back on.
export async function markInvoiceSent(id) {
  const { data: invoiceNumber, error: claimErr } = await supabase.rpc('claim_invoice_number', { p_invoice_id: id })
  if (claimErr) throw claimErr
  return updateInvoice(id, { invoice_number: invoiceNumber, status: 'sent', sent_at: new Date().toISOString() })
}

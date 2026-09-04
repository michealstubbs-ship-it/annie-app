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

// 2026-09-08, gap-analysis batch 9 ("invoices don't show up on the job or
// company they're for"): every invoice already stores its own company_id/
// job_id (set on creation via InvoiceFormModal's CompanySelect/job picker),
// but nothing ever read either back scoped to ONE company or job —
// Companies.jsx and JobPipeline.jsx only ever showed contacts/jobs/
// documents or pipeline candidates, with billing living in a completely
// separate bucket from the client/mandate it's actually for. These mirror
// listInvoices' own join shape, just scoped, and without the extra
// companies(name)/candidates(name) joins the caller already has on hand
// (a company already knows its own name; a job page doesn't need it
// re-joined either).
export async function listInvoicesForCompany(companyId) {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, jobs(title), candidates(name)')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function listInvoicesForJob(jobId) {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, candidates(name)')
    .eq('job_id', jobId)
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

// 2026-09-03, Michael ("rebate/guarantee period tracking"): records that a
// rebate/free replacement was actually invoked on this placement — a
// distinct, explicit action from just editing the invoice, since it's the
// one field that answers "did the guarantee period actually get used"
// (getGuaranteeStatus in invoiceCalc.js treats a non-null
// rebate_triggered_at as its own state regardless of days remaining).
// `triggeredAt` defaults to today but is a parameter rather than always
// `new Date()` — a recruiter logging this a few days after the fact (the
// candidate actually left on the 12th, they're recording it on the 15th)
// should be able to backdate it to when it really happened.
export async function triggerRebate(id, notes, triggeredAt = new Date().toISOString().slice(0, 10)) {
  return updateInvoice(id, { rebate_triggered_at: triggeredAt, rebate_notes: notes || null })
}

// Undoes triggerRebate — a recruiter who clicked it by mistake, or logged
// it before confirming, needs a way back rather than being stuck.
export async function clearRebateTrigger(id) {
  return updateInvoice(id, { rebate_triggered_at: null, rebate_notes: null })
}

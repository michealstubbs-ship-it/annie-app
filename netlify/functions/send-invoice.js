// Sends a real invoice to a recruiter's own client: generates the PDF
// (invoicePdf.js), emails it with the firm's own bank details attached
// (sendInvoiceEmail), assigns the invoice's permanent number on first send
// only, and marks the invoice 'sent'. This never charges a card or moves
// money itself — see the migration's own header comment for why that's
// deliberate. "Sending" here means "produce the document and email it",
// exactly like a standalone invoice-generator tool.
//
// Auth: same pattern as every other customer-facing function (auth.js) —
// identity always comes from the caller's own verified session token, never
// the request body. Deliberately uses the AUTHED client (not a service-role
// client) for every read/write here, not just the auth check: invoices/
// invoice_line_items/invoicing_details are all RLS-scoped to the caller's
// own team, so the authed client already enforces "you can only send your
// own team's invoices" for free — a service-role client would need that
// same check re-implemented by hand, which is exactly the kind of
// duplicated authorization logic getAuthedUser itself was written to stop
// (see auth.js's own header comment).
import { getAuthedClient } from './lib/auth.js'
import { generateInvoicePdf } from './lib/invoicePdf.js'
import { sendInvoiceEmail } from './lib/email.js'
import { reportServerError } from './lib/reportError.js'

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async (req) => {
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' })

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) return jsonResponse(500, { error: 'Not configured' })

  const { client: supabase, user, error: authError } = await getAuthedClient(req, supabaseUrl, anonKey)
  if (authError || !supabase) return jsonResponse(401, { error: 'Not authenticated' })

  let body
  try {
    body = await req.json()
  } catch {
    return jsonResponse(400, { error: 'Invalid request body' })
  }

  const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId : null
  if (!invoiceId) return jsonResponse(400, { error: 'invoiceId is required' })

  try {
    // RLS confines this to an invoice the caller's own team can see — a
    // stray/foreign invoiceId simply comes back null, same as any other
    // not-found, not a 403 that would leak whether the id exists at all.
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select('*, companies(name), jobs(title), candidates(name), invoice_line_items(*)')
      .eq('id', invoiceId)
      .maybeSingle()
    if (invErr) throw invErr
    if (!invoice) return jsonResponse(404, { error: 'Invoice not found' })
    if (invoice.status === 'void') return jsonResponse(400, { error: 'This invoice has been voided and cannot be sent' })
    if (!invoice.bill_to_email) return jsonResponse(400, { error: 'This invoice has no client email address to send to' })

    const { data: details, error: detailsErr } = await supabase.from('invoicing_details').select('*').maybeSingle()
    if (detailsErr) throw detailsErr

    // Invoice number is assigned once, on the first successful send —
    // resending an already-sent invoice (e.g. after editing a note) must
    // never mint a second number for the same invoice, which is why this
    // is gated on invoice.invoice_number already being set, not on
    // invoice.status.
    let invoiceNumber = invoice.invoice_number
    if (!invoiceNumber) {
      const { data: numberData, error: numberErr } = await supabase.rpc('next_invoice_number', { p_team_id: invoice.team_id })
      if (numberErr) throw numberErr
      invoiceNumber = numberData
    }

    // Best-effort "prepared by" snapshot — never worth failing the send
    // over, same reasoning as support-escalate.js's own firmName lookup.
    let createdByName = invoice.created_by_name || null
    if (!createdByName) {
      const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
      createdByName = profile?.full_name || null
    }

    const invoiceForPdf = { ...invoice, invoice_number: invoiceNumber, created_by_name: createdByName }
    const pdfBytes = await generateInvoicePdf(invoiceForPdf, invoice.invoice_line_items, details)
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64')
    const pdfFilename = `${invoiceNumber}.pdf`

    const sent = await sendInvoiceEmail(invoice.bill_to_email, {
      firmName: details?.business_name,
      senderName: createdByName,
      invoiceNumber,
      total: Number(invoice.total).toFixed(2),
      currency: invoice.currency,
      dueDate: invoice.due_date,
      pdfBase64,
      pdfFilename,
    })
    if (!sent) {
      // Not configured, or Resend itself rejected/failed the send — the
      // invoice number (if freshly minted above) is already committed, by
      // design: a gapless sequence matters more than never wasting a
      // number on a failed attempt, and the caller can just retry the send
      // with the same, now-permanent, number rather than the email ever
      // showing two different numbers for what's the same invoice.
      await reportServerError('send-invoice', new Error('Resend send failed or not configured'), { invoiceId })
      return jsonResponse(502, { error: 'Could not send the email — please try again in a moment' })
    }

    const { data: updated, error: updateErr } = await supabase
      .from('invoices')
      .update({
        invoice_number: invoiceNumber,
        created_by_name: createdByName,
        status: 'sent',
        sent_at: new Date().toISOString(),
      })
      .eq('id', invoiceId)
      .select()
      .single()
    if (updateErr) throw updateErr

    return jsonResponse(200, { invoice: updated })
  } catch (err) {
    await reportServerError('send-invoice', err, { invoiceId })
    return jsonResponse(500, { error: 'Something went wrong sending this invoice' })
  }
}

// Lets a recruiter preview/download the exact PDF their client would
// receive, without sending an email — for checking a draft before it goes
// out, or re-downloading a copy of one already sent. Deliberately reuses
// the same generateInvoicePdf() as send-invoice.js (see invoicePdf.js's own
// header comment) so what's downloaded here is always byte-for-byte the
// same document email delivery attaches.
//
// Auth: same Authorization-header pattern as every other function
// (getAuthedClient, auth.js). Security fix, 2026-08-27 audit: this used to
// read the caller's real session access token from a URL query param
// (?token=...) so a plain <a>/window.open() navigation could reach it
// without setting a header. That token is a full bearer credential, not
// scoped to this one download — anywhere that URL could be captured
// (Netlify/CDN access logs, browser history, a shared screenshot) leaked a
// token replayable against ANY authenticated endpoint, not just this one.
// invoiceApi.js's getInvoiceDownloadUrl() now fetches this as a blob with a
// real Authorization header instead of navigating a plain link, so the
// token never appears in a URL at all.
import { getAuthedClient } from './lib/auth.js'
import { generateInvoicePdf } from './lib/invoicePdf.js'
import { reportServerError } from './lib/reportError.js'

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  const url = new URL(req.url)
  const invoiceId = url.searchParams.get('invoiceId')
  if (!invoiceId) {
    return new Response(JSON.stringify({ error: 'invoiceId is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const { client: supabase, error: authError } = await getAuthedClient(req, supabaseUrl, anonKey)
  if (authError || !supabase) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    // Same RLS-scoped authed client as send-invoice.js — a foreign
    // invoiceId simply comes back null rather than a 403.
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select('*, companies(name), jobs(title), candidates(name), invoice_line_items(*)')
      .eq('id', invoiceId)
      .maybeSingle()
    if (invErr) throw invErr
    if (!invoice) return new Response(JSON.stringify({ error: 'Invoice not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })

    const { data: details, error: detailsErr } = await supabase.from('invoicing_details').select('*').maybeSingle()
    if (detailsErr) throw detailsErr

    const pdfBytes = await generateInvoicePdf(invoice, invoice.invoice_line_items, details)
    const filename = `${invoice.invoice_number || 'draft-invoice'}.pdf`

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    await reportServerError('download-invoice', err, { invoiceId })
    return new Response(JSON.stringify({ error: 'Could not generate this invoice PDF' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

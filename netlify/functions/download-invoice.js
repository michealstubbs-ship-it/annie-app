// Lets a recruiter preview/download the exact PDF their client would
// receive, without sending an email — for checking a draft before it goes
// out, or re-downloading a copy of one already sent. Deliberately reuses
// the same generateInvoicePdf() as send-invoice.js (see invoicePdf.js's own
// header comment) so what's downloaded here is always byte-for-byte the
// same document email delivery attaches.
//
// GET, not POST: a plain link/window.open() download needs a GET request
// the browser can navigate to directly (Invoices.jsx opens this in a new
// tab), carrying the session token as a query param since a simple <a>
// link/new-tab navigation can't attach an Authorization header. The token
// is still verified exactly like every bearer-token call elsewhere (see
// auth.js) — it's just read from the query string instead of the header
// for this one function.
import { createClient } from '@supabase/supabase-js'
import { createTimeoutFetch } from './lib/scanShared.js'
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
  const token = url.searchParams.get('token')
  if (!invoiceId || !token) {
    return new Response(JSON.stringify({ error: 'invoiceId and token are required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` }, fetch: createTimeoutFetch() },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: authData, error: authErr } = await supabase.auth.getUser(token)
  if (authErr || !authData?.user) {
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

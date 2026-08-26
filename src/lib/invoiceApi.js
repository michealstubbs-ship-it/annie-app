// Talks to send-invoice.js / download-invoice.js — the two Netlify
// Functions that actually generate the PDF (email it, or hand it straight
// back for a download). Same session-token pattern as every other
// authenticated function call in this codebase (see confirmContact.js,
// resolveSignalContact.js).
import { supabase } from './supabase'

async function getToken() {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Your session has expired. Please log in again.')
  return token
}

// Emails the invoice to its bill_to_email with the PDF attached, assigning
// its permanent invoice number on first send. Returns the updated invoice
// row (now status 'sent', with its invoice_number set).
export async function sendInvoice(invoiceId) {
  const token = await getToken()
  const resp = await fetch('/.netlify/functions/send-invoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ invoiceId }),
  })
  const body = await resp.json().catch(() => ({}))
  if (!resp.ok) throw new Error(body?.error || 'Could not send this invoice')
  return body.invoice
}

// Returns a URL that opens/downloads the invoice PDF directly — used as a
// plain link target (window.open), not a fetch, so the browser handles the
// PDF response itself. The session token has to travel as a query param
// here rather than an Authorization header, since a browser navigation
// can't attach custom headers — see download-invoice.js's own header
// comment for why that's still safely verified server-side.
export async function getInvoiceDownloadUrl(invoiceId) {
  const token = await getToken()
  return `/.netlify/functions/download-invoice?invoiceId=${encodeURIComponent(invoiceId)}&token=${encodeURIComponent(token)}`
}

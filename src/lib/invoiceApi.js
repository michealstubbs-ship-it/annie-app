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

// Fetches the invoice PDF with a real Authorization header (same pattern as
// sendInvoice above) and returns a short-lived local blob: URL to open it in
// a new tab. Security fix, 2026-08-27 audit: this used to just build a plain
// URL with the caller's real session token as a `?token=` query param, for
// window.open() to navigate to directly — that token is a full bearer
// credential, not scoped to this one download, and a URL is exactly the
// kind of thing that ends up in browser history, Netlify/CDN access logs, or
// a shared screenshot. Fetching it here instead means the token only ever
// travels in a header, never a URL. Caller should revoke the returned blob
// URL (URL.revokeObjectURL) once the new tab has had a chance to load it —
// see Invoices.jsx's handleDownload.
export async function fetchInvoicePdfBlobUrl(invoiceId) {
  const token = await getToken()
  const resp = await fetch(`/.netlify/functions/download-invoice?invoiceId=${encodeURIComponent(invoiceId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error(body?.error || 'Could not open this invoice')
  }
  const blob = await resp.blob()
  return URL.createObjectURL(blob)
}

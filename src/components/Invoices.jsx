import React, { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { listInvoices, getInvoice, deleteInvoice, markInvoicePaid, voidInvoice } from '../lib/data/invoices'
import { sendInvoice, fetchInvoicePdfBlobUrl } from '../lib/invoiceApi'
import { formatMoney } from '../lib/invoiceCalc'
import { resolveMarketCurrencyCode, DEFAULT_CURRENCY_CODE } from '../lib/marketCurrency'
import { supabase } from '../lib/supabase'
import InvoiceFormModal from './InvoiceFormModal'
import ConfirmDialog from './ConfirmDialog'
import ErrorBanner from './ErrorBanner'
import InfoTip from './InfoTip'
import Spinner from './Spinner'

const STATUS_LABEL = { draft: 'Draft', sent: 'Sent', paid: 'Paid', void: 'Void' }
const STATUS_COLOR = {
  draft: 'bg-gray-100 text-gray-500',
  sent: 'bg-amber-100 text-amber-700',
  paid: 'bg-green-100 text-green-700',
  void: 'bg-red-100 text-red-400',
}

// 2026-08-31 audit fix: "Sent" used to be the only word this page ever had
// for what happened to the email — true the moment Resend's API accepted
// the request, but silently still true forever after, even if it actually
// bounced or got flagged as spam by the client's own mail server (see
// resend-webhook.js for the delivery-tracking half of this fix). Only the
// two outcomes actually worth interrupting the recruiter for get a line —
// 'pending'/'delivered' stay invisible on purpose, same "don't show a
// confidently wrong number, and don't show noise either" principle as the
// currency-totals fix above.
const DELIVERY_WARNING = {
  bounced: "This email bounced — it didn't reach the client's inbox. Check the address and resend.",
  complained: 'The client marked this email as spam. Worth reaching out another way.',
}

export default function Invoices() {
  const { user } = useAuth()
  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editInvoice, setEditInvoice] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [confirmVoidId, setConfirmVoidId] = useState(null)
  const [sendingId, setSendingId] = useState(null)
  const [editLoadingId, setEditLoadingId] = useState(null)
  const [rowError, setRowError] = useState({})
  // 2026-08-29 audit fix: this summary bar hardcoded 'AED' — Annie's own
  // home market, not necessarily this account's. Resolved from the
  // account's own onboarding market instead, same source Overview.jsx and
  // Pipeline.jsx already use. Still used below as the account's own default
  // (sorted first, and the fallback bucket for an invoice with no currency
  // set) — but 2026-08-31 audit fix: it's no longer the ONLY currency the
  // summary bar can report in. See currencyTotals below.
  const [displayCurrency, setDisplayCurrency] = useState(DEFAULT_CURRENCY_CODE)

  useEffect(() => { load() }, [user])

  useEffect(() => {
    if (!user) return
    // Best-effort — a failure here just leaves the sensible GBP default in
    // place, never worth surfacing as a page error over a summary label.
    supabase.from('onboarding').select('locations').eq('user_id', user.id).single()
      .then(({ data }) => setDisplayCurrency(resolveMarketCurrencyCode(data?.locations)), () => {})
  }, [user])

  async function load() {
    setLoading(true)
    setListError('')
    try {
      const data = await listInvoices()
      setInvoices(data)
    } catch (err) {
      setListError(err.message || 'Could not load your invoices. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  function openAdd() { setEditInvoice(null); setShowModal(true) }

  // 2026-08-31 audit fix, a real, confirmed data-loss bug: this used to hand
  // the row straight from listInvoices() to the form — but that query never
  // selects invoice_line_items (getInvoice(id) just below already does; it
  // was just never called from here). The form read invoice.invoice_line_items
  // straight off that row, always found it undefined, and rendered one blank
  // line item — so an invoice was effectively write-once: opening any saved
  // invoice showed no line items at all, and hitting Save either got
  // rejected ("Add at least one line item with a description", the row you
  // see is blank) or, worse, succeeded and silently replaced the real line
  // items with that one empty row (replaceLineItems does a delete-then-
  // insert). This affected View just as much as Edit — the locked/read-only
  // path renders from the same invoice.invoice_line_items. Now fetches the
  // real row (with its line items) before opening the form either way.
  async function openEdit(inv) {
    setRowErr(inv.id, '')
    setEditLoadingId(inv.id)
    try {
      const full = await getInvoice(inv.id)
      setEditInvoice(full || inv)
      setShowModal(true)
    } catch (err) {
      setRowErr(inv.id, err.message || 'Could not open this invoice')
    } finally {
      setEditLoadingId(null)
    }
  }
  function setRowErr(id, msg) { setRowError(prev => ({ ...prev, [id]: msg })) }

  async function del(id) {
    setRowErr(id, '')
    try {
      await deleteInvoice(id)
      setInvoices(prev => prev.filter(i => i.id !== id))
    } catch (err) {
      setRowErr(id, err.message || 'Could not delete this invoice')
    }
  }

  async function handleSend(inv) {
    setSendingId(inv.id)
    setRowErr(inv.id, '')
    try {
      const updated = await sendInvoice(inv.id)
      setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, ...updated } : i))
    } catch (err) {
      setRowErr(inv.id, err.message || 'Could not send this invoice')
    } finally {
      setSendingId(null)
    }
  }

  // 2026-08-31 audit fix: "Download PDF" didn't download anything — it
  // opened the PDF in a new tab via window.open(), and if a popup blocker
  // stopped that (the default in most browsers for a window.open() call it
  // doesn't consider "clearly user-triggered") the customer got nothing at
  // all, silently: window.open() returns null rather than throwing when
  // blocked, and the try/catch below only ever covered fetchInvoicePdfBlobUrl's
  // own network call, which had already succeeded by that point. Switched to
  // a real download: a temporary <a download> element, clicked
  // programmatically. That's not the same behaviour with an error message
  // bolted on — an anchor click like this isn't a window.open() call at
  // all, so it was never subject to popup blocking in the first place, and
  // it does what the button has always claimed to do.
  async function handleDownload(inv) {
    setRowErr(inv.id, '')
    try {
      const blobUrl = await fetchInvoicePdfBlobUrl(inv.id)
      const filename = `${inv.invoice_number || 'draft-invoice'}.pdf`
      const link = document.createElement('a')
      link.href = blobUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      // The blob only needs to live long enough for the browser to hand it
      // off to the file system — revoked shortly after, same reasoning as
      // the previous new-tab approach's own revoke, just no longer needing
      // to wait out a tab's page-load.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000)
    } catch (err) {
      setRowErr(inv.id, err.message || 'Could not download this invoice')
    }
  }

  async function handleMarkPaid(inv) {
    setRowErr(inv.id, '')
    try {
      const updated = await markInvoicePaid(inv.id)
      setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, ...updated } : i))
    } catch (err) {
      setRowErr(inv.id, err.message || 'Could not update this invoice')
    }
  }

  async function handleVoid(id) {
    setRowErr(id, '')
    try {
      const updated = await voidInvoice(id)
      setInvoices(prev => prev.map(i => i.id === id ? { ...i, ...updated } : i))
    } catch (err) {
      setRowErr(id, err.message || 'Could not void this invoice')
    }
  }

  // 2026-08-31 audit fix, a real, confirmed bug: this used to sum every
  // invoice's raw `total` into one combined number regardless of that
  // invoice's own `currency` — a known limitation flagged (but not fixed)
  // in an earlier pass, since confirmed live: with one GBP invoice
  // outstanding and one AED invoice added, the header read "£41,920.00
  // outstanding" — literally £31,920 + 10,000 added together as though
  // AED and GBP were the same unit. Annie supports five currencies across
  // two target markets (UK and GCC); this was never a one-currency-only
  // edge case. Now buckets by each invoice's own currency and shows one
  // correctly-labelled total per currency actually in use, instead of one
  // confidently wrong number.
  const currencyTotals = useMemo(() => {
    const byCurrency = new Map()
    for (const inv of invoices) {
      const currency = inv.currency || displayCurrency
      if (!byCurrency.has(currency)) byCurrency.set(currency, { unpaid: 0, paid: 0 })
      const t = byCurrency.get(currency)
      if (inv.status === 'sent') t.unpaid += Number(inv.total) || 0
      if (inv.status === 'paid') t.paid += Number(inv.total) || 0
    }
    // Nothing billed yet — show the account's own market currency at zero
    // rather than an empty summary line.
    if (!byCurrency.size) byCurrency.set(displayCurrency, { unpaid: 0, paid: 0 })
    return [...byCurrency.entries()]
      .sort(([a], [b]) => (a === displayCurrency ? -1 : b === displayCurrency ? 1 : a.localeCompare(b)))
      .map(([currency, totals]) => ({ currency, ...totals }))
  }, [invoices, displayCurrency])

  function InvoiceRow({ inv }) {
    const roleLine = [inv.jobs?.title, inv.candidates?.name].filter(Boolean).join(' · ')
    return (
      <div className="card p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* 2026-08-29 audit fix: a draft has no invoice_number yet
                  (numbers are only claimed on send, so an abandoned draft
                  never burns a gap in the sequence — see the atomic
                  invoice-numbering work elsewhere in this codebase) — but
                  every draft just read as the bare word "Draft" with
                  nothing to tell two drafts apart in a list. The issue date
                  is already on the row and unique enough in practice to
                  serve as an identifier until a real number exists. */}
              <h3 className="font-bold text-navy text-sm">
                {inv.invoice_number || (inv.issue_date ? `Draft · ${new Date(inv.issue_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Draft')}
              </h3>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${STATUS_COLOR[inv.status]}`}>{STATUS_LABEL[inv.status]}</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{inv.companies?.name || inv.bill_to_name}</p>
            {roleLine && <p className="text-xs text-gray-500 mt-0.5">{roleLine}</p>}
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
              <span className="font-semibold text-navy tabular-nums">{formatMoney(inv.total, inv.currency)}</span>
              {inv.due_date && <span>Due {new Date(inv.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
            </div>
            {DELIVERY_WARNING[inv.email_delivery_status] && (
              <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                <span aria-hidden="true">⚠</span> {DELIVERY_WARNING[inv.email_delivery_status]}
              </p>
            )}
            {rowError[inv.id] && <p className="text-xs text-red-600 mt-1">{rowError[inv.id]}</p>}
          </div>
          {/* 2026-08-29 audit fix: Void/Delete used to sit in the same
              plain-text row as every routine action, one word away from
              "Mark paid"/"Send" with nothing but a faint colour telling
              them apart (Void was even styled neutral gray, undersling how
              irreversible it is) — a real mis-click risk on a document
              already sent to a client. Routine and destructive actions are
              now two visually separated groups (a border + extra gap), and
              both destructive actions share the same red styling so
              "irreversible" reads as one consistent signal. The confirm
              dialogs below were already in place for Delete/Void before
              this fix — this closes the visual-adjacency risk on top of
              that, not instead of it. */}
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
            <div className="flex gap-2 flex-wrap justify-end">
              {inv.status === 'draft' && <button onClick={() => openEdit(inv)} disabled={editLoadingId === inv.id} className="text-xs text-gold-ink font-semibold hover:underline disabled:opacity-50">{editLoadingId === inv.id ? 'Opening...' : 'Edit'}</button>}
              {inv.status !== 'draft' && <button onClick={() => openEdit(inv)} disabled={editLoadingId === inv.id} className="text-xs text-gray-500 font-semibold hover:underline disabled:opacity-50">{editLoadingId === inv.id ? 'Opening...' : 'View'}</button>}
              <button onClick={() => handleDownload(inv)} className="text-xs text-gold-ink font-semibold hover:underline">Download PDF</button>
              {(inv.status === 'draft') && (
                <button onClick={() => handleSend(inv)} disabled={sendingId === inv.id} className="text-xs text-navy font-semibold hover:underline disabled:opacity-50">
                  {sendingId === inv.id ? 'Sending...' : 'Send'}
                </button>
              )}
              {inv.status === 'sent' && (
                <button onClick={() => handleSend(inv)} disabled={sendingId === inv.id} className="text-xs text-navy font-semibold hover:underline disabled:opacity-50">
                  {sendingId === inv.id ? 'Resending...' : 'Resend'}
                </button>
              )}
              {inv.status === 'sent' && <button onClick={() => handleMarkPaid(inv)} className="text-xs text-green-600 font-semibold hover:underline">Mark paid</button>}
            </div>
            {(inv.status === 'draft' || inv.status === 'sent') && (
              <div className="flex gap-2 flex-wrap justify-end pl-3 ml-1 border-l border-gray-200">
                {inv.status === 'draft' && <button onClick={() => setConfirmDeleteId(inv.id)} className="text-xs text-red-500 font-semibold hover:underline">Delete</button>}
                <button onClick={() => setConfirmVoidId(inv.id)} className="text-xs text-red-500 font-semibold hover:underline">Void</button>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            Invoices
            <InfoTip text="Generate a professional placement-fee invoice naming the role and candidate placed, with your own bank details on it. Annie never collects payment itself — your client pays you directly by bank transfer, and you mark it paid yourself once it lands." />
          </h1>
          <p className="text-gray-500 mt-1">
            {currencyTotals.map((c, i) => (
              <span key={c.currency}>
                {i > 0 && <span className="mx-2 text-gray-300">·</span>}
                {formatMoney(c.unpaid, c.currency)} outstanding, {formatMoney(c.paid, c.currency)} paid
              </span>
            ))}
          </p>
        </div>
        {/* 2026-08-31 audit fix, cosmetic: every other page's primary create
            button follows "+ Add {Entity}" in Title Case (Contact, Job,
            Company, Deal, Task, Candidate) — Meetings' own "+ Log Meeting"
            is the one deliberate exception, matching that whole page's
            established "log a meeting" voice throughout its copy. This
            button was the one true outlier: lowercase "invoice" and a
            different verb ("New") that isn't used anywhere else on this
            same page either — the empty state below says "Create your
            first invoice". Conformed to the dominant convention. */}
        <button onClick={openAdd} className="btn-primary">+ Add Invoice</button>
      </div>

      <ErrorBanner>{listError}</ErrorBanner>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Spinner /></div>
      ) : invoices.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🧾</div>
          <h3 className="font-bold text-navy mb-1">No invoices yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Bill a client for a placement. Fill in your business and bank details in Settings first, so they're ready to go on your first invoice.</p>
          <button onClick={openAdd} className="btn-primary">Create your first invoice</button>
        </div>
      ) : (
        <div className="space-y-3">{invoices.map(inv => <InvoiceRow key={inv.id} inv={inv} />)}</div>
      )}

      <InvoiceFormModal
        open={showModal}
        invoice={editInvoice}
        onClose={() => setShowModal(false)}
        onSaved={() => load()}
      />

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => del(confirmDeleteId)}
        title="Delete this draft invoice?"
        message="This can't be undone. Only draft invoices (never sent) can be deleted — a sent invoice should be voided instead, to keep the numbering sequence intact."
        confirmLabel="Delete"
      />

      <ConfirmDialog
        open={!!confirmVoidId}
        onClose={() => setConfirmVoidId(null)}
        onConfirm={() => handleVoid(confirmVoidId)}
        title="Void this invoice?"
        message="A voided invoice is kept for your records but marked cancelled — its number is never reused."
        confirmLabel="Void invoice"
      />
    </div>
  )
}

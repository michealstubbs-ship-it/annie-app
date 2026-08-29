import React, { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { listInvoices, deleteInvoice, markInvoicePaid, voidInvoice } from '../lib/data/invoices'
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
  const [rowError, setRowError] = useState({})
  // 2026-08-29 audit fix: this summary bar hardcoded 'AED' — Annie's own
  // home market, not necessarily this account's. Resolved from the
  // account's own onboarding market instead, same source Overview.jsx and
  // Pipeline.jsx already use. Known limitation, not fixed here: unpaidTotal/
  // paidTotal below sum every invoice's raw `total` regardless of that
  // invoice's own currency — correct for the common case of one market per
  // account, but a genuinely mixed-currency account would need real
  // per-currency subtotals, not just the right label on a combined sum.
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
  function openEdit(inv) { setEditInvoice(inv); setShowModal(true) }
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

  async function handleDownload(inv) {
    setRowErr(inv.id, '')
    try {
      const blobUrl = await fetchInvoicePdfBlobUrl(inv.id)
      window.open(blobUrl, '_blank', 'noopener')
      // Revoke once the new tab has had a chance to load the PDF — the blob
      // URL only needs to live long enough for that navigation to fetch it.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
    } catch (err) {
      setRowErr(inv.id, err.message || 'Could not open this invoice')
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

  const { unpaidTotal, paidTotal } = useMemo(() => {
    let unpaid = 0, paid = 0
    for (const inv of invoices) {
      if (inv.status === 'sent') unpaid += Number(inv.total) || 0
      if (inv.status === 'paid') paid += Number(inv.total) || 0
    }
    return { unpaidTotal: unpaid, paidTotal: paid }
  }, [invoices])

  function InvoiceRow({ inv }) {
    const roleLine = [inv.jobs?.title, inv.candidates?.name].filter(Boolean).join(' · ')
    return (
      <div className="card p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-navy text-sm">{inv.invoice_number || 'Draft'}</h3>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${STATUS_COLOR[inv.status]}`}>{STATUS_LABEL[inv.status]}</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{inv.companies?.name || inv.bill_to_name}</p>
            {roleLine && <p className="text-xs text-gray-500 mt-0.5">{roleLine}</p>}
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
              <span className="font-semibold text-navy tabular-nums">{formatMoney(inv.total, inv.currency)}</span>
              {inv.due_date && <span>Due {new Date(inv.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
            </div>
            {rowError[inv.id] && <p className="text-xs text-red-600 mt-1">{rowError[inv.id]}</p>}
          </div>
          <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
            {inv.status === 'draft' && <button onClick={() => openEdit(inv)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>}
            {inv.status !== 'draft' && <button onClick={() => openEdit(inv)} className="text-xs text-gray-500 font-semibold hover:underline">View</button>}
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
            {inv.status === 'draft' && <button onClick={() => setConfirmDeleteId(inv.id)} className="text-xs text-red-400 font-semibold hover:underline">Delete</button>}
            {(inv.status === 'sent' || inv.status === 'draft') && <button onClick={() => setConfirmVoidId(inv.id)} className="text-xs text-gray-400 font-semibold hover:underline">Void</button>}
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
            {formatMoney(unpaidTotal, displayCurrency)} outstanding · {formatMoney(paidTotal, displayCurrency)} paid
          </p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ New invoice</button>
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

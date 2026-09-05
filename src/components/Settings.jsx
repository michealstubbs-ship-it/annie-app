import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { callChat } from '../lib/callChat'
import { useScanStatusPoll, triggerScanNow } from '../lib/useScanStatusPoll'
import { getInvoicingDetails, saveInvoicingDetails } from '../lib/data/invoicingDetails'
import { getOnboardingLocations } from '../lib/data/onboarding'
import { CURRENCY_OPTIONS } from '../lib/invoiceCalc'
import { resolveMarketCurrencyCode, DEFAULT_CURRENCY_CODE } from '../lib/marketCurrency'
import { withTimeout } from '../lib/withTimeout'
import ConfirmDialog from './ConfirmDialog'
import EmailConnect from './EmailConnect'
import ErrorBanner from './ErrorBanner'

// Matches the old LOCAL_POLL_WINDOW_MS this page used to hand-roll: local
// feedback for up to 3 minutes, matching how long a scan usually takes to
// at least report *something*. If it's still running after that, Overview's
// own longer-lived poll (autoDetectExisting, up to the scan's real
// wall-clock budget) picks up the same status via the same localStorage
// flag, so nothing is lost by not waiting here forever.
const LOCAL_POLL_WINDOW_MS = 3 * 60 * 1000

export default function Settings() {
  const navigate = useNavigate()
  const { user, profile, refreshProfile } = useAuth()
  const [form, setForm] = useState({ full_name: '', firm_name: '', job_title: '', phone: '' })
  const [onboarding, setOnboarding] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [profileError, setProfileError] = useState('')

  const [pastedMessages, setPastedMessages] = useState('')
  const [writingStyle, setWritingStyle] = useState('')
  const [analysing, setAnalysing] = useState(false)
  // 2nd-pass audit fix: these used to be one shared `styleError` rendered
  // via two <ErrorBanner> instances (one below the paste box, one below the
  // save button) — any single error, from either action, showed up TWICE,
  // and a save() failure specifically rendered its copy below the
  // unrelated "paste messages" box, misleadingly suggesting that action had
  // also failed. Split so each action's error renders once, next to the
  // control it actually belongs to.
  const [pasteError, setPasteError] = useState('')
  const [saveStyleError, setSaveStyleError] = useState('')
  const [styleSaving, setStyleSaving] = useState(false)
  const [styleSaved, setStyleSaved] = useState(false)

  // Low/polish item from the pre-launch audit: no self-serve export/delete
  // flow existed, and the fallback "email support" process didn't exist
  // either. This is that process — a real intake mechanism (account_requests,
  // admin-visible) rather than a promise with nothing behind it, even before
  // a transactional email provider is wired in to notify anyone automatically.
  const [requestPending, setRequestPending] = useState({ export: false, delete: false })
  const [requestError, setRequestError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // "Run a new scan": until this existed, scan-now-background.js (the
  // research pass) only ever had one caller — the onboarding "Launch Annie"
  // button — and could only ever fire once per account, ever. A customer
  // whose first pass came back empty (a transient API failure, a quiet
  // first attempt, anything) had no self-serve way to ask Annie to try
  // again; someone had to reset a database column by hand. This is that
  // self-serve path. The backend now cooldown-gates it (see
  // RESCAN_COOLDOWN_MS in scan-now-background.js) instead of blocking
  // forever, so repeated use is throttled, not permanently locked out.
  // 2026-08-26 audit fix: this used to hand-roll its own copy of the exact
  // fetch + localStorage-flag + recursive-setTimeout polling logic
  // useScanStatusPoll.js already existed to share with Overview.jsx —
  // routed through the real hook now instead of a second, drifting copy.
  const [starting, setStarting] = useState(false)
  const [scanError, setScanError] = useState('')
  const { polling: scanRunning, result: scanResult, start: startScanPoll } = useScanStatusPoll({ user, windowMs: LOCAL_POLL_WINDOW_MS })
  const scanState = starting ? 'starting' : scanRunning ? 'running' : scanResult ? 'done' : 'idle'

  // Invoicing details: the firm's own business/bank info that goes on
  // every invoice — one row per team (see invoicingDetails.js), loaded
  // and saved independently of the profile form above since it lives in
  // its own table, not on `profiles`.
  const EMPTY_INVOICING = {
    business_name: '', business_address: '', business_email: '', business_phone: '', tax_number: '',
    bank_account_name: '', bank_name: '', bank_account_number: '', bank_sort_code: '', bank_iban: '', bank_swift_bic: '',
    // 2026-08-29 audit fix: was hardcoded 'AED' — Annie's own home market,
    // not necessarily this account's. GBP is a neutral, UK-first fallback;
    // loadInvoicingDetails() below upgrades this to the account's real
    // onboarding market as soon as it loads, for any account that's never
    // explicitly set a default currency here.
    default_currency: DEFAULT_CURRENCY_CODE, default_payment_terms_days: 14, invoice_footer_note: '',
  }
  const [invoicingForm, setInvoicingForm] = useState(EMPTY_INVOICING)
  const [invoicingLoaded, setInvoicingLoaded] = useState(false)
  const [invoicingSaving, setInvoicingSaving] = useState(false)
  const [invoicingSaved, setInvoicingSaved] = useState(false)
  const [invoicingError, setInvoicingError] = useState('')

  useEffect(() => {
    if (profile) setForm({ full_name: profile.full_name || '', firm_name: profile.firm_name || '', job_title: profile.job_title || '', phone: profile.phone || '' })
    loadOnboarding()
    loadAccountRequests()
    loadInvoicingDetails()
  }, [profile])

  async function loadInvoicingDetails() {
    if (!user) return
    try {
      // Fetched independently rather than reading the `onboarding` state
      // set by loadOnboarding() elsewhere in this same mount effect — the
      // two calls aren't sequenced against each other, so relying on that
      // state here could read it before it's populated. 2026-08-29 audit
      // fix: if this account has never explicitly saved an invoicing
      // default, the currency shown used to just be EMPTY_INVOICING's
      // hardcoded 'AED' regardless of the account's own market — now
      // resolved from onboarding instead, same source Overview.jsx/
      // Pipeline.jsx/InvoiceFormModal.jsx all use.
      const [data, locations] = await Promise.all([getInvoicingDetails(), getOnboardingLocations(user.id)])
      if (data) setInvoicingForm({ ...EMPTY_INVOICING, ...data })
      else setInvoicingForm(prev => ({ ...prev, default_currency: resolveMarketCurrencyCode(locations) }))
    } catch {
      // Best-effort load — an empty form (falling back to EMPTY_INVOICING
      // defaults) is a safe, harmless failure state here; saving still
      // works and simply creates the row on first save.
    } finally {
      setInvoicingLoaded(true)
    }
  }

  async function saveInvoicing() {
    setInvoicingSaving(true)
    setInvoicingError('')
    try {
      const fields = {
        ...invoicingForm,
        default_payment_terms_days: Number(invoicingForm.default_payment_terms_days) || 14,
      }
      const saved = await saveInvoicingDetails(fields, user.id)
      setInvoicingForm({ ...EMPTY_INVOICING, ...saved })
      setInvoicingSaved(true)
      setTimeout(() => setInvoicingSaved(false), 3000)
    } catch (err) {
      setInvoicingError(err.message || 'Could not save your invoicing details. Please try again.')
    } finally {
      setInvoicingSaving(false)
    }
  }

  async function loadAccountRequests() {
    if (!user) return
    const { data } = await supabase.from('account_requests').select('request_type, status').eq('user_id', user.id).eq('status', 'pending')
    const pending = { export: false, delete: false }
    for (const r of data || []) pending[r.request_type] = true
    setRequestPending(pending)
  }

  async function fileAccountRequest(requestType) {
    setRequestError('')
    const { error } = await supabase.from('account_requests').insert({ user_id: user.id, email: user.email, request_type: requestType })
    if (error) { setRequestError('Could not submit your request. Please try again, or reach out through support chat.'); return }
    setRequestPending(prev => ({ ...prev, [requestType]: true }))
  }

  async function loadOnboarding() {
    const { data } = await supabase.from('onboarding').select('*').eq('user_id', user.id).single()
    setOnboarding(data)
    setWritingStyle(data?.writing_style || '')
  }

  async function saveProfile() {
    setSaving(true)
    setProfileError('')
    // 2026-08-26 audit finding: this write's error used to go unchecked —
    // the UI showed "Saved!" regardless of whether the update actually
    // persisted, the same unchecked-write bug already found (and fixed) in
    // stripe-webhook.js's subscriptions upsert. Every sibling save handler
    // in this codebase (Companies.jsx, Contacts.jsx, etc.) already checks
    // `error` and surfaces it — this brings Settings in line.
    const { error } = await supabase.from('profiles').update({ ...form, updated_at: new Date().toISOString() }).eq('id', user.id)
    setSaving(false)
    if (error) {
      setProfileError('Could not save your profile. Please try again.')
      return
    }
    await refreshProfile()
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  async function analyseStyle() {
    if (!pastedMessages.trim() || pastedMessages.trim().length < 40) {
      setPasteError('Paste in a few real messages you\'ve actually sent, at least a couple of sentences each, so Annie has enough to work from.')
      return
    }
    setAnalysing(true)
    setPasteError('')
    try {
      const systemPrompt = `You analyse a person's real written communication style from examples of messages they've actually sent, so an AI writing on their behalf can sound authentically like them.

Read the pasted messages below and produce a concise style profile (120-180 words) covering: typical sentence length and structure, vocabulary/formality level, how they open and close messages, any recurring phrases or habits, use of punctuation, and overall tone. Be specific and descriptive, not generic. Write it as instructions an AI could follow, e.g. "Opens with a direct question rather than a greeting. Uses short sentences, rarely more than 15 words. Signs off with 'Cheers,' not 'Best regards.'"

Only return the style profile text, nothing else.`

      const { text } = await callChat({
        messages: [{ role: 'user', content: pastedMessages.trim() }],
        systemOverride: systemPrompt,
        maxTokens: 500,
      })
      setWritingStyle((text || '').trim())
    } catch (err) {
      setPasteError('Could not analyse right now. Please try again.')
    } finally {
      setAnalysing(false)
    }
  }

  async function saveWritingStyle() {
    setStyleSaving(true)
    setSaveStyleError('')
    // Same unchecked-write fix as saveProfile above — this used to
    // optimistically update local state and show "Saved!" even if the
    // write itself failed.
    const { error } = await supabase.from('onboarding').update({ writing_style: writingStyle.trim() || null }).eq('user_id', user.id)
    setStyleSaving(false)
    if (error) {
      setSaveStyleError('Could not save your writing style. Please try again.')
      return
    }
    setOnboarding(prev => prev ? { ...prev, writing_style: writingStyle.trim() || null } : prev)
    setStyleSaved(true)
    setTimeout(() => setStyleSaved(false), 3000)
  }

  async function runNewScan() {
    setStarting(true)
    setScanError('')
    try {
      // 2026-08-29 audit fix: same unwrapped getSession() hang fixed
      // elsewhere this session (callChat.js, ResetPassword.jsx,
      // SupportWidget.jsx) — a "Run a new scan" click could sit spinning
      // forever with no error if this promise simply never settled, rather
      // than throwing something the catch below could show.
      const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000, 'settings-scan-session')
      if (!session?.access_token) throw new Error('Your session has expired. Please log in again.')

      // 2026-08-27 audit fix: this used to fire-and-forget the raw POST
      // (this is still a background function with up to a 15-minute
      // wall-clock budget, so the response never carries the actual scan
      // result) — but it never checked whether the trigger itself was even
      // accepted. See triggerScanNow's own header for why that mattered:
      // a rejected trigger used to look identical to a real scan starting.
      const started = await triggerScanNow(session.access_token)
      if (!started) {
        setScanError("Couldn't start a new scan just now. Please try again.")
        return
      }

      // useScanStatusPoll.start() sets the same localStorage flag
      // Overview.jsx watches for the post-onboarding scan — so the "Annie
      // is researching" banner shows up there too if the user navigates
      // over, for free, no separate wiring — and begins polling scan-
      // status.js itself.
      startScanPoll()
    } catch (err) {
      setScanError(err.message || 'Could not start a new scan. Please try again.')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-navy">Settings</h1>
        <p className="text-gray-500 mt-1">Manage your account and preferences</p>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-lg font-bold text-navy mb-4">Your Profile</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label" htmlFor="settings-full-name">Full name</label><input id="settings-full-name" className="input" value={form.full_name} onChange={e => setForm(p => ({ ...p, full_name: e.target.value }))} /></div>
            <div><label className="label" htmlFor="settings-job-title">Job title</label><input id="settings-job-title" className="input" value={form.job_title} onChange={e => setForm(p => ({ ...p, job_title: e.target.value }))} /></div>
          </div>
          <div><label className="label" htmlFor="settings-firm-name">Firm name</label><input id="settings-firm-name" className="input" value={form.firm_name} onChange={e => setForm(p => ({ ...p, firm_name: e.target.value }))} /></div>
          <div><label className="label" htmlFor="settings-phone">Phone</label><input id="settings-phone" className="input" type="tel" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} /></div>
          <div><label className="label" htmlFor="settings-email">Email</label><input id="settings-email" className="input opacity-60 cursor-not-allowed" value={user?.email || ''} disabled /></div>
        </div>
        <ErrorBanner>{profileError}</ErrorBanner>
        <div className="flex items-center gap-3 mt-5">
          <button onClick={saveProfile} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save changes'}</button>
          {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-lg font-bold text-navy mb-1">LinkedIn contacts</h2>
        <p className="text-sm text-gray-500 mb-4">Import or re-import your LinkedIn connections. Annie only adds contacts matching the filters you set.</p>
        <button onClick={() => navigate('/dashboard/import-linkedin')} className="btn-primary">Import LinkedIn contacts</button>
      </div>

      {/* Sits directly under LinkedIn contacts because both answer the same
          question — "where do Annie's contacts come from?" — and because a
          recruiter who just imported LinkedIn is exactly who should be offered
          the mailbox next. */}
      <EmailConnect />

      <div className="card p-6 mb-6">
        <h2 className="text-lg font-bold text-navy mb-1">Invoicing details</h2>
        <p className="text-sm text-gray-500 mb-4">These details appear on every invoice you send from Annie — your business info at the top, your bank details for clients to pay into. Fill this in once before sending your first invoice.</p>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label" htmlFor="inv-business-name">Business name</label><input id="inv-business-name" className="input" value={invoicingForm.business_name || ''} onChange={e => setInvoicingForm(p => ({ ...p, business_name: e.target.value }))} /></div>
            <div><label className="label" htmlFor="inv-tax-number">Tax / VAT number</label><input id="inv-tax-number" className="input" value={invoicingForm.tax_number || ''} onChange={e => setInvoicingForm(p => ({ ...p, tax_number: e.target.value }))} /></div>
          </div>
          <div><label className="label" htmlFor="inv-business-address">Business address</label><textarea id="inv-business-address" className="input resize-none" rows={2} value={invoicingForm.business_address || ''} onChange={e => setInvoicingForm(p => ({ ...p, business_address: e.target.value }))} /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label" htmlFor="inv-business-email">Business email</label><input id="inv-business-email" type="email" className="input" value={invoicingForm.business_email || ''} onChange={e => setInvoicingForm(p => ({ ...p, business_email: e.target.value }))} /></div>
            <div><label className="label" htmlFor="inv-business-phone">Business phone</label><input id="inv-business-phone" className="input" value={invoicingForm.business_phone || ''} onChange={e => setInvoicingForm(p => ({ ...p, business_phone: e.target.value }))} /></div>
          </div>

          <div className="border-t border-gray-100 pt-4">
            <h3 className="text-sm font-bold text-navy mb-3">Bank details</h3>
            <p className="text-xs text-gray-400 mb-3">Annie doesn't collect payment itself — invoices are paid by bank transfer straight to you, using the details below.</p>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="label" htmlFor="inv-bank-account-name">Account name</label><input id="inv-bank-account-name" className="input" value={invoicingForm.bank_account_name || ''} onChange={e => setInvoicingForm(p => ({ ...p, bank_account_name: e.target.value }))} /></div>
              <div><label className="label" htmlFor="inv-bank-name">Bank name</label><input id="inv-bank-name" className="input" value={invoicingForm.bank_name || ''} onChange={e => setInvoicingForm(p => ({ ...p, bank_name: e.target.value }))} /></div>
              <div><label className="label" htmlFor="inv-bank-account-number">Account number</label><input id="inv-bank-account-number" className="input" value={invoicingForm.bank_account_number || ''} onChange={e => setInvoicingForm(p => ({ ...p, bank_account_number: e.target.value }))} /></div>
              <div><label className="label" htmlFor="inv-bank-sort-code">Sort code</label><input id="inv-bank-sort-code" className="input" value={invoicingForm.bank_sort_code || ''} onChange={e => setInvoicingForm(p => ({ ...p, bank_sort_code: e.target.value }))} /></div>
              <div><label className="label" htmlFor="inv-bank-iban">IBAN</label><input id="inv-bank-iban" className="input" value={invoicingForm.bank_iban || ''} onChange={e => setInvoicingForm(p => ({ ...p, bank_iban: e.target.value }))} /></div>
              <div><label className="label" htmlFor="inv-bank-swift">SWIFT / BIC</label><input id="inv-bank-swift" className="input" value={invoicingForm.bank_swift_bic || ''} onChange={e => setInvoicingForm(p => ({ ...p, bank_swift_bic: e.target.value }))} /></div>
            </div>
          </div>

          <div className="border-t border-gray-100 pt-4 grid grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="inv-default-currency">Default currency</label>
              <select id="inv-default-currency" className="input" value={invoicingForm.default_currency || DEFAULT_CURRENCY_CODE} onChange={e => setInvoicingForm(p => ({ ...p, default_currency: e.target.value }))}>
                {CURRENCY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
              {/* 2026-08-31: this used to only affect a new invoice's default — now
                  useMarketCurrency() checks it everywhere (Pipeline, Overview, Candidates,
                  Jobs), so it's worth explaining why a firm working more than one market
                  would come here rather than just relying on their onboarding market. */}
              <p className="text-xs text-gray-400 mt-1">Also sets the currency shown across your dashboard, Pipeline and CRM — handy if you work across more than one market.</p>
            </div>
            <div><label className="label" htmlFor="inv-payment-terms">Default payment terms (days)</label><input id="inv-payment-terms" type="number" min="0" className="input" value={invoicingForm.default_payment_terms_days ?? 14} onChange={e => setInvoicingForm(p => ({ ...p, default_payment_terms_days: e.target.value }))} /></div>
          </div>
          <div><label className="label" htmlFor="inv-footer-note">Invoice footer note</label><textarea id="inv-footer-note" className="input resize-none" rows={2} placeholder="e.g. Thank you for your business." value={invoicingForm.invoice_footer_note || ''} onChange={e => setInvoicingForm(p => ({ ...p, invoice_footer_note: e.target.value }))} /></div>
        </div>

        <ErrorBanner>{invoicingError}</ErrorBanner>
        <div className="flex items-center gap-3 mt-5">
          <button onClick={saveInvoicing} disabled={invoicingSaving || !invoicingLoaded} className="btn-primary">{invoicingSaving ? 'Saving...' : 'Save invoicing details'}</button>
          {invoicingSaved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-lg font-bold text-navy mb-1">Writing style</h2>
        <p className="text-sm text-gray-500 mb-4">Paste in a few messages you've actually sent (emails, LinkedIn messages, anything in your own words). Annie analyses how you actually write and uses it to draft outreach that sounds like you, not a template.</p>

        <label className="label" htmlFor="settings-pasted-messages">Paste example messages</label>
        <textarea
          id="settings-pasted-messages"
          className="input resize-none mb-2"
          rows={5}
          placeholder="Paste 2-3 real messages you've sent, separated by a blank line..."
          value={pastedMessages}
          onChange={e => setPastedMessages(e.target.value)}
        />
        <ErrorBanner>{pasteError}</ErrorBanner>
        <button onClick={analyseStyle} disabled={analysing} className="btn-ghost mb-4">{analysing ? 'Analysing...' : 'Analyse my style'}</button>

        <label className="label" htmlFor="settings-writing-style">Your style profile</label>
        <textarea
          id="settings-writing-style"
          className="input resize-none"
          rows={5}
          placeholder="Your style profile will appear here after analysing, or you can write/edit it directly."
          value={writingStyle}
          onChange={e => setWritingStyle(e.target.value)}
        />
        <ErrorBanner>{saveStyleError}</ErrorBanner>
        <div className="flex items-center gap-3 mt-3">
          <button onClick={saveWritingStyle} disabled={styleSaving} className="btn-primary">{styleSaving ? 'Saving...' : 'Save style profile'}</button>
          {styleSaved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
        </div>
      </div>

      {onboarding && (
        <div className="card p-6">
          <h2 className="text-lg font-bold text-navy mb-4">BD Configuration</h2>
          <div className="space-y-4 text-sm">
            <div><span className="font-semibold text-gray-600">Sectors:</span> <span className="text-gray-700">{onboarding.sectors?.join(', ') || 'Not set'}</span></div>
            <div><span className="font-semibold text-gray-600">Functions:</span> <span className="text-gray-700">{onboarding.functions?.join(', ') || 'Not set'}</span></div>
            <div><span className="font-semibold text-gray-600">Markets:</span> <span className="text-gray-700">{onboarding.locations?.join(', ') || 'Not set'}</span></div>
            <div><span className="font-semibold text-gray-600">Tone:</span> <span className="text-gray-700 capitalize">{onboarding.tone || 'Professional'}</span></div>
          </div>
          <p className="text-xs text-gray-400 mt-4">To change your sectors, functions, or markets, contact support. This isn't self-serve editable yet.</p>

          <div className="border-t border-gray-100 mt-5 pt-5">
            <h3 className="text-sm font-bold text-navy mb-1">Research scan</h3>
            <p className="text-sm text-gray-500 mb-3">Ask Annie to research your market again right now, instead of waiting for her automatic scan.</p>

            <ErrorBanner>{scanError}</ErrorBanner>

            <button
              onClick={runNewScan}
              disabled={scanState === 'starting' || scanState === 'running'}
              className="btn-primary"
            >
              {scanState === 'starting' || scanState === 'running' ? 'Annie is researching...' : 'Run a new scan'}
            </button>

            {scanState === 'done' && scanResult && (
              <p className="text-sm mt-3">
                {scanResult.reason === 'ok' && `Found ${scanResult.signalsFound} new signal${scanResult.signalsFound === 1 ? '' : 's'}, check your Intelligence Feed.`}
                {scanResult.reason === 'no_results' && "Annie searched your sectors and markets thoroughly but didn't find anything strong enough to flag right now. Worth trying again later, news cycles shift."}
                {scanResult.reason === 'cooldown' && `Annie already ran a scan for you recently. You can run another after ${scanResult.retryAfter ? new Date(scanResult.retryAfter).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'a short wait'}.`}
                {scanResult.reason === 'error' && "Annie hit an error reaching her research tools. This has been logged, and if it keeps happening, let support know."}
                {scanResult.reason === 'still_running' && "Still researching. This can take a few minutes for a broad market. Check your Overview or Intelligence Feed shortly; no need to keep this page open."}
                {!['ok', 'no_results', 'cooldown', 'error', 'still_running'].includes(scanResult.reason) && "Scan finished. Check your Intelligence Feed for results."}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="card p-6 mt-6">
        <h2 className="text-lg font-bold text-navy mb-1">Data & privacy</h2>
        <p className="text-sm text-gray-500 mb-4">Request a copy of your data, or request that your account and data be deleted. We handle these requests manually and will follow up at {user?.email || 'your account email'}.</p>

        <ErrorBanner>{requestError}</ErrorBanner>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => fileAccountRequest('export')}
            disabled={requestPending.export}
            className="btn-ghost text-sm"
          >
            {requestPending.export ? 'Export requested' : 'Request data export'}
          </button>

          <button
            onClick={() => setConfirmDelete(true)}
            disabled={requestPending.delete}
            className="text-sm font-semibold px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-60 disabled:hover:bg-transparent"
          >
            {requestPending.delete ? 'Deletion requested' : 'Request account deletion'}
          </button>
        </div>

        {(requestPending.export || requestPending.delete) && (
          <p className="text-xs text-gray-400 mt-3">
            {requestPending.export && requestPending.delete
              ? "We've received your export and deletion requests and will be in touch."
              : requestPending.export
                ? "We've received your export request and will be in touch."
                : "We've received your deletion request and will be in touch before anything is removed."}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => fileAccountRequest('delete')}
        title="Request account deletion?"
        message="This files a request with our team to delete your account and associated data. It doesn't happen instantly, and we'll follow up before anything is removed."
        confirmLabel="Request deletion"
      />
    </div>
  )
}

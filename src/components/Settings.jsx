import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { callChat } from '../lib/callChat'
import ConfirmDialog from './ConfirmDialog'
import ErrorBanner from './ErrorBanner'

export default function Settings() {
  const navigate = useNavigate()
  const { user, profile, refreshProfile } = useAuth()
  const [form, setForm] = useState({ full_name: '', firm_name: '', job_title: '', phone: '' })
  const [onboarding, setOnboarding] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const [pastedMessages, setPastedMessages] = useState('')
  const [writingStyle, setWritingStyle] = useState('')
  const [analysing, setAnalysing] = useState(false)
  const [styleError, setStyleError] = useState('')
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
  const [scanState, setScanState] = useState('idle') // 'idle' | 'starting' | 'running' | 'done'
  const [scanResult, setScanResult] = useState(null)
  const [scanError, setScanError] = useState('')

  useEffect(() => {
    if (profile) setForm({ full_name: profile.full_name || '', firm_name: profile.firm_name || '', job_title: profile.job_title || '', phone: profile.phone || '' })
    loadOnboarding()
    loadAccountRequests()
  }, [profile])

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
    await supabase.from('profiles').update({ ...form, updated_at: new Date().toISOString() }).eq('id', user.id)
    await refreshProfile()
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  async function analyseStyle() {
    if (!pastedMessages.trim() || pastedMessages.trim().length < 40) {
      setStyleError('Paste in a few real messages you\'ve actually sent, at least a couple of sentences each, so Annie has enough to work from.')
      return
    }
    setAnalysing(true)
    setStyleError('')
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
      setStyleError('Could not analyse right now. Please try again.')
    } finally {
      setAnalysing(false)
    }
  }

  async function saveWritingStyle() {
    setStyleSaving(true)
    await supabase.from('onboarding').update({ writing_style: writingStyle.trim() || null }).eq('user_id', user.id)
    setOnboarding(prev => prev ? { ...prev, writing_style: writingStyle.trim() || null } : prev)
    setStyleSaving(false)
    setStyleSaved(true)
    setTimeout(() => setStyleSaved(false), 3000)
  }

  async function runNewScan() {
    setScanState('starting')
    setScanError('')
    setScanResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Your session has expired. Please log in again.')

      // Fire-and-forget, same pattern as Onboarding.jsx: this is a
      // background function with up to a 15-minute wall-clock budget, the
      // response to this POST doesn't carry the result.
      fetch('/.netlify/functions/scan-now-background', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => {})

      // Same flag Overview.jsx already watches for the post-onboarding scan
      // — setting it here means the "Annie is researching" banner shows up
      // there too if the user navigates over, for free, no separate wiring.
      try { localStorage.setItem('annie_scan_started_' + user.id, String(Date.now())) } catch {}

      setScanState('running')
      pollScanStatus(Date.now())
    } catch (err) {
      setScanState('idle')
      setScanError(err.message || 'Could not start a new scan. Please try again.')
    }
  }

  async function pollScanStatus(startedAt) {
    // Local feedback on this page for up to 3 minutes, matching how long a
    // scan usually takes to at least report *something*. If it's still
    // running after that, Overview's own longer-lived poll (up to the
    // scan's real 15-minute budget) picks up the same status via the same
    // localStorage flag, so nothing is lost by not waiting here forever.
    const LOCAL_POLL_WINDOW_MS = 3 * 60 * 1000
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) { setScanState('idle'); return }

    const resp = await fetch('/.netlify/functions/scan-status', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).then(r => r.json()).catch(() => ({ status: 'unknown' }))

    if (resp?.status === 'done') {
      setScanState('done')
      setScanResult(resp)
      try { localStorage.removeItem('annie_scan_started_' + user.id) } catch {}
      return
    }
    if (Date.now() - startedAt > LOCAL_POLL_WINDOW_MS) {
      setScanState('done')
      setScanResult({ status: 'done', reason: 'still_running' })
      return
    }
    setTimeout(() => pollScanStatus(startedAt), 5000)
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
        <ErrorBanner>{styleError}</ErrorBanner>
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

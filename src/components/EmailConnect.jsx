// Settings → Email. Four states, and the copy for each one is the product.
//
//   loading      checking
//   unavailable  no mailbox provider configured on this deployment — an
//                operational state, not a plan state
//   disconnected the connect button, and what Annie will and will not keep
//   connected    what it is doing, and how to stop it
//
// There is no longer an "upgrade" state. Starter was removed 2026-09-05 and
// both remaining tiers have email sync, so the only reason `available` can be
// false now is configuration. Keeping a plan-gate message here would have told
// a paying customer to upgrade to the plan they are already on.
//
// The three lines under "What Annie keeps" are not marketing. They are the
// answer to the first question every recruiter asks, and they are true: the
// ledger has no column for a message body, Annie has no call that marks mail
// read, and the filter drops anything from someone they never wrote to.
import { useState, useEffect, useCallback } from 'react'
import { getEmailStatus, startEmailConnect, disconnectEmail } from '../lib/email/emailApi'
import ErrorBanner from './ErrorBanner'
import ConfirmDialog from './ConfirmDialog'

function Keeps() {
  return (
    <ul className="mt-4 space-y-2">
      <li className="flex gap-2.5 text-[13px] text-gray-600">
        <span className="text-emerald-600 font-bold" aria-hidden="true">✓</span>
        <span><span className="font-semibold text-navy">Who you wrote to, and when.</span> Name, work address, company, date and subject.</span>
      </li>
      <li className="flex gap-2.5 text-[13px] text-gray-600">
        <span className="text-emerald-600 font-bold" aria-hidden="true">✓</span>
        <span><span className="font-semibold text-navy">A one-line note of what was said,</span> written against the contact.</span>
      </li>
      <li className="flex gap-2.5 text-[13px] text-gray-600">
        <span className="text-red-500 font-bold" aria-hidden="true">✕</span>
        <span><span className="font-semibold text-navy">Not the email itself.</span> Annie reads it, writes the note, and drops it.</span>
      </li>
      <li className="flex gap-2.5 text-[13px] text-gray-600">
        <span className="text-red-500 font-bold" aria-hidden="true">✕</span>
        <span><span className="font-semibold text-navy">Never marked as read.</span> Nothing in your inbox changes, so nothing gets missed.</span>
      </li>
    </ul>
  )
}

export default function EmailConnect() {
  const [state, setState] = useState({ loading: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmOff, setConfirmOff] = useState(false)

  const load = useCallback(async () => {
    const status = await getEmailStatus()
    setState({ loading: false, ...status })
    if (status.error) setError(status.error)
  }, [])

  useEffect(() => { load() }, [load])

  // Coming back from the Unipile consent screen. The account arrives by
  // webhook a moment later, so a single re-check on landing is not enough —
  // poll briefly rather than showing "not connected" to someone who just
  // connected.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (!params.get('connected')) return
    let tries = 0
    const timer = setInterval(async () => {
      tries += 1
      const status = await getEmailStatus()
      if (status.account?.status === 'connected' || tries >= 10) {
        clearInterval(timer)
        setState({ loading: false, ...status })
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [])

  async function connect() {
    setBusy(true)
    setError('')
    const { url, upgrade, error: err } = await startEmailConnect()
    setBusy(false)
    if (url) { window.location.href = url; return }
    // `upgrade` can still come back from an older deployed function; both live
    // tiers include email sync, so it can no longer mean "wrong plan".
    setError(upgrade ? 'Email sync is not available on this account yet.' : (err || 'Could not start the connection.'))
  }

  async function disconnect() {
    setConfirmOff(false)
    setBusy(true)
    const { ok, error: err } = await disconnectEmail()
    setBusy(false)
    if (!ok) { setError(err || 'Could not disconnect.'); return }
    await load()
  }

  if (state.loading) {
    return (
      <div className="card p-6 mb-6">
        <h2 className="text-lg font-bold text-navy mb-1">Email</h2>
        <p className="text-sm text-gray-400">Checking…</p>
      </div>
    )
  }

  const account = state.account && state.account.status !== 'connecting' ? state.account : null

  return (
    <div className="card p-6 mb-6">
      <h2 className="text-lg font-bold text-navy mb-1">Email</h2>

      {!state.available ? (
        <>
          <p className="text-sm text-gray-500 mb-4">
            Connect your mailbox and Annie files the people you already deal with, writes a
            note against each one, and lets you send an approach without leaving the feed.
          </p>
          <div className="border border-dashed border-amber-200 bg-amber-50/60 rounded-lg p-4">
            <p className="text-[13px] text-gray-700">
              <span className="font-bold text-amber-800">Not available yet.</span> Email sync is
              included on your plan — it just is not switched on for this account. Annie still
              writes your approach in the meantime; you copy it into Outlook yourself.
            </p>
          </div>
        </>
      ) : !account ? (
        <>
          <p className="text-sm text-gray-500">
            Annie reads your sent mail, files the people you write to, and adds a note to each
            contact. Replies come back to your own inbox as normal.
          </p>
          <Keeps />
          <ErrorBanner>{error}</ErrorBanner>
          <div className="mt-5">
            <button onClick={connect} disabled={busy || !state.configured} className="btn-primary">
              {busy ? 'Opening…' : 'Connect your email'}
            </button>
            {!state.configured && (
              <p className="text-xs text-gray-400 mt-2">Email connection isn’t switched on yet.</p>
            )}
            <p className="text-xs text-gray-400 mt-3">
              You sign in with Google or Microsoft. Your password never reaches Annie.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 rounded-lg px-4 py-3">
            <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-emerald-800 truncate">
                Connected — {account.email_address}
              </div>
              <div className="text-xs text-gray-600">
                {account.backfill_done
                  ? 'Up to date. New mail appears against your contacts within a minute.'
                  : 'Reading your sent mail now — this takes a few minutes the first time.'}
              </div>
            </div>
          </div>
          <Keeps />
          <ErrorBanner>{error}</ErrorBanner>
          <div className="mt-5">
            <button onClick={() => setConfirmOff(true)} disabled={busy} className="btn-secondary">
              Disconnect
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmOff}
        title="Disconnect your email?"
        message="Annie stops reading new mail and forgets which messages it has seen. The notes already written stay on your contacts — they're your record now."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onClose={() => setConfirmOff(false)}
      />
    </div>
  )
}

// Two one-time notices at the top of the feed, and nothing else ever.
//
//   just-connected  sets the expectation that the first sweep takes minutes,
//                   so a recruiter who granted mailbox access and then saw an
//                   unchanged Contacts page doesn't conclude it failed
//   offer           the only route to this feature for customers who signed
//                   up before it existed — they will never see the onboarding
//                   step, and they do not read Settings
//
// Dismissal is remembered per user. A recruiter who says no once is not asked
// again by this banner; the line in the draft panel is the only other mention,
// and that one is passive.
import { useState, useEffect } from 'react'
import { getEmailStatus, startEmailConnect } from '../../lib/email/emailApi'

const DISMISS_KEY = 'annie_email_offer_dismissed_'

function readDismissed(userId) {
  try { return localStorage.getItem(DISMISS_KEY + userId) === '1' } catch { return false }
}
function writeDismissed(userId) {
  try { localStorage.setItem(DISMISS_KEY + userId, '1') } catch { /* private mode — it reappears once, which is survivable */ }
}

export default function EmailSyncBanner({ userId }) {
  const [mode, setMode] = useState(null) // null | 'connected' | 'offer'
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    const justConnected = new URLSearchParams(window.location.search).get('email') === 'connected'

    getEmailStatus().then(status => {
      if (!live) return
      if (!status?.available || !status?.configured) return
      const connected = status.account?.status === 'connected'

      if (connected && justConnected) { setMode('connected'); return }
      if (!connected && !readDismissed(userId)) setMode('offer')
    })
    return () => { live = false }
  }, [userId])

  async function connect() {
    setBusy(true)
    const { url } = await startEmailConnect({ returnTo: '/dashboard?email=connected' })
    if (url) { window.location.href = url; return }
    setBusy(false)
  }

  function dismiss() {
    writeDismissed(userId)
    setMode(null)
  }

  if (!mode) return null

  if (mode === 'connected') {
    return (
      <div className="flex items-start gap-3 border border-emerald-200 bg-emerald-50 rounded-xl px-4 py-3 mb-3">
        <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0 mt-1.5" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold text-emerald-800">Email connected</div>
          <p className="text-[12.5px] text-gray-600 mt-0.5">
            Annie is reading your sent mail now. New contacts and notes appear over the next few minutes —
            you don’t need to wait here.
          </p>
        </div>
        <button
          onClick={() => setMode(null)}
          className="ml-auto text-[12px] font-semibold text-gray-400 hover:text-gray-600 shrink-0"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3 border border-gold/50 bg-yellow-50 rounded-xl px-4 py-3 mb-3">
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold text-navy">Keep your contact notes up to date on their own</div>
        <p className="text-[12.5px] text-gray-600 mt-0.5">
          Connect your email and Annie files the people you write to, records what was discussed against each
          one, and lets you send from here. It never stores your messages and never marks anything read.
        </p>
        <div className="flex gap-2 mt-2.5 flex-wrap">
          <button
            onClick={connect}
            disabled={busy}
            className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-navy text-gold hover:bg-navy-light transition-colors"
          >
            {busy ? 'Opening…' : 'Connect your email'}
          </button>
          <button
            onClick={dismiss}
            className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}

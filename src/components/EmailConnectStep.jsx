// The offer, at the end of the CSV import, during signup.
//
// Placed here because it answers the same question the recruiter has just
// been answering for the last two minutes: where do Annie's contacts come
// from? They are already handing over their address book; this is the moment
// that ask makes sense, not a Settings page they will never open.
//
// Two rules it obeys:
//
//   Growth and Team only. 3 of 9 accounts are on Starter, and showing them a
//   paywall in the middle of setup is a worse first impression than never
//   mentioning the feature.
//
//   Always skippable. Mailbox access is the largest trust ask in the product
//   and at this point they have not seen a single lead. Anyone who says no
//   should reach their dashboard in one click.
import { useState, useEffect } from 'react'
import { getEmailStatus, startEmailConnect } from '../lib/email/emailApi'

export default function EmailConnectStep({ onSkip }) {
  const [state, setState] = useState({ loading: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    getEmailStatus().then(status => { if (live) setState({ loading: false, ...status }) })
    return () => { live = false }
  }, [])

  async function connect() {
    setBusy(true)
    setError('')
    const { url, error: err } = await startEmailConnect({ returnTo: '/dashboard?email=connected' })
    if (url) { window.location.href = url; return }
    setBusy(false)
    setError(err || 'Could not start the connection. You can do this later in Settings.')
  }

  // Silent for Starter, for an unconfigured install, and for anyone who has
  // already connected — no half-offers, no teasing.
  if (state.loading) return null
  if (!state.available || !state.configured) return null
  if (state.account && state.account.status !== 'connecting') return null

  return (
    <div className="border-2 border-gold rounded-xl p-5 mb-6 text-left bg-yellow-50">
      <div className="text-sm font-bold text-navy mb-1">One more thing — connect your email</div>
      <p className="text-xs text-gray-600 mb-3">
        Annie reads the mail you’ve <span className="font-semibold">sent</span> and keeps your CRM up to date
        on its own. Most recruiters find their real working contacts aren’t in their CRM at all.
      </p>

      <ul className="space-y-1.5 mb-4">
        <li className="flex gap-2 text-xs text-gray-700">
          <span className="text-emerald-600 font-bold" aria-hidden="true">✓</span>
          <span>Adds the people you actually deal with — and the companies they work for</span>
        </li>
        <li className="flex gap-2 text-xs text-gray-700">
          <span className="text-emerald-600 font-bold" aria-hidden="true">✓</span>
          <span>Writes a note against each contact saying what was discussed, so your records stay current without you typing them</span>
        </li>
        <li className="flex gap-2 text-xs text-gray-700">
          <span className="text-emerald-600 font-bold" aria-hidden="true">✓</span>
          <span>Fills in job titles and direct dials from email signatures</span>
        </li>
        <li className="flex gap-2 text-xs text-gray-700">
          <span className="text-emerald-600 font-bold" aria-hidden="true">✓</span>
          <span>Lets you send Annie’s drafted approaches straight from your own mailbox</span>
        </li>
      </ul>

      <div className="bg-white/70 border border-gold/40 rounded-lg px-3 py-2.5 mb-4">
        <p className="text-[11px] text-gray-600 leading-relaxed">
          <span className="font-semibold text-navy">What Annie does not do:</span> it never stores your emails —
          it reads a message, writes the note, and drops it. It never marks anything as read, so nothing in
          your inbox changes. And it only opens threads you started.
        </p>
      </div>

      {error && <p className="text-xs text-red-600 mb-3">{error}</p>}

      <div className="flex gap-2 flex-wrap">
        <button onClick={connect} disabled={busy} className="btn-primary text-sm">
          {busy ? 'Opening…' : 'Connect my email'}
        </button>
        <button onClick={onSkip} className="btn-ghost text-sm">Skip for now</button>
      </div>
      <p className="text-[11px] text-gray-400 mt-2">
        You sign in with Google or Microsoft — your password never reaches Annie. You can turn this off any time.
      </p>
    </div>
  )
}

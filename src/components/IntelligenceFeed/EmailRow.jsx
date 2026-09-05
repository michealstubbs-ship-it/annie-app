import { useState } from 'react'
import { verifyContactEmail } from '../../lib/verifyContactEmail'

// The address row.
//
// Three states, and the card never blurs the line between them:
//   known     already on the customer's own contact record
//   verified  Apollo matched the person and returned this address
//   guess     constructed from the organisation's format and its domain
//
// A guess is labelled a guess, says where it came from, and can never earn a
// verified badge. That rule predates this component and is not negotiable —
// contact_verified means Apollo confirmed a real person, and nothing else may
// ever produce one.
//
// Michael, 2026-09-05: "if Apollo doesnt have it, then annie can guess it from
// public records and say that it is a guess."
export default function EmailRow({ email, contactId, onVerified }) {
  const [state, setState] = useState('idle') // idle | checking | none | capped | error
  const [result, setResult] = useState(null)
  const [message, setMessage] = useState(null)

  if (!email) return null
  const shown = result?.email || email.email
  const isGuess = email.status === 'guess' && !result?.email

  async function verify() {
    setState('checking')
    setMessage(null)
    const res = await verifyContactEmail(contactId)

    if (res?.capReached) {
      setState('capped')
      setMessage(res.error || 'You have used this month’s contact lookups.')
      return
    }
    if (res?.error) {
      setState('error')
      setMessage(res.error)
      return
    }
    if (res?.found && res.email) {
      setResult({ email: res.email })
      setState('idle')
      onVerified?.(contactId, res)
      return
    }
    if (res?.found) {
      // Apollo matched the person and holds no address. This still costs a
      // credit — measured, 10 matched, 5 emails, 10 credits — so it is said
      // out loud rather than looking like a button that did nothing.
      setState('none')
      setMessage('Apollo has this person but no address for them. The guess above is still your best route, or message them on LinkedIn.')
      onVerified?.(contactId, res)
      return
    }
    setState('none')
    setMessage('Apollo could not find them at all — nothing was charged. The guess above is still your best route.')
  }

  const tone = isGuess
    ? 'bg-amber-50/70 border-amber-200/80'
    : 'bg-emerald-50/60 border-emerald-100'

  return (
    <div className={`mt-3 px-3.5 py-2.5 rounded-xl border ${tone}`}>
      <div className="flex items-center gap-2.5 flex-wrap">
        <a
          href={`mailto:${shown}`}
          className="font-mono text-[13px] font-semibold text-navy border-b border-transparent hover:border-navy/40"
        >{shown}</a>

        <span className={`text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
          isGuess ? 'bg-amber-500 text-white' : 'bg-emerald-600 text-white'
        }`}>
          {result?.email ? 'Verified' : email.badge}
        </span>

        {isGuess && email.canVerify && contactId && state !== 'capped' && (
          <button
            type="button"
            onClick={verify}
            disabled={state === 'checking'}
            className="text-[11.5px] font-bold px-2.5 py-1 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors disabled:opacity-60"
          >{state === 'checking' ? 'Checking Apollo…' : 'Verify with Apollo · 1 credit'}</button>
        )}
      </div>

      {/* Where it came from. On a guess this is the most important line on the
          card, because it is what lets the recruiter decide whether to trust
          it before they put their own name behind it. */}
      <p className="text-[12px] text-gray-600 mt-1.5 leading-relaxed max-w-[70ch]">
        {result?.email ? 'Apollo matched this person and returned this address.' : email.explain}
      </p>

      {message && (
        <p className={`text-[12px] mt-1.5 leading-relaxed max-w-[70ch] ${state === 'error' || state === 'capped' ? 'text-red-700' : 'text-gray-600'}`}>
          {message}
        </p>
      )}
    </div>
  )
}

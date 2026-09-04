// "Find me the contact" — the on-demand replacement for enriching every signal
// at scan time whether the recruiter ever looked at it or not. Five test
// tenants burned a 2,500/month Apollo plan doing the latter.
//
// Three outcomes, each stated plainly:
//   found, with email    a usable contact
//   found, no email      Apollo matched the person but holds no address. The
//                        name and the LinkedIn profile still go to the
//                        recruiter — a name and a profile is still a way in.
//   nothing found        said out loud, charged nothing, LinkedIn offered
//
// Nothing is charged unless a real person comes back. Verified against the
// live Apollo API on 2026-09-04: a search costs zero credits, and an
// enrichment that matches nobody costs zero credits. So there is deliberately
// no state in which a recruiter spends their allowance and receives nothing —
// which also means the number in the meter is "contacts", not "attempts".
import { useState } from 'react'
import { resolveSignalContact } from '../../lib/resolveSignalContact'

export default function ContactLookup({ item, onResolved, linkedinRoute }) {
  const [status, setStatus] = useState('idle') // idle | searching | none | capped | error
  const [result, setResult] = useState(null)
  const [message, setMessage] = useState(null)

  const s = item.signal
  const existing = s.contact_verified && s.contact_name
    ? { name: s.contact_name, title: s.contact_title, linkedin_url: s.contact_linkedin_url, email: s.contact_email }
    : null
  const shown = result || existing

  async function find() {
    setStatus('searching')
    setMessage(null)
    const res = await resolveSignalContact(item.id)
    onResolved?.(item.id, res)

    if (res?.capReached) {
      setStatus('capped')
      setMessage(res.error || 'You have used this month’s contact lookups.')
      return
    }
    if (res?.found && res.contact) {
      setResult(res.contact)
      setStatus('idle')
      return
    }
    if (res?.error) {
      setStatus('error')
      setMessage(res.error)
      return
    }
    setStatus('none')
  }

  if (shown) {
    return (
      <div className="mt-3 bg-white border border-gray-200 rounded-lg px-3.5 py-3">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-bold text-navy text-sm">{shown.name}</span>
          {shown.title && <span className="text-[12.5px] text-gray-500">{shown.title}</span>}
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-1.5 text-[12.5px]">
          <span className="text-[10.5px] uppercase tracking-wider text-gray-400 font-semibold">Email</span>
          {shown.email ? (
            <>
              <a className="text-gold-ink font-medium hover:underline" href={`mailto:${shown.email}`}>{shown.email}</a>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-700">Apollo verified</span>
            </>
          ) : (
            <>
              <span className="text-gray-400">not found</span>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-gray-200 text-gray-500">no verified email</span>
            </>
          )}
        </div>
        {shown.linkedin_url && (
          <div className="flex items-center gap-2 mt-1 text-[12.5px]">
            <span className="text-[10.5px] uppercase tracking-wider text-gray-400 font-semibold">LinkedIn</span>
            <a className="text-gold-ink font-medium hover:underline" href={shown.linkedin_url} target="_blank" rel="noopener noreferrer">profile</a>
          </div>
        )}
        {!shown.email && (
          // The verifyContact fix, surfaced. The scan pipeline used to throw
          // this whole record away when the reveal returned no last name,
          // discarding the LinkedIn URL it had just paid for.
          <p className="text-[12px] text-gray-500 mt-2">
            Apollo matched the person but holds no address. The name and profile are still a way in.
          </p>
        )}
      </div>
    )
  }

  if (status === 'none' || status === 'capped' || status === 'error') {
    return (
      <div className="mt-3 border border-dashed border-gray-200 rounded-lg px-3.5 py-3">
        <p className="text-[13px] text-gray-600">
          {status === 'none' ? (
            <>
              <strong className="text-navy">No contact found.</strong>{' '}
              Apollo has no senior record at {s.company_name}. Nothing was charged — credits come off on a successful lookup only.
            </>
          ) : message}
        </p>
        {linkedinRoute && (
          <a
            className="mt-2 inline-flex items-center gap-2 text-[12.5px] font-semibold text-navy bg-page-bg border border-gray-200 rounded-lg px-3 py-2 hover:border-gray-300"
            href={linkedinRoute.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkedinRoute.label}
            {linkedinRoute.approximate && (
              <span className="text-[10.5px] font-medium text-gray-400">approximate</span>
            )}
          </a>
        )}
        {status === 'none' && linkedinRoute?.approximate && (
          <p className="text-[12px] text-gray-400 mt-2">That link is a keyword search, not a person. It may return nothing.</p>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={find}
      disabled={status === 'searching'}
      className="inline-flex items-center gap-2 text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-navy text-gold hover:bg-navy-light transition-colors disabled:opacity-60"
    >
      {status === 'searching' ? 'Searching Apollo…' : 'Find me the contact'}
      {status !== 'searching' && <span className="font-medium text-[10.5px] text-gold/70 border-l border-gold/30 pl-2">1 credit if found</span>}
    </button>
  )
}

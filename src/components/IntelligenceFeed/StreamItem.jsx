import { useState } from 'react'
import CompanyLogo from '../CompanyLogo'
import WayInPanel from './WayInPanel'
import ContactLookup from './ContactLookup'
import LogNote from './LogNote'
import DraftPanel from './DraftPanel'
import { SIGNAL_TYPE_META } from '../../lib/signalTypes'
import { STATE_NEW, STATE_WORKING, STATE_PARKED } from '../../lib/stream/buildStream'

function timeAgo(iso) {
  if (!iso) return null
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (!Number.isFinite(days)) return null
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? 'last month' : `${months} months ago`
}

const STATES = [
  { key: STATE_NEW, label: 'New' },
  { key: STATE_WORKING, label: 'Working' },
  { key: STATE_PARKED, label: 'Park' },
]

export default function StreamItem({ item, onSetState, onDone, onDismiss, onSeen, onResolved, onContactLogged, onContactSaved, userId, profile, onboarding, emailReady = false }) {
  const [open, setOpen] = useState(false)
  const s = item.signal

  // Who the draft is addressed to. Only ever a real address Annie holds — the
  // person already on the card, or the one the scan verified. Never assembled
  // from a name and a domain: a guessed address sends a stranger a message in
  // the recruiter's own name, from their own mailbox.
  const recipient = item.wayIn?.person?.email
    ? { email: item.wayIn.person.email, name: item.wayIn.person.name }
    : (s.contact_email && s.contact_verified
        ? { email: s.contact_email, name: s.contact_name }
        : null)
  const meta = SIGNAL_TYPE_META[s.signal_type] || { label: s.signal_type, icon: '📌' }

  function toggle() {
    if (!open) onSeen?.(item)
    setOpen(o => !o)
  }

  return (
    <article className="card overflow-hidden">
      <div className="px-5 pt-4">
        <div className="flex items-center gap-2 flex-wrap mb-2.5">
          <span className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border border-navy/15 bg-navy/5 text-navy">
            {(meta.icon ? meta.icon + ' ' : '') + (meta.chipLabel || meta.label)}
          </span>
          {s.company_country && (
            <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-page-bg text-gray-500 border border-gray-200">
              {s.company_country}
            </span>
          )}
          {timeAgo(s.found_at) && (
            <span className="text-[11px] text-gray-400">Found {timeAgo(s.found_at)}</span>
          )}
          {s.status === 'new' && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gold/15 text-gold-ink">New</span>
          )}

          {/* What the recruiter is doing about it. This is the behavioural
              signal the product has never had — nothing today records whether
              an item was worked, parked or ignored. */}
          <div className="ml-auto flex gap-1" role="group" aria-label="What are you doing with this">
            {STATES.map(st => {
              const on = item.state === st.key
              return (
                <button
                  key={st.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onSetState(item, st.key)}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-md border transition-colors ${
                    on ? 'bg-navy text-white border-navy' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}
                >{st.label}</button>
              )
            })}
          </div>
        </div>

        <div className="flex items-start gap-3">
          <CompanyLogo name={s.company_name} logoUrl={s.company_logo_url} />
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold text-gray-500">{s.company_name}</div>
            <h3 className="text-[17px] font-bold text-navy leading-snug mt-0.5 text-balance">{s.headline}</h3>
          </div>
        </div>

        {s.why_it_matters && (
          <p className="text-[13.5px] text-gray-600 mt-2 max-w-[68ch]">{s.why_it_matters}</p>
        )}

        {/* The source, on every item. All 530 signals from the last seven days
            already stored source_url and source_label — 100% of them. Nothing
            in the product ever displayed one.

            Only the POSITIVE state is shown. source_verified false does not
            mean the link is bad: verifySourceUrl HEADs the page from a data
            centre, and a great many publishers 403 that. Measured, 30% of a
            week's signals came back false, and two opened by hand were
            perfectly good live pages. Putting a warning badge on a link that
            is probably fine is worse than saying nothing, so when we could not
            confirm it, we say nothing and let the recruiter click. */}
        {item.source.url && (
          <div className="flex items-center gap-2 flex-wrap mt-2.5 pb-4">
            <a
              href={item.source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11.5px] font-medium text-gold-ink border-b border-gold/40 hover:border-gold-ink pb-px"
            >
              {item.source.label || 'source'} <span aria-hidden="true">↗</span>
            </a>
            {item.source.checked && (
              <span className="text-[10.5px] px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-700">link checked</span>
            )}
          </div>
        )}
      </div>

      {/* FEED-6, in Michael's own words about a regulatory card: "This should
          just be a news tab... It should not come with any of the bottom half."
          isNews has been computed in buildStream since the single-stream
          rebuild and was never read here, so an M&A filing, a regulatory note
          and a piece of public commentary each arrived wearing the full BD
          apparatus - find the contact, draft the approach, log the call - for
          an event nobody can act on commercially. NEWS_SIGNAL_TYPES already
          says which types those are; this is the first place it changes what
          the customer sees.

          The card itself stays: the headline and why-it-matters are genuinely
          worth knowing, and the way-in panel still says who the recruiter knows
          there. Only the actions that imply "call someone about this" are
          withheld, along with the Apollo lookup that would have spent a credit
          on a lead that was never a lead. */}
      <WayInPanel wayIn={item.wayIn} companyName={s.company_name}>
        {item.isNews ? (
          <div className="flex gap-2 flex-wrap mt-3 items-center">
            <span className="text-[12px] text-gray-500">
              Background, not a lead — nothing here to act on today.
            </span>
            {item.linkedinRoute && (
              <a
                className="inline-flex items-center gap-2 text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
                href={item.linkedinRoute.url}
                target="_blank"
                rel="noopener noreferrer"
              >{item.linkedinRoute.label}</a>
            )}
            <button
              type="button"
              onClick={() => onDismiss(item)}
              className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
            >Not relevant</button>
          </div>
        ) : (
        <div className="flex gap-2 flex-wrap mt-3 items-center">
          <ContactLookup
            item={item}
            onResolved={onResolved}
            linkedinRoute={item.linkedinRoute}
            userId={userId}
            onSaved={onContactSaved}
          />

          {/* Written on request, never in advance. The old page ran an AI copy
              pass across every item before it could render, paying to write an
              approach for leads nobody opened. */}
          <DraftPanel item={item} profile={profile} onboarding={onboarding} emailReady={emailReady} recipient={recipient} />

          {/* The only thing in the product that creates rung 1 — see LogNote's
              own header. Offered wherever there is a real person on the card. */}
          {item.wayIn.person?.id && item.wayIn.kind !== 'candidate' && (
            <LogNote contact={item.wayIn.person} onLogged={onContactLogged} />
          )}

          {item.linkedinRoute && (
            <a
              className="inline-flex items-center gap-2 text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
              href={item.linkedinRoute.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {item.linkedinRoute.tier === 'profile' ? 'Open LinkedIn' : 'LinkedIn route'}
              <span className="text-[10.5px] font-semibold text-emerald-700">free</span>
            </a>
          )}

          <button
            type="button"
            onClick={toggle}
            className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
          >
            {open ? 'Hide detail' : 'More detail'}
          </button>
        </div>
        )}

        {open && (
          <div className="mt-3 pt-3 border-t border-gray-200/70 space-y-3">
            {s.who_to_approach && (
              <div>
                <span className="block text-[10.5px] uppercase tracking-wider text-gray-400 font-bold mb-0.5">Who to approach</span>
                <p className="text-[13px] text-gray-700">{s.who_to_approach}</p>
              </div>
            )}
            {Array.isArray(s.likely_roles) && s.likely_roles.length > 0 && (
              <div>
                <span className="block text-[10.5px] uppercase tracking-wider text-gray-400 font-bold mb-0.5">Roles this probably creates</span>
                <p className="text-[13px] text-gray-700">{s.likely_roles.join(' · ')}</p>
              </div>
            )}
            {s.candidate_angle && (
              <div>
                <span className="block text-[10.5px] uppercase tracking-wider text-gray-400 font-bold mb-0.5">Candidate angle</span>
                <p className="text-[13px] text-gray-700">{s.candidate_angle}</p>
              </div>
            )}
            <div className="flex gap-2 flex-wrap pt-1">
              <button
                type="button"
                onClick={() => onDone(item)}
                className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
              >Mark as done</button>
              <button
                type="button"
                onClick={() => onDismiss(item)}
                className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
              >Not relevant</button>
            </div>
          </div>
        )}
      </WayInPanel>
    </article>
  )
}

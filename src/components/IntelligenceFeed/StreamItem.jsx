import { useState } from 'react'
import CompanyLogo from '../CompanyLogo'
import CardBlock from './CardBlock'
import EmailRow from './EmailRow'
import { whyNow } from '../../lib/stream/whyNow'
import ContactLookup from './ContactLookup'
import LogNote from './LogNote'
import DraftPanel from './DraftPanel'
import { SIGNAL_TYPE_META } from '../../lib/signalTypes'
import { STATE_NEW, STATE_WORKING, STATE_PARKED } from '../../lib/stream/buildStream'
import { RUNG_COLD } from '../../lib/stream/wayIn'

// One card, everything Annie knows about one account.
//
// Rebuilt 2026-09-05 against four things Michael said about the previous
// version, in his words:
//
//   "it doesnt say why to approach this guy"        → the why-him line
//   "Some additional information on Kazna would be
//    good for the customer?"                        → What is happening at…
//   "there should be a tab taking you them on
//    another list"                                  → You know N other people
//   "communication should be clear that we found
//    Johan In your contacts"                        → the provenance strip
//
// And two constraints from the turn after: "UX/UI needs to be slick. But we
// always need to tell the client what they looking at." Hence: everything
// secondary is behind a disclosure whose header is worth reading on its own,
// and the first line of every card says what it is and where it came from.
//
// Everything on this card is COMPUTED. No new AI call, no new Apollo call, no
// added cost per card — the facts were all already in the CRM and the signal
// row and simply were not being said.

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

const PROV_TONE = {
  crm: 'bg-sky-50 text-sky-800 border-sky-100',
  move: 'bg-emerald-50 text-emerald-800 border-emerald-100',
  role: 'bg-gold/15 text-gold-ink border-gold/30',
  market: 'bg-navy/5 text-navy border-navy/10',
}

export default function StreamItem({ item, onSetState, onDone, onDismiss, onSeen, onResolved, onContactLogged, onContactSaved, userId, profile, onboarding, contacts = [], emailReady = false }) {
  const [open, setOpen] = useState(false)
  const s = item.signal
  const person = item.person || item.wayIn?.person || null
  const panel = item.companyPanel
  const happening = item.happening || []
  const prov = item.provenance

  // Why this person, if the card is about a person; otherwise why this
  // company, today. Both return null rather than a generic line — a line that
  // says nothing trains the reader to skip the row.
  const reason = item.whyPerson || whyNow(item, contacts)

  // Who the draft is addressed to. Only ever a real address Annie holds — the
  // person already on the card, or the one Apollo verified. NEVER a guess: a
  // constructed address sends a stranger a message in the recruiter's own
  // name, from their own mailbox. The guess is for them to use by hand, with
  // their eyes open, which is why it appears on the card and not in here.
  const recipient = person?.email
    ? { email: person.email, name: person.name }
    : (s.contact_email && s.contact_verified ? { email: s.contact_email, name: s.contact_name } : null)

  function toggle() {
    if (!open) onSeen?.(item)
    setOpen(o => !o)
  }

  return (
    <article className="card overflow-hidden">

      {/* WHAT AM I LOOKING AT. First line, every card, no exceptions. */}
      <div className="flex items-center gap-2.5 flex-wrap px-5 py-2.5 bg-page-bg border-b border-gray-100">
        {prov && (
          <>
            <span className={`text-[9.5px] font-bold uppercase tracking-[0.11em] px-2 py-1 rounded border ${PROV_TONE[prov.kind] || PROV_TONE.market}`}>
              {prov.label}
            </span>
            <span className="text-[12px] text-gray-500">{prov.detail}</span>
          </>
        )}
        {timeAgo(s.found_at) && (
          <span className="text-[11px] text-gray-400">· found {timeAgo(s.found_at)}</span>
        )}

        {/* What the recruiter is doing about it — the behavioural signal the
            product never had before the rebuild. */}
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

      <div className="px-5 pt-4">
        <div className="flex items-start gap-3">
          <CompanyLogo name={s.company_name} logoUrl={s.company_logo_url} />
          <div className="min-w-0">
            {person ? (
              // The person IS the lead. Their name is the headline, and the
              // title carries the argument for calling them.
              <>
                <h3 className="text-[19px] font-extrabold text-navy leading-tight tracking-[-0.01em]">{person.name}</h3>
                <div className="text-[13.5px] text-gray-600 mt-0.5">
                  {person.title && <span className="font-semibold text-navy">{person.title}</span>}
                  {person.title && ' · '}{s.company_name}
                </div>
              </>
            ) : (
              <>
                <div className="text-[12.5px] font-semibold text-gray-500">{s.company_name}</div>
                <h3 className="text-[17px] font-bold text-navy leading-snug mt-0.5 text-balance">{s.headline}</h3>
              </>
            )}
          </div>
        </div>

        {reason && (
          <p className="text-[13.5px] text-gray-700 mt-3 max-w-[66ch] leading-relaxed pl-3 border-l-2 border-gold">
            {reason}
          </p>
        )}
        {/* The scan's own paragraph, kept only where it is not just a longer
            way of saying the line above it. */}
        {!person && s.why_it_matters && (
          <p className="text-[13.5px] text-gray-600 mt-2 max-w-[68ch]">{s.why_it_matters}</p>
        )}

        {/* Showing the rejected near-misses is what makes silence read as
            judgement rather than as a gap. Real: substring matching once
            offered contacts at "du", the telecom operator, as a way into
            Commercial Bank of Dubai. */}
        {item.wayIn?.rung === RUNG_COLD && item.wayIn.nearMisses?.length > 0 && (
          <p className="text-[12.5px] text-gray-500 mt-2 max-w-[68ch]">
            Nobody at {s.company_name} is in your contacts. You have contacts at{' '}
            <span className="font-semibold text-gray-700">{item.wayIn.nearMisses.join(', ')}</span> — different companies, not a way in.
          </p>
        )}
        {item.wayIn?.caveat && (
          <p className="text-[12.5px] text-gray-500 mt-2 max-w-[68ch]">{item.wayIn.caveat}</p>
        )}

        {/* The address. A fact when Annie has one, a labelled guess when she
            does not, and never the two dressed as each other. */}
        <EmailRow
          email={item.email}
          contactId={person?.id || null}
          // A verified address goes straight onto the local contact record, so
          // every other card at this company stops offering to spend a second
          // credit on the same person.
          onVerified={(contactId, res) => {
            if (res?.email) onContactLogged?.(contactId, { email: res.email, relationship_tier: 'contact' })
          }}
        />

        {/* Michael: "annie should be like this is the recent news and roles
            that Khazna have been posting." A live role at NEOM and a person
            you know at NEOM are the same lead, so they are the same card. */}
        {happening.length > 0 && (
          <CardBlock
            title={`What is happening at ${s.company_name}`}
            count={`${happening.length} ${happening.length === 1 ? 'item' : 'items'}`}
            onOpen={() => onSeen?.(item)}
          >
            {happening.map(h => (
              <div key={h.id} className="px-3.5 py-2.5 border-b border-gray-200/60 last:border-0">
                <div className="text-[13px] font-semibold text-navy">{h.headline}</div>
                {h.detail && <div className="text-[12.5px] text-gray-600 mt-0.5 max-w-[66ch]">{h.detail}</div>}
                <div className="flex items-center gap-2 flex-wrap mt-1">
                  <span className="text-[11.5px] text-gray-400">
                    {(SIGNAL_TYPE_META[h.type]?.label || h.type)}{timeAgo(h.eventAt || h.foundAt) ? ` · ${timeAgo(h.eventAt || h.foundAt)}` : ''}
                    {h.isNews ? ' · background' : ''}
                  </span>
                  {h.source?.url && (
                    <a
                      href={h.source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11.5px] font-medium text-gold-ink border-b border-gold/40 hover:border-gold-ink"
                    >{h.source.label || 'source'} ↗</a>
                  )}
                </div>
                {h.roles?.length > 0 && (
                  <div className="text-[12px] text-gray-500 mt-1">Roles this probably creates: {h.roles.join(' · ')}</div>
                )}
              </div>
            ))}
          </CardBlock>
        )}

        {/* Michael: "It says you know 7 other people who work there, there
            should be a tab taking you them on another list." The list, and
            then what the list means. */}
        {panel && (
          <CardBlock
            title={`You know ${panel.others.length} other ${panel.others.length === 1 ? 'person' : 'people'} at ${s.company_name}`}
            count={`${panel.total} total`}
            onOpen={() => onSeen?.(item)}
          >
            {panel.others.map(p => (
              <div key={p.id} className="flex items-baseline gap-2.5 px-3.5 py-2 text-[13px] hover:bg-gray-100/60">
                <span className="font-semibold text-navy">{p.name}</span>
                <span className="text-[12.3px] text-gray-500 flex-1 min-w-0">{p.title}</span>
                {p.spokenTo && (
                  <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 whitespace-nowrap">Spoken to</span>
                )}
                {p.relation === 'parent' && (
                  <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white border border-gray-200 text-gray-500 whitespace-nowrap">{p.company}</span>
                )}
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white border border-gray-200 text-gray-500 whitespace-nowrap">{p.bandLabel}</span>
              </div>
            ))}
            {panel.readout && (
              <p className="text-[12.5px] text-gray-600 px-3.5 py-2.5 border-t border-dashed border-gray-200 leading-relaxed">
                <span className="font-bold text-navy">What this tells you: </span>{panel.readout}
              </p>
            )}
          </CardBlock>
        )}
      </div>

      {/* FEED-6, Michael on a regulatory card: "This should just be a news
          tab... It should not come with any of the bottom half." Nothing that
          implies "call someone about this" is offered for an event nobody can
          act on commercially, and no Apollo credit can be spent on it. */}
      <div className="flex gap-2 flex-wrap items-center px-5 py-4 mt-2 border-t border-gray-100 bg-white">
        {item.isNews ? (
          <>
            <span className="text-[12px] text-gray-500">Background, not a lead — nothing here to act on today.</span>
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
          </>
        ) : (
          <>
            {/* Written on request, never in advance. The old page ran an AI
                copy pass across every item before it could render. */}
            <DraftPanel item={item} profile={profile} onboarding={onboarding} emailReady={emailReady} recipient={recipient} />

            <ContactLookup
              item={item}
              onResolved={onResolved}
              linkedinRoute={item.linkedinRoute}
              userId={userId}
              onSaved={onContactSaved}
            />

            {/* The only thing in the product that earns rung 1. */}
            {person?.id && item.wayIn?.kind !== 'candidate' && (
              <LogNote contact={person} onLogged={onContactLogged} />
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
              className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
            >{open ? 'Less' : 'More'}</button>
          </>
        )}
      </div>

      {open && !item.isNews && (
        <div className="px-5 pb-4 -mt-1 space-y-3">
          {item.source?.url && (
            <div className="flex items-center gap-2 flex-wrap">
              <a
                href={item.source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11.5px] font-medium text-gold-ink border-b border-gold/40 hover:border-gold-ink pb-px"
              >{item.source.label || 'source'} ↗</a>
              {/* source_verified false means "not checked", never "fake" —
                  30% of a week's signals came back false and two opened by
                  hand were perfectly good live pages. */}
              {item.source.checked && (
                <span className="text-[10.5px] px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-700">link checked</span>
              )}
            </div>
          )}
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
    </article>
  )
}

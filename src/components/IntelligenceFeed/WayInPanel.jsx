// The way in — what replaced the contact gate.
//
// Everything here is about what Annie is ALLOWED to claim. companyMatch.js's
// own comment used to offer "a warm door" whenever a contact existed at the
// target company, with no check of notes or contact history at all. Measured
// on the production account holding 753 contacts: ZERO have a note and ZERO
// have a logged contact date, every one bulk-imported. So that warmth claim
// was false for all 753 of them.
//
// Rung 1 is therefore something the product EARNS rather than something it can
// show on day one, which is why logging what happened is a first-class action
// on the card rather than buried in the CRM.
import { RUNG_SPOKEN, RUNG_CANDIDATE, RUNG_CONTACT, RUNG_COLD } from '../../lib/stream/wayIn'

// The ladder is information, not decoration: four steps, and how many are lit
// is exactly how strong the route in is.
const RUNG_META = {
  [RUNG_SPOKEN]: {
    label: 'Spoken to', filled: 4,
    panel: 'bg-emerald-50/70 border-emerald-100',
    lit: 'bg-emerald-600', text: 'text-emerald-800', rule: 'border-emerald-200',
  },
  [RUNG_CANDIDATE]: {
    label: 'Inside', filled: 3,
    panel: 'bg-amber-50/70 border-amber-100',
    lit: 'bg-amber-600', text: 'text-amber-800', rule: 'border-amber-200',
  },
  [RUNG_CONTACT]: {
    label: 'In CRM', filled: 2,
    panel: 'bg-page-bg border-gray-100',
    lit: 'bg-gray-500', text: 'text-gray-700', rule: 'border-gray-200',
  },
  [RUNG_COLD]: {
    label: 'Cold', filled: 1,
    panel: 'bg-white border-gray-100',
    lit: 'bg-gray-400', text: 'text-gray-500', rule: 'border-gray-200',
  },
}

function title(wayIn, companyName) {
  switch (wayIn.kind) {
    case 'spoken': return 'You have spoken to someone here'
    case 'candidate': return 'Someone on your books works here'
    case 'contact': return wayIn.relation === 'parent'
      ? 'You have someone in the parent group'
      : `Someone at ${companyName} is in your contacts`
    default: return 'No route in yet'
  }
}

// The history line for rung 1. The ONLY place warmth is claimed, and it is
// claimed from something the recruiter themselves wrote.
function historyLine(contact) {
  if (contact?.last_contacted) {
    const when = new Date(contact.last_contacted)
    if (!Number.isNaN(when.getTime())) {
      return `You logged contact on ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.`
    }
  }
  const notes = (contact?.notes || '').trim()
  if (notes) return notes.length > 180 ? `${notes.slice(0, 177)}…` : notes
  return null
}

export default function WayInPanel({ wayIn, companyName, children }) {
  const meta = RUNG_META[wayIn.rung] || RUNG_META[RUNG_COLD]
  const person = wayIn.person
  const role = person?.title || person?.role || ''
  const otherEntity = person?.company && person.company !== companyName ? person.company : null
  const history = wayIn.kind === 'spoken' ? historyLine(person) : null

  return (
    <div className={`border-t px-5 py-4 flex gap-4 items-start ${meta.panel}`}>
      <div className="flex-none w-12 flex flex-col items-center gap-1.5 pt-0.5">
        <div className="flex flex-col-reverse gap-0.5" aria-hidden="true">
          {[4, 3, 2, 1].map(step => (
            <i key={step} className={`block w-6 h-1 rounded-sm ${step <= meta.filled ? meta.lit : 'bg-gray-200'}`} />
          ))}
        </div>
        <span className={`text-[9.5px] font-bold uppercase tracking-wider text-center leading-tight ${meta.text}`}>
          {meta.label}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className={`text-[13.5px] font-bold ${meta.text}`}>{title(wayIn, companyName)}</div>

        <div className="text-[13px] text-gray-700 mt-0.5">
          {person ? (
            <>
              <span className="font-semibold text-navy">{person.name}</span>
              {role && <> — {role}</>}
              {otherEntity && <>, {otherEntity}</>}
            </>
          ) : (
            <>Nobody at {companyName} is in your contacts or your candidate list.</>
          )}
        </div>

        {history && (
          <p className={`text-[12.5px] text-gray-600 mt-2 pl-2.5 border-l-2 ${meta.rule}`}>{history}</p>
        )}
        {wayIn.caveat && (
          <p className={`text-[12.5px] text-gray-600 mt-2 pl-2.5 border-l-2 ${meta.rule}`}>{wayIn.caveat}</p>
        )}

        {/* Showing the rejected near-misses is what makes silence read as
            judgement rather than as a gap. These are real: substring matching
            offered contacts at "du", the telecom operator, as a way into
            Commercial Bank of Dubai, and a contact at "Emirates", the airline,
            as a way into ALAS Emirates Ready Mix. Seven of twelve matches
            across 37 signals were the wrong company. */}
        {wayIn.rung === RUNG_COLD && wayIn.nearMisses.length > 0 && (
          <p className="text-[12.5px] text-gray-600 mt-2 pl-2.5 border-l-2 border-gray-200">
            You have contacts at{' '}
            {wayIn.nearMisses.map((n, i) => (
              <span key={n}>
                {i > 0 && (i === wayIn.nearMisses.length - 1 ? ' and ' : ', ')}
                <span className="font-semibold text-gray-700">{n}</span>
              </span>
            ))}
            . Different companies — not a way in.
          </p>
        )}

        {children}
      </div>
    </div>
  )
}

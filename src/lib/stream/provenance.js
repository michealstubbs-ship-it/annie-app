// The first line of every card: what am I looking at, and where did it come
// from.
//
// Michael, 2026-09-05: "Also communication should be clear that we found Johan
// In your contacts." And then, on the redesign: "we always need to tell the
// client what they looking at."
//
// It is a fair complaint about a product that had five sources feeding one
// list — the AI scan, the job-board sweep, the LinkedIn import diff, the
// mailbox sync and the CRM backlog — and told the reader which was which only
// through a signal-type chip that named the EVENT, never the SOURCE. A
// recruiter cannot judge a lead without knowing whether Annie read it in the
// press or found it in their own address book.
//
// Two fields, always both present:
//   label   the badge — four words at most, the kind of thing this is
//   detail  the honest provenance, including what is missing

import { BACKLOG_SIGNAL_TYPE } from './backlogSignals'
import { SIGNAL_TYPE_META } from '../signalTypes'

function importedFrom(contact) {
  const from = String(contact?.created_from || '').toLowerCase()
  if (from.includes('linkedin')) return 'Imported from LinkedIn'
  if (from.includes('csv')) return 'Imported from your CSV'
  if (from.includes('email') || from.includes('mailbox')) return 'Found in your mailbox'
  if (from.includes('apollo')) return 'Added by Annie from Apollo'
  if (from) return 'Added by you'
  return 'In your contacts'
}

// The two absences that decide whether a name is a relationship. Said plainly,
// because the alternative is the product implying warmth it has not earned —
// measured on the production account, all 753 contacts had no note and no
// logged contact date.
function historyLine(contact) {
  const hasNote = Boolean((contact?.notes || '').trim())
  const hasCall = Boolean(contact?.last_contacted)
  if (hasCall && hasNote) return 'you have logged contact and written a note'
  if (hasCall) return 'you have logged contact before'
  if (hasNote) return 'you have written a note on them'
  return 'never contacted · no note logged'
}

export function provenanceFor(item, { contact = null } = {}) {
  const s = item?.signal
  if (!s) return null
  const person = contact || item.wayIn?.person || null

  if (s.signal_type === BACKLOG_SIGNAL_TYPE) {
    return {
      kind: 'crm',
      label: 'From your contacts',
      detail: `${importedFrom(person)} · ${historyLine(person)}`,
    }
  }

  // The import diff is the only thing that writes a leadership_change against
  // a contact the customer already had.
  if (s.linked_contact_id && s.signal_type === 'leadership_change') {
    return {
      kind: 'move',
      label: 'Changed jobs',
      detail: 'Found by comparing your latest LinkedIn export against the previous one',
    }
  }

  if (s.signal_type === 'live_job') {
    return {
      kind: 'role',
      label: 'Live role',
      detail: s.source_label
        ? `Advertised on ${s.source_label} · at a company in your network`
        : 'Advertised publicly · at a company in your network',
    }
  }

  const meta = SIGNAL_TYPE_META[s.signal_type]
  return {
    kind: 'market',
    label: meta?.chipLabel || meta?.label || 'In the market',
    detail: s.source_label
      ? `Annie found this in ${s.source_label} while watching your companies`
      : 'Found by Annie while watching the companies you have contacts at',
  }
}

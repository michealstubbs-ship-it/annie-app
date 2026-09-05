// Logging what actually happened, from inside the stream.
//
// This is the single most important write in the whole rebuild, and it is not
// obvious why until you look at the data. The way-in ladder's top rung —
// "someone you have actually spoken to" — requires the recruiter to have left
// evidence: a note they wrote, or a logged contact date. Measured on the
// production account on 2026-09-04: 753 contacts, ZERO with either. Every one
// arrived by bulk import.
//
// So rung 1 is unreachable until the product makes recording a conversation
// effortless AT THE MOMENT it happens, which is on the card, not three clicks
// away in the CRM. Without this, the ladder's best rung is decoration.
//
// Deliberately appends rather than replaces: a contact's notes are the
// recruiter's own record and nothing here is allowed to overwrite what they
// wrote before.
import { supabase } from '../supabase'
import { createContact } from '../data/contacts'

// Not toLocaleDateString: email sync writes notes into this same column from
// Node, whose en-GB renders September as "Sept" on some ICU builds while
// browsers render "Sep". Two writers, one format, no drifting apart — and the
// server's duplicate check compares these strings literally.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function stamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/**
 * Appends a note to an existing contact and stamps last_contacted.
 * Returns { error } — the caller keeps its own optimistic state.
 */
export async function logContactNote(contactId, { note, existingNotes = '', contactedAt = new Date() }) {
  const text = (note || '').trim()
  if (!contactId || !text) return { error: new Error('Nothing to log') }

  const prefixed = `${stamp(contactedAt)} — ${text}`
  const merged = existingNotes && existingNotes.trim()
    ? `${existingNotes.trim()}\n\n${prefixed}`
    : prefixed

  const { error } = await supabase
    .from('contacts')
    .update({ notes: merged, last_contacted: contactedAt.toISOString() })
    .eq('id', contactId)

  return { error, notes: merged, last_contacted: contactedAt.toISOString() }
}

/**
 * Saves a contact Apollo just resolved into the CRM, so the next signal at
 * that company arrives already on rung 3 instead of cold — and so the credit
 * already spent is never spent again.
 *
 * Returns { data, error }. Deliberately does NOT set last_contacted: saving
 * someone's details is not the same as having spoken to them, and conflating
 * the two is exactly the overclaim this rebuild exists to remove.
 */
export async function saveResolvedContact({ contact, companyName, userId }) {
  if (!contact?.name || !userId) return { error: new Error('Missing contact details') }

  // Goes through createContact so this insert obeys exactly the same shape and
  // RLS path as one typed into the Contacts page — team_id is left unset, which
  // the policy treats as a personal record owned by auth.uid().
  return createContact({
    name: contact.name,
    company: companyName || null,
    title: contact.title || null,
    email: contact.email || null,
    linkedin_url: contact.linkedin_url || null,
    status: 'cold',
    tags: ['from-intelligence-feed'],
  }, userId)
}

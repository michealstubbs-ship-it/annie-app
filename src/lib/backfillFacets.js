// Classifying the contacts that were imported before the classifier existed.
//
// The migration that added seniority_band, function_area, relationship_tier and
// is_competitor deliberately classifies nothing in SQL — the vocabularies live
// in JS and a Postgres regex doing the same job would be a second definition
// that silently disagrees. That is the right call, and it leaves a gap: every
// contact imported before this release has null facets, and a contact with a
// null seniority_band scores zero and never reaches the backlog. On the account
// this was built for, that was all 778 rows and a completely empty call list.
//
// New imports classify at import time, so this is a one-time repair per
// account. It runs from the browser because that is where the classifier
// already is, it costs no API call and no credit, and it needs no deploy of its
// own for each tenant — the first person to open the feed fixes their own team.
//
// Deliberately NOT a Netlify function: a server-side backfill would need its
// own auth, its own batching, its own retry, and a way to be triggered per
// team. This needs none of that, because the data is already loaded on screen.
import { deriveContactFacets } from './contactFacets'

// Supabase caps the payload, and a recruiter with a large CRM should not sit
// behind one enormous write. 200 keeps each round trip small enough to fail
// cheaply and retry on the next load.
export const BACKFILL_CHUNK = 200

// A row needs repair when the classifier has never run on it. seniority_band is
// the marker: deriveSeniorityBand only returns null for a genuinely empty
// title, so a row with a title and no band was written before this existed.
//
// is_competitor is NOT a marker — it is `not null default false`, so every row
// already has a value and a legitimately-false row would be repaired forever.
export function needsFacets(contact) {
  if (!contact) return false
  if (contact.seniority_band) return false
  return !!(contact.title && String(contact.title).trim())
}

/**
 * The rows to write, and the locally-patched contacts to render immediately.
 *
 * Returns both so the caller can update the screen without waiting for the
 * write to come back — the facets are computed from data already in hand, so
 * showing them straight away is not optimism, it is the same answer.
 */
export function planFacetBackfill(contacts = []) {
  const updates = []
  const patched = []

  for (const contact of contacts) {
    if (!needsFacets(contact)) {
      patched.push(contact)
      continue
    }
    const facets = deriveContactFacets(contact)
    // relationship_tier is left alone. The migration already set it from a fact
    // check (does an email or phone exist), and only the mailbox backfill can
    // earn 'client' — recomputing it here would silently demote a client back
    // to a contact on every page load.
    const { relationship_tier: _ignored, ...writable } = facets
    updates.push({ id: contact.id, ...writable })
    patched.push({ ...contact, ...writable })
  }

  return { updates, patched }
}

export function chunk(rows, size = BACKFILL_CHUNK) {
  const out = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/**
 * Writes the facets back. Never throws.
 *
 * A failed backfill must not take the feed down: the customer still has their
 * signals, and the repair simply happens on the next load. Returns how many
 * rows were written so the caller can log it rather than guess.
 */
export async function runFacetBackfill(supabase, contacts = []) {
  const { updates, patched } = planFacetBackfill(contacts)
  if (!supabase || !updates.length) return { written: 0, patched }

  let written = 0
  for (const batch of chunk(updates)) {
    try {
      // One statement per row rather than an upsert: upsert would need every
      // NOT NULL column in the payload and would happily create a row from a
      // partial one. These are repairs to rows that already exist.
      const results = await Promise.all(batch.map(row => {
        const { id, ...fields } = row
        return supabase.from('contacts').update(fields).eq('id', id)
      }))
      written += results.filter(r => !r?.error).length
      const firstError = results.find(r => r?.error)?.error
      if (firstError) console.error('[backfillFacets] partial failure:', firstError.message)
    } catch (err) {
      console.error('[backfillFacets] batch threw:', err.message)
    }
  }
  return { written, patched }
}

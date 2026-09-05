// What changed since the last CSV import.
//
// The move signal is not in one snapshot, it is in the difference between two.
// Until now the importer detected an existing contact and SKIPPED the row
// entirely — so a contact who had changed employer since the last export was
// discarded as a duplicate, and the single most valuable thing a re-import can
// tell a recruiter was thrown away every time.
//
// ONE MOVE IS TWO LEADS, and the weaker-looking one is usually the stronger:
//
//   the seat they left   their old employer probably needs to replace them.
//                        That is a live need at a company the recruiter
//                        already has a relationship with.
//   the seat they took   they are new somewhere, they will be building a team,
//                        and they already know the recruiter.
//
// A promotion — same employer, bigger title — is the third case and costs
// nothing extra to detect. It is often better than a move: new budget, no
// relationship reset, and an account the recruiter already understands.
import { isPlaceholderCompany } from './backlogRanking'
import { normalizeCompanyName } from './companyMatch'
import { deriveSeniorityBand, deriveContactFacets, SENIORITY_BANDS } from './contactFacets'

export const CHANGE_JOB_MOVE = 'job_move'
export const CHANGE_PROMOTION = 'promotion'

function bandRank(band) {
  const i = SENIORITY_BANDS.findIndex(b => b.key === band)
  return i === -1 ? SENIORITY_BANDS.length : i
}

/**
 * Compare a freshly parsed CSV row against the contact already in the CRM.
 *
 * Returns null when nothing meaningful changed. "Meaningful" is doing real work
 * here: LinkedIn re-exports are noisy, and treating every small difference as a
 * move would bury the real ones.
 */
export function detectChange(incoming, existing) {
  if (!incoming || !existing) return null

  const oldCompany = String(existing.company || '').trim()
  const newCompany = String(incoming.company || '').trim()
  const oldTitle = String(existing.title || '').trim()
  const newTitle = String(incoming.title || '').trim()

  // A row that has lost its employer is not a move. LinkedIn returns an empty
  // or hidden company for a member who has tightened their privacy, and
  // announcing "they left ADQ" on the strength of that would be inventing an
  // event out of a settings change.
  if (!newCompany || isPlaceholderCompany(newCompany)) return null

  const movedEmployer = !!oldCompany
    && normalizeCompanyName(oldCompany) !== normalizeCompanyName(newCompany)

  if (movedEmployer) {
    return {
      type: CHANGE_JOB_MOVE,
      contactId: existing.id,
      name: existing.name || incoming.name,
      linkedin_url: existing.linkedin_url || incoming.linkedin_url || null,
      from: { company: oldCompany, title: oldTitle },
      to: { company: newCompany, title: newTitle },
    }
  }

  // Same employer. Only a title change that actually moves them UP a seniority
  // band counts. A recruiter does not need to hear that "Head of Strategy"
  // became "Head of Strategy & Transformation" — that is the same person doing
  // the same job with a longer title, and it is the most common kind of edit in
  // a LinkedIn re-export.
  if (newTitle && oldTitle && newTitle !== oldTitle) {
    const before = deriveSeniorityBand(oldTitle, oldCompany)
    const after = deriveSeniorityBand(newTitle, newCompany)
    if (bandRank(after) < bandRank(before)) {
      return {
        type: CHANGE_PROMOTION,
        contactId: existing.id,
        name: existing.name || incoming.name,
        linkedin_url: existing.linkedin_url || incoming.linkedin_url || null,
        from: { company: oldCompany, title: oldTitle },
        to: { company: newCompany, title: newTitle },
      }
    }
  }

  return null
}

export function detectChanges(incomingRows = [], existingByKey = new Map()) {
  const changes = []
  for (const incoming of incomingRows) {
    if (!incoming) continue
    const key = incoming.linkedin_url || (incoming.email ? incoming.email.toLowerCase() : null)
    if (!key) continue
    const existing = existingByKey.get(key)
    if (!existing) continue
    const change = detectChange(incoming, existing)
    if (change) changes.push(change)
  }
  return changes
}

// Two or more of the customer's contacts landing at the same new employer
// inside one import is a team being built, which is a materially bigger
// opportunity than two unrelated moves and reads completely differently in the
// feed. Detected here because it is free once the moves are in hand.
export function detectCoMovement(changes = []) {
  const byDestination = new Map()
  for (const c of changes) {
    if (c.type !== CHANGE_JOB_MOVE) continue
    const key = normalizeCompanyName(c.to.company)
    if (!key) continue
    if (!byDestination.has(key)) byDestination.set(key, [])
    byDestination.get(key).push(c)
  }
  return [...byDestination.values()].filter(group => group.length >= 2)
}

/**
 * Signal rows for one detected change.
 *
 * Job moves produce TWO rows, and the vacated-seat row is deliberately first —
 * it is the stronger lead. An earlier mock of this feature got the direction
 * backwards: it read "September had him at Al Akaria, October does not" and
 * then narrated it as an arrival, telling the recruiter about a new seat that
 * the data never showed. What the data supports is that he LEFT, and therefore
 * that his old employer probably has a role open.
 *
 * The copy stays plain. "Has left X" and "X is likely replacing a Y" are what a
 * recruiter would actually say to another recruiter.
 */
export function buildChangeSignals(change, { userId, now = new Date() } = {}) {
  if (!change) return []
  const at = now.toISOString()
  const rows = []
  const who = change.name || 'A contact'
  const sourceUrl = change.linkedin_url || null

  if (change.type === CHANGE_JOB_MOVE) {
    const leftRole = change.from.title || 'their role'

    if (change.from.company && !isPlaceholderCompany(change.from.company)) {
      rows.push({
        user_id: userId,
        signal_type: 'leadership_change',
        company_name: change.from.company,
        headline: `${who} has left ${change.from.company}`,
        why_it_matters: `${who} was ${leftRole} at ${change.from.company} and is now at ${change.to.company}. ${change.from.company} is likely replacing them, and you already have a relationship there.`,
        contact_name: who,
        contact_title: leftRole,
        contact_linkedin_url: sourceUrl,
        contact_verified: false,
        linked_contact_id: change.contactId,
        source_url: sourceUrl,
        source_label: 'Your LinkedIn export',
        source_verified: true,
        event_at: at,
        dedup_key: `move-left:${change.contactId}:${normalizeCompanyName(change.from.company)}`,
        status: 'new',
      })
    }

    rows.push({
      user_id: userId,
      signal_type: 'leadership_change',
      company_name: change.to.company,
      headline: `${who} has joined ${change.to.company}`,
      why_it_matters: `${who} moved from ${change.from.company || 'their previous employer'} to ${change.to.company}${change.to.title ? ` as ${change.to.title}` : ''}. They are new there and already know you.`,
      contact_name: who,
      contact_title: change.to.title || null,
      contact_linkedin_url: sourceUrl,
      contact_verified: false,
      linked_contact_id: change.contactId,
      source_url: sourceUrl,
      source_label: 'Your LinkedIn export',
      source_verified: true,
      event_at: at,
      dedup_key: `move-joined:${change.contactId}:${normalizeCompanyName(change.to.company)}`,
      status: 'new',
    })
    return rows
  }

  if (change.type === CHANGE_PROMOTION) {
    rows.push({
      user_id: userId,
      signal_type: 'leadership_change',
      company_name: change.to.company,
      headline: `${who} has been promoted at ${change.to.company}`,
      why_it_matters: `${who} has gone from ${change.from.title} to ${change.to.title}. Same company you already know, bigger remit, and usually a budget to go with it.`,
      contact_name: who,
      contact_title: change.to.title || null,
      contact_linkedin_url: sourceUrl,
      contact_verified: false,
      linked_contact_id: change.contactId,
      source_url: sourceUrl,
      source_label: 'Your LinkedIn export',
      source_verified: true,
      event_at: at,
      // The old title is in the key so a later promotion at the same company
      // is a new signal rather than a silent duplicate of the first.
      dedup_key: `promotion:${change.contactId}:${normalizeCompanyName(change.from.title || '')}`,
      status: 'new',
    })
  }
  return rows
}

export function buildAllChangeSignals(changes = [], opts = {}) {
  return changes.flatMap(c => buildChangeSignals(c, opts))
}

// What the contact row itself should become. Kept separate from the signals so
// the CRM is updated even if signal insertion fails — losing a lead is
// recoverable on the next import, silently keeping a stale employer on a
// contact is not.
export function contactUpdateFor(change) {
  if (!change) return null
  // The facets are recomputed, not just carried over. seniority_band and
  // function_area are derived from the title, so a move or a promotion makes
  // the stored ones wrong the moment the title changes — and the backlog and
  // the watchlist both rank on them. Writing the new company without the new
  // band would leave a promoted Head of Strategy still filed as a Director.
  const facets = deriveContactFacets({ title: change.to.title, company: change.to.company })
  return {
    id: change.contactId,
    company: change.to.company,
    title: change.to.title || null,
    seniority_band: facets.seniority_band,
    function_area: facets.function_area,
    is_competitor: facets.is_competitor,
  }
}

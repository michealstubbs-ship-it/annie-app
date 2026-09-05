// Turning the CRM's own untouched relationships into feed items.
//
// These are synthesised in the browser from contacts that are ALREADY loaded
// by useStream, not written to intelligence_signals by a cron. That is a
// deliberate choice and worth recording, because the obvious alternative looks
// tidier and is worse:
//
//   * always current — it reflects the CRM as it is this second, so a contact
//     edited a minute ago is ranked correctly with no scan to wait for.
//   * nothing to reconcile — no dedup_key, no background function, no rows to
//     expire when a contact is deleted or a company is renamed.
//   * actioning is already modelled — logging a note sets last_contacted, and
//     exclusionReason() drops anyone with last_contacted. The thing that
//     removes a backlog lead is the thing a recruiter actually does.
//
// The one capability a real row would have given us is a persistent "park",
// which contacts.backlog_parked_at carries instead.
import { rankBacklog, backlogHeadline, backlogWhyItMatters } from '../backlogRanking'
import { normalizeCompanyName } from '../companyMatch'

export const BACKLOG_SIGNAL_TYPE = 'network_backlog'

// A backlog lead is a relationship with no event attached, so it must not
// out-rank a real trigger at a company the recruiter already knows. It sits
// level with live_job: both are things you could act on today, and the way-in
// rung is what separates them from there.
export const BACKLOG_TYPE_WEIGHT = 4

// If ADQ already has a leadership-change card in the feed, a second ADQ card
// saying "you know four people at ADQ" is noise — the way-in panel on the first
// card already says that, better, with a reason attached.
function companiesWithLiveSignals(signals = []) {
  const set = new Set()
  for (const s of signals) {
    if (!s || s.status === 'actioned') continue
    const key = normalizeCompanyName(s.company_name || '')
    if (key) set.add(key)
  }
  return set
}

/**
 * Synthetic signal rows for the top untouched relationships in the CRM.
 *
 * Shaped exactly like an intelligence_signals row so StreamItem, computeWayIn,
 * the LinkedIn route builder and the draft panel all work on them unchanged —
 * the point is that this is one feed, not two.
 */
export function buildBacklogSignals({ contacts = [], signals = [], functions = [], limit, now = new Date() } = {}) {
  const taken = companiesWithLiveSignals(signals)

  const eligible = contacts.filter(c => {
    if (!c || c.backlog_parked_at) return false
    const key = normalizeCompanyName(c.company || '')
    return key ? !taken.has(key) : false
  })

  return rankBacklog(eligible, { functions, limit, now }).map(entry => {
    const { contact } = entry
    return {
      // Namespaced so it can never collide with a real signal UUID, and so
      // anything downstream that needs to know can tell the difference.
      id: `backlog:${contact.id}`,
      user_id: contact.user_id || null,
      signal_type: BACKLOG_SIGNAL_TYPE,
      company_name: contact.company,
      company_domain: null,
      company_industry: null,
      headline: backlogHeadline(contact),
      why_it_matters: backlogWhyItMatters(entry),

      // The contact IS the lead here, so it is filled in from the CRM rather
      // than resolved. This is the whole cost argument for the pivot: no Apollo
      // credit is spent, because the customer already owns this person.
      contact_name: contact.name || null,
      contact_title: contact.title || null,
      contact_linkedin_url: contact.linkedin_url || null,
      contact_email: contact.email || null,
      linked_contact_id: contact.id,

      // contact_verified is reserved for a real Apollo match and must never be
      // set by inference. A CRM row is better evidence than an Apollo match,
      // but it is not the thing that badge means.
      contact_verified: false,

      // The source is the customer's own CRM. Saying so plainly is more honest
      // than pointing at a LinkedIn URL as though Annie found it in the market.
      source_url: contact.linkedin_url || null,
      source_label: 'Your CRM',
      source_verified: true,

      // No event happened, so there is no event_at. found_at drives freshness
      // scoring; using "now" would make every backlog item permanently the
      // newest thing in the feed and drown real news.
      event_at: null,
      found_at: contact.created_at || null,

      status: 'new',
      who_to_approach: null,
      likely_roles: null,
      candidate_angle: null,
      dedup_key: `backlog:${contact.id}`,

      // Carried through for the UI and for tests; not a database column.
      backlog: {
        score: entry.score,
        reasons: entry.reasons,
        atCompany: entry.atCompany,
        seniorityBand: contact.seniority_band,
        functionArea: contact.function_area,
      },
    }
  })
}

export function isBacklogSignal(signal) {
  return signal?.signal_type === BACKLOG_SIGNAL_TYPE
}

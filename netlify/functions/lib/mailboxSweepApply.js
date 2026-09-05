// The database half of the 18-month sweep: where the tallies are kept, and how
// the two-way ones become contacts.
//
// Split from mailboxSweep.js on purpose. That file is the rule and can be read
// and tested without a database; this file is the consequence and can be read
// and tested without a mailbox. The one thing NEITHER of them has is a note
// writer: nothing here imports emailNote.js or aiUsage.js, calls writeNote(),
// or touches an Anthropic key, and mailboxSweepApply.test.js pins that as a
// standing assertion. The backfill's whole justification is that it costs zero
// AI tokens, and a cost guarantee that lives only in someone's memory of the
// design is not a guarantee.
//
// WHERE THE DATA LIVES, AND WHY IN TWO PLACES
//
//   email_interactions   every counterparty the sweep saw, promoted or not.
//                        This is the background data the promotion rule keeps
//                        rather than throws away: the newsletters, the
//                        suppliers, the one-way blasts, the free-mail
//                        correspondents. It is the audit trail for "why is
//                        this person not in my CRM", and it is what makes a
//                        later decision about free mail possible against a
//                        real number.
//
//   contacts             only the ones that earned it. Interaction history is
//                        mirrored onto the contact row (first_exchange_at,
//                        last_exchange_at, messages_sent, messages_received)
//                        so the way-in ladder, the backlog ranking and the
//                        contact card can read it without a join. Measured on
//                        production 2026-09-05: zero of 753 contacts had ANY
//                        interaction history, which is why the 'client' rung
//                        of deriveRelationshipTier has never fired for anyone.
//
// Deliberately absent from both: any column holding a message body or a note.
// The sweep reads metadata only — there is no body to keep.

import { promotionVerdict, mergeTally, summariseSweep } from './mailboxSweep.js'
import { resolveCompanyName, ensureCompany, matchContact } from './emailMatch.js'
// One definition of the relationship ladder, imported rather than restated.
// The network-first migration says so in as many words: "the classifier lives
// in src/lib/contactFacets.js, and both the importer and the backfill call that
// one function." This is the backfill, and it is the first thing in the
// codebase that can pass hasTwoWayHistory truthfully.
import { deriveRelationshipTier } from '../../../src/lib/contactFacets.js'

export const INTERACTIONS_TABLE = 'email_interactions'

// Postgres will happily take a 10,000-element IN list and then time out. Pages
// are 250 messages and collapse to at most 250 distinct addresses, so this is
// headroom rather than a real constraint.
const IN_CHUNK = 250

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** A stored row read back into the shape mergeTally() and the rule understand. */
export function tallyFromRow(row) {
  if (!row) return null
  return {
    email: row.counterparty_email,
    domain: row.counterparty_domain || '',
    name: row.counterparty_name || null,
    kind: row.kind || 'person',
    sent: Number(row.messages_sent || 0),
    received: Number(row.messages_received || 0),
    autoReplies: Number(row.auto_replies || 0),
    firstAt: row.first_exchange_at || null,
    lastAt: row.last_exchange_at || null,
  }
}

/** And back the other way, for the upsert. */
export function rowFromTally(tally, { userId, accountId }) {
  return {
    user_id: userId,
    account_id: accountId,
    counterparty_email: tally.email,
    counterparty_domain: tally.domain || '',
    counterparty_name: tally.name || null,
    kind: tally.kind || 'person',
    messages_sent: tally.sent || 0,
    messages_received: tally.received || 0,
    auto_replies: tally.autoReplies || 0,
    first_exchange_at: tally.firstAt || null,
    last_exchange_at: tally.lastAt || null,
    updated_at: new Date().toISOString(),
  }
}

/**
 * Fold one page's tallies into the stored interaction rows.
 *
 * TWO queries per page, not one per person. At 250 messages a page and ~208
 * pages for a 52,000-message mailbox that is ~416 database round trips for the
 * entire backfill; doing it per person would be tens of thousands. The read
 * happens first so the values written are absolute rather than incremental,
 * which is what makes a re-delivered page safe to fold twice at the row level
 * even though the cursor is persisted specifically so it does not happen.
 *
 * Only one sweep runs per account at a time (email_accounts carries the cursor
 * and the run that owns it), so read-merge-write needs no locking.
 */
export async function recordInteractions(supabase, { userId, accountId, tallies }) {
  const list = tallies instanceof Map ? [...tallies.values()] : (tallies || [])
  const fresh = list.filter(t => t && t.email)
  if (!supabase || !userId || !accountId || !fresh.length) {
    return { written: 0, error: null }
  }

  const byEmail = new Map(fresh.map(t => [t.email, t]))

  for (const emails of chunk([...byEmail.keys()], IN_CHUNK)) {
    const { data: existing, error } = await supabase
      .from(INTERACTIONS_TABLE)
      .select('counterparty_email, counterparty_domain, counterparty_name, kind, messages_sent, messages_received, auto_replies, first_exchange_at, last_exchange_at')
      .eq('account_id', accountId)
      .in('counterparty_email', emails)

    if (error) return { written: 0, error }

    for (const row of existing || []) {
      const key = row?.counterparty_email
      if (!key || !byEmail.has(key)) continue
      byEmail.set(key, mergeTally(tallyFromRow(row), byEmail.get(key)))
    }
  }

  const rows = [...byEmail.values()].map(t => rowFromTally(t, { userId, accountId }))
  const { error } = await supabase
    .from(INTERACTIONS_TABLE)
    .upsert(rows, { onConflict: 'account_id,counterparty_email' })

  return { written: error ? 0 : rows.length, error: error || null }
}

/**
 * The people whose promotion has not yet been decided AND who now pass the
 * two-way test.
 *
 * The filter is in the query rather than in JS because the one-way majority is
 * the bulk of the table and there is no reason to pull it across the wire. Note
 * what this implies about ORDER: promotion cannot run until BOTH roles have
 * been swept. During the sent pass every single person looks one-way, because
 * their replies are in the inbox pass that has not run yet. Deciding as you go
 * would promote nobody and then never reconsider them.
 */
export async function loadPromotionQueue(supabase, { accountId, limit = 200 }) {
  const { data, error } = await supabase
    .from(INTERACTIONS_TABLE)
    .select('id, counterparty_email, counterparty_domain, counterparty_name, kind, messages_sent, messages_received, auto_replies, first_exchange_at, last_exchange_at')
    .eq('account_id', accountId)
    .is('decided_at', null)
    .gt('messages_sent', 0)
    .gt('messages_received', 0)
    .limit(limit)

  return { rows: data || [], error: error || null }
}

async function markDecided(supabase, { id, outcome, contactId = null }) {
  if (!id) return
  await supabase
    .from(INTERACTIONS_TABLE)
    .update({
      decided_at: new Date().toISOString(),
      promotion_outcome: outcome,
      contact_id: contactId,
    })
    .eq('id', id)
}

function earliest(a, b) {
  if (!a) return b || null
  if (!b) return a
  return a < b ? a : b
}

function latest(a, b) {
  if (!a) return b || null
  if (!b) return a
  return a > b ? a : b
}

/**
 * One interaction row, decided.
 *
 * Dedupe order is email first, then name + company — matchContact()'s existing
 * three-tier match, reused rather than reimplemented. That matters more here
 * than anywhere else in the codebase: this runs against a CRM that a LinkedIn
 * import has already filled with 753 rows, and a second row for someone already
 * imported is exactly the mess the import was criticised for. A duplicate is
 * visible and mergeable; a WRONG merge is silent, which is why matchContact
 * matches on exact evidence and never scores similarity.
 */
export async function promoteInteraction(supabase, { userId, row }) {
  const tally = tallyFromRow(row)
  const verdict = promotionVerdict(tally)

  // Held, not promoted, and recorded as held. Role addresses land here even
  // though they passed the two-way test — see HELD_KINDS.
  if (!verdict.promote) {
    await markDecided(supabase, { id: row.id, outcome: verdict.reason })
    return { promoted: false, outcome: verdict.reason, contactId: null }
  }

  // A free-mail address is a person, not an employer. They become a contact
  // like anyone else who wrote back, but with NO company — "gmail.com" is not
  // where they work, and inventing one would put a company into the watchlist
  // that Annie would then go and scan for leadership changes.
  //
  // Michael, 2026-09-05: "Corporate domain = a company Annie watches.
  // Gmail/Hotmail = no company."
  const resolved = verdict.company === false ? null : await resolveCompanyName(supabase, tally.domain)
  const companyName = resolved?.name || null

  let companyId = null
  if (companyName) {
    const company = await ensureCompany(supabase, { userId, companyName, domain: tally.domain })
    companyId = company?.id || null
  }

  const match = await matchContact(supabase, {
    // Two-way is already proved by the time a row reaches here, so a personal
    // address is a person this recruiter genuinely corresponds with rather
    // than an unknown sender. See promotionVerdict.
    allowPersonal: verdict.company === false,
    userId,
    email: tally.email,
    name: tally.name,
    domain: tally.domain,
    kind: tally.kind,
    companyName,
    companyId,
  })

  if (!match?.contactId) {
    await markDecided(supabase, { id: row.id, outcome: match?.outcome || 'no_contact' })
    return { promoted: false, outcome: match?.outcome || 'no_contact', contactId: null }
  }

  // Read the row back for the fields matchContact does not return. A contact
  // can legitimately be reached by two addresses (a work address and a later
  // alias both matching on name + company), so the counts are summed and the
  // dates widened rather than overwritten — otherwise the second address would
  // erase the first one's history.
  const { data: current } = await supabase
    .from('contacts')
    .select('id, email, phone, last_contacted, first_exchange_at, last_exchange_at, messages_sent, messages_received')
    .eq('id', match.contactId)
    .maybeSingle()

  const firstAt = earliest(current?.first_exchange_at || null, tally.firstAt)
  const lastAt = latest(current?.last_exchange_at || null, tally.lastAt)

  const patch = {
    first_exchange_at: firstAt,
    last_exchange_at: lastAt,
    messages_sent: Number(current?.messages_sent || 0) + tally.sent,
    messages_received: Number(current?.messages_received || 0) + tally.received,
    // The one call in this codebase that can pass hasTwoWayHistory: true and
    // mean it. deriveRelationshipTier's own comment: "Only the mailbox backfill
    // can earn this, because only it can show an exchange actually happened."
    relationship_tier: deriveRelationshipTier({
      email: current?.email || tally.email,
      phone: current?.phone || null,
      hasTwoWayHistory: true,
    }),
  }

  // last_contacted only ever moves FORWARD. A sweep reaching 18 months back
  // must not drag a contact the recruiter spoke to last week backwards to an
  // exchange from last year — that would make a live relationship look dormant
  // and drop it out of the backlog ranking, which reads last_contacted.
  const priorContact = current?.last_contacted || null
  if (lastAt && (!priorContact || lastAt > priorContact)) patch.last_contacted = lastAt

  const { error } = await supabase.from('contacts').update(patch).eq('id', match.contactId)
  await markDecided(supabase, {
    id: row.id,
    outcome: error ? 'update_failed' : match.outcome,
    contactId: match.contactId,
  })

  return {
    promoted: !error,
    outcome: error ? 'update_failed' : match.outcome,
    contactId: match.contactId,
    companyName,
  }
}

/**
 * Work the promotion queue until it is empty or the run is out of time.
 *
 * Out of time is a normal outcome, not a failure: decided_at is per row, so the
 * next invocation picks up exactly where this one stopped without redoing any
 * of it.
 */
export async function runPromotions(supabase, { userId, account, deadlineAt = Infinity, maxRows = 5000 }) {
  const tally = {
    promoted: 0, matchedExisting: 0, created: 0,
    heldFreeMail: 0, heldRole: 0, failed: 0, companies: new Set(),
  }
  let processed = 0
  // A row that throws is left undecided on purpose — whatever broke may be
  // transient and the next run should try it again. That makes it a re-read on
  // the very next page load, though, so it is parked for the rest of THIS run.
  // Without that, and without the no-progress break below, one permanently
  // broken row would have the queue serve the same page back forever.
  const failedThisRun = new Set()

  while (processed < maxRows) {
    if (Date.now() > deadlineAt) return { ...tally, companies: [...tally.companies], outOfTime: true }

    const { rows, error } = await loadPromotionQueue(supabase, { accountId: account.id, limit: 200 })
    if (error || !rows.length) {
      return { ...tally, companies: [...tally.companies], outOfTime: false, error: error || null }
    }

    let decidedThisPage = 0
    for (const row of rows) {
      if (Date.now() > deadlineAt) return { ...tally, companies: [...tally.companies], outOfTime: true }
      if (failedThisRun.has(row.id)) continue
      processed += 1

      let result
      try {
        result = await promoteInteraction(supabase, { userId, row })
      } catch {
        // One bad row must never stop the promotion pass. It stays undecided
        // and is retried on the next run rather than silently lost.
        tally.failed += 1
        failedThisRun.add(row.id)
        continue
      }
      decidedThisPage += 1

      if (result.promoted) {
        tally.promoted += 1
        if (result.outcome === 'created') tally.created += 1
        else tally.matchedExisting += 1
        if (result.companyName) tally.companies.add(result.companyName)
      } else if (result.outcome === 'free_mail') tally.heldFreeMail += 1
      else if (result.outcome === 'role_address') tally.heldRole += 1
      else tally.failed += 1
    }

    // Nothing on that page could be decided, so the next page load would return
    // the identical rows. Stop rather than spin.
    if (!decidedThisPage) break
  }

  return { ...tally, companies: [...tally.companies], outOfTime: false }
}

/**
 * The whole-sweep tally, read back off the interaction table.
 *
 * Computed from storage rather than accumulated in memory because a sweep can
 * span several invocations, and a total that only counts what THIS run saw
 * would be wrong on every mailbox big enough to need resuming.
 */
export async function sweepTotals(supabase, { accountId, pageSize = 1000, maxPages = 200 }) {
  const rows = []
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await supabase
      .from(INTERACTIONS_TABLE)
      .select('counterparty_email, kind, messages_sent, messages_received, auto_replies')
      .eq('account_id', accountId)
      .range(page * pageSize, page * pageSize + pageSize - 1)

    if (error) break
    const batch = data || []
    for (const r of batch) {
      rows.push({
        email: r.counterparty_email,
        kind: r.kind,
        sent: Number(r.messages_sent || 0),
        received: Number(r.messages_received || 0),
        autoReplies: Number(r.auto_replies || 0),
      })
    }
    if (batch.length < pageSize) break
  }
  return summariseSweep(rows)
}

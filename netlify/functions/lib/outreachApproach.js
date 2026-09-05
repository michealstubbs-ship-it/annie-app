// The two writes that close the outreach loop: an approach was sent, and an
// approach was answered.
//
// Everything about which approaches worked rests on the second one, so the
// whole file is written around a single question — what is honestly a reply?
//
// The rule, stated once
// ---------------------
// An inbound message answers an approach when ALL of these hold:
//
//   1. it came IN (direction 'in')
//   2. it is not an auto-reply       (detectAutoReply — out-of-office, vacation)
//   3. it is not a delivery failure  (detectBounce — DSN/NDR)
//   4. it is from the same address the approach was sent to
//   5. it arrived at or after the approach was sent
//   6. either it is on the same mail thread (certain, any age), or it arrived
//      inside REPLY_WINDOW_DAYS of the send (a judgement, and the only one)
//
// Rules 2 and 3 are enforced by the caller in emailIngest.js, before this file
// is reached — they are gates on the message, not on the approach, and putting
// them here would mean a second implementation of "is this a person".
//
// Rule 6 is the only place judgement enters. Without a window, an approach
// stays open forever, and an unrelated mail from that person eleven months
// later would be recorded as an answer to it. Ninety days is deliberately
// generous — long enough that a real BD reply after two rounds of internal
// approval still lands, short enough that "they wrote to me about something
// else the following year" does not become a result. When the thread id
// matches there is no judgement to make and no window is applied.

import { normaliseCompany } from './emailMatch.js'

export const REPLY_WINDOW_DAYS = 90
const REPLY_WINDOW_MS = REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000

// The reply matcher scans open approaches to one address in JS rather than
// pushing the time comparison into the query. There are single-digit rows per
// address; the readability is worth more than the round trip.
const OPEN_SCAN_LIMIT = 50

// Enough to count a mid-sized firm's contacts at one company without paging.
// Over this, the count is reported as-is rather than guessed at — an
// approximate number would be quoted back to the customer as a fact.
const COMPANY_CONTACT_SCAN_LIMIT = 1000

function lower(raw) {
  return String(raw || '').trim().toLowerCase()
}

function ms(value) {
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * How many OTHER contacts the user already had at this company.
 *
 * Snapshotted onto the approach at send time, because it is the fact the
 * readout leans on and it drifts: a contact added next week would otherwise
 * silently rewrite what was true when the approach went out.
 *
 * Matching mirrors ensureCompany — the company_id when there is one, and a
 * normalised exact name otherwise. Nothing looser: a wrong match here inflates
 * "you already knew someone there", which is the one claim the readout makes.
 *
 * Returns null, never 0, when it cannot be established. The readout treats
 * null as unknown and refuses to make the claim at all, where a 0 would be an
 * assertion that the recruiter knew nobody.
 */
export async function countOtherContactsAtCompany(supabase, {
  userId,
  companyId = null,
  companyName = null,
  excludeContactId = null,
} = {}) {
  if (!supabase || !userId) return null
  if (!companyId && !String(companyName || '').trim()) return null

  const { data, error } = await supabase
    .from('contacts')
    .select('id, company, company_id')
    .eq('user_id', userId)
    .limit(COMPANY_CONTACT_SCAN_LIMIT)

  if (error) return null

  const key = normaliseCompany(companyName || '')
  let n = 0
  for (const c of data || []) {
    if (!c || c.id === excludeContactId) continue
    if (companyId && c.company_id === companyId) { n += 1; continue }
    if (key && normaliseCompany(c.company || '') === key) n += 1
  }
  return n
}

/**
 * Record that an approach went out.
 *
 * Best-effort by contract: the mail has already left the recruiter's mailbox
 * by the time this runs, so a failure here is logged and swallowed. Turning a
 * delivered message into a visible error would invite the customer to send it
 * a second time, which is a real harm; missing a row in a readout is not.
 *
 * Returns { recorded, id, knownAtCompany, seniorityBand, reason }.
 */
export async function recordApproach(supabase, {
  userId,
  signalId = null,
  signalType = null,
  contactId = null,
  companyId = null,
  companyName = null,
  toEmail,
  subject = null,
  sentAt = null,
  emailMessageId = null,
  threadId = null,
} = {}) {
  const email = lower(toEmail)
  if (!supabase || !userId || !email) return { recorded: false, reason: 'bad_input' }

  // The recipient's seniority, read from their contact record rather than
  // guessed from a title here. Unknown stays unknown — see the migration's
  // comment on the column.
  let seniorityBand = null
  if (contactId) {
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, seniority_band')
      .eq('id', contactId)
      .maybeSingle()
    seniorityBand = contact?.seniority_band || null
  }

  const knownAtCompany = await countOtherContactsAtCompany(supabase, {
    userId,
    companyId,
    companyName,
    excludeContactId: contactId,
  })

  const { data, error } = await supabase
    .from('outreach_approaches')
    .insert({
      user_id: userId,
      signal_id: signalId || null,
      signal_type: signalType || null,
      contact_id: contactId || null,
      company_id: companyId || null,
      company_name: companyName || null,
      to_email: email,
      subject: subject || null,
      sent_at: sentAt || new Date().toISOString(),
      email_message_id: emailMessageId || null,
      thread_id: threadId || null,
      seniority_band: seniorityBand,
      known_at_company: knownAtCompany,
    })
    .select('id')
    .single()

  if (error) {
    // 23505 is the one-approach-per-message index doing its job on a retried
    // send. Not a failure, and specifically not something to report.
    if (error.code === '23505') return { recorded: false, reason: 'already_recorded' }
    return { recorded: false, reason: 'insert_failed', error: error.message }
  }

  return { recorded: true, id: data?.id || null, knownAtCompany, seniorityBand }
}

/**
 * Mark the approach this message answers, if it answers one.
 *
 * The caller must already have established that this is a genuine inbound
 * message from a person — see the rule at the top of this file. This function
 * deliberately does NOT re-check for an auto-reply or a bounce, because a
 * second copy of that judgement is a second place for it to be wrong; it is
 * the caller's job not to call it for a robot.
 *
 * Only ever closes ONE approach: the most recent open one that fits. If a
 * recruiter approached the same person twice, one reply answers the latest
 * attempt, and claiming it answered both would double-count.
 *
 * Returns { matched, approachId, basis } — basis is 'thread' or 'window', so
 * the reason a reply was credited is recoverable rather than inferred.
 */
export async function markApproachReplied(supabase, {
  userId,
  fromEmail,
  repliedAt,
  emailMessageId = null,
  threadId = null,
  now = null,
} = {}) {
  const email = lower(fromEmail)
  const replyMs = ms(repliedAt) ?? ms(now) ?? Date.now()
  if (!supabase || !userId || !email) return { matched: false, reason: 'bad_input' }

  const { data, error } = await supabase
    .from('outreach_approaches')
    .select('id, sent_at, thread_id, contact_id, signal_id')
    .eq('user_id', userId)
    .eq('to_email', email)
    .is('replied_at', null)
    .limit(OPEN_SCAN_LIMIT)

  if (error) return { matched: false, reason: 'lookup_failed', error: error.message }

  const thread = String(threadId || '').trim()
  const candidates = []
  for (const row of data || []) {
    const sentMs = ms(row?.sent_at)
    if (sentMs === null) continue
    // A reply cannot predate the message it answers.
    if (replyMs < sentMs) continue

    const sameThread = Boolean(thread && String(row.thread_id || '').trim() === thread)
    if (!sameThread && replyMs - sentMs > REPLY_WINDOW_MS) continue

    candidates.push({ row, sentMs, basis: sameThread ? 'thread' : 'window' })
  }

  if (!candidates.length) return { matched: false, reason: 'no_open_approach' }

  // A thread match is certain, so it outranks a merely recent one. Within the
  // same kind, the latest send is the one this answers.
  candidates.sort((a, b) => {
    if (a.basis !== b.basis) return a.basis === 'thread' ? -1 : 1
    return b.sentMs - a.sentMs
  })
  const best = candidates[0]

  const { error: updateError } = await supabase
    .from('outreach_approaches')
    .update({
      replied_at: new Date(replyMs).toISOString(),
      reply_message_id: emailMessageId || null,
    })
    .eq('id', best.row.id)

  if (updateError) return { matched: false, reason: 'update_failed', error: updateError.message }

  return {
    matched: true,
    approachId: best.row.id,
    basis: best.basis,
    signalId: best.row.signal_id || null,
    contactId: best.row.contact_id || null,
  }
}

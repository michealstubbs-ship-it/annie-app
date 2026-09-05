// One message in, one CRM record out.
//
// This is the orchestrator: it decides nothing itself, it sequences the
// decisions made in emailSync.js (is this a person?), emailMatch.js (who are
// they?), emailNote.js (what happened?) and outreachApproach.js (did this
// answer something we sent?).
//
// That last one is why the auto-reply and bounce gates below are computed in
// one place and read three times — by the note, by last_contacted, and by the
// approach ledger. Three separate judgements about what counts as an answer is
// three chances for the product to tell a customer their approach worked when
// what actually came back was an out-of-office or an undeliverable notice.
//
// The ordering below is not arbitrary. The ledger row is CLAIMED before any
// expensive work happens, because webhooks retry and backfills get re-run. The
// unique constraint on (account_id, provider_message_id) is what makes a
// duplicate delivery cost nothing instead of writing the same note twice and
// paying Anthropic twice for the privilege.

import { classifyAddress, pickCounterparty, detectAutoReply, detectBounce, parseSignature } from './emailSync.js'
import { resolveCompanyName, ensureCompany, matchContact, applySignature, appendContactNote } from './emailMatch.js'
import { writeNote, autoReplyNote } from './emailNote.js'
import { markApproachReplied } from './outreachApproach.js'

const SKIP = (reason, extra = {}) => ({ ingested: false, reason, ...extra })

export function ownIdentity(account, extraAddresses = []) {
  const address = String(account?.email_address || '').trim().toLowerCase()
  const domain = address.includes('@') ? address.split('@').pop() : ''
  const ownAddresses = [address, ...extraAddresses.map(a => String(a || '').toLowerCase())].filter(Boolean)
  return { ownAddresses, ownDomains: domain ? [domain] : [] }
}

/**
 * @param supabase  service-role client (RLS is bypassed; every write below
 *                  stamps user_id explicitly so rows land on the right tenant)
 */
export async function ingestMessage(supabase, {
  userId,
  account,
  message,
  anthropicKey = null,
  onUsage = null,
  extraOwnAddresses = [],
}) {
  if (!supabase || !userId || !account?.id || !message) return SKIP('bad_input')

  const providerMessageId = message.id || message.provider_id || message.message_id
  if (!providerMessageId) return SKIP('no_message_id')

  const { ownAddresses, ownDomains } = ownIdentity(account, extraOwnAddresses)

  // --- pure decisions, free, before anything is written ---------------------
  const who = pickCounterparty(message, { ownAddresses })
  if (!who) return SKIP('no_counterparty')

  const verdict = classifyAddress(who.email, { ownAddresses, ownDomains })
  if (verdict.kind === 'reject') return SKIP(`filtered_${verdict.reason}`)

  const sentAt = message.date || message.sent_at || new Date().toISOString()

  // --- claim the row, so a retry is free -----------------------------------
  const { data: claimed, error: claimError } = await supabase
    .from('email_messages')
    .insert({
      user_id: userId,
      account_id: account.id,
      provider_message_id: providerMessageId,
      thread_id: message.thread_id || null,
      direction: who.direction,
      counterparty_email: who.email,
      counterparty_name: who.name || null,
      counterparty_domain: who.domain,
      subject: message.subject || null,
      sent_at: sentAt,
    })
    .select('id')
    .single()

  if (claimError) {
    // 23505 is the unique constraint doing its job: we have seen this one.
    if (claimError.code === '23505') return SKIP('already_ingested')
    return SKIP('claim_failed', { error: claimError.message })
  }

  const ledgerId = claimed.id
  const finish = async (patch) => {
    await supabase.from('email_messages').update(patch).eq('id', ledgerId)
  }

  // --- an out-of-office is not a conversation ------------------------------
  const auto = detectAutoReply({
    subject: message.subject,
    bodyPlain: message.body_plain,
    headers: message.headers,
    date: sentAt,
  })

  // --- and a bounce is not even a message ----------------------------------
  // Kept separate from the auto-reply flag rather than folded into it: an
  // out-of-office proves the address works and tells you when to come back, a
  // bounce proves the opposite. Reading them as one state would let "away
  // until 21 Sep" and "no such mailbox" produce the same record.
  const bounce = detectBounce({
    subject: message.subject,
    bodyPlain: message.body_plain,
    headers: message.headers,
  })

  // The one definition of an answer, used by the note, by last_contacted and
  // by the approach ledger, so the three can never disagree about what
  // happened. Outbound mail is excluded here for the obvious reason: writing
  // to someone again is not them replying.
  const isHumanReply = who.direction === 'in' && !auto.isAutoReply && !bounce.isBounce

  // --- which company, and does the contact exist? --------------------------
  let companyName = null
  let companyId = null
  if (verdict.kind === 'person' || verdict.kind === 'role') {
    const resolved = await resolveCompanyName(supabase, who.domain)
    companyName = resolved.name || null
    if (companyName && verdict.kind === 'person') {
      const company = await ensureCompany(supabase, { userId, companyName, domain: who.domain })
      companyId = company.id
    }
  }

  const match = await matchContact(supabase, {
    userId,
    email: who.email,
    name: who.name,
    domain: who.domain,
    kind: verdict.kind,
    companyName,
    companyId,
  })

  if (!match.contactId) {
    await finish({ is_auto_reply: auto.isAutoReply, away_until: auto.awayUntil, is_bounce: bounce.isBounce })
    // An approach is still answered when the replier has no contact record —
    // a recruiter who mailed a personal address gets no CRM row for it (see
    // matchContact's tier three), and refusing to count that reply would
    // under-report the very thing this feature measures.
    const orphanReply = isHumanReply
      ? await recordReply(supabase, { userId, who, sentAt, ledgerId, message })
      : { matched: false }
    return {
      ingested: true,
      ledgerId,
      outcome: match.outcome,
      contactId: null,
      noted: false,
      isAutoReply: auto.isAutoReply,
      isBounce: bounce.isBounce,
      answeredApproach: orphanReply.matched === true,
    }
  }

  // --- what their signature gave us for free -------------------------------
  // Inbound only: an outbound message carries the recruiter's own signature,
  // and writing their job title onto their contact's record would be absurd.
  let enriched = { updated: false, fields: [] }
  if (who.direction === 'in' && who.name) {
    const sig = parseSignature(message.body_plain, { name: who.name })
    if (sig.title || sig.phone) enriched = await applySignature(supabase, match.contact, sig)
  }

  // --- the note ------------------------------------------------------------
  let note
  let noteModel = null
  if (bounce.isBounce) {
    // Worth recording and worth paying nothing for. The note writer would
    // summarise a delivery report; this says the one thing that matters.
    note = 'Email could not be delivered'
  } else if (auto.isAutoReply) {
    note = autoReplyNote({ awayUntil: auto.awayUntil })
  } else {
    const written = await writeNote(anthropicKey, {
      direction: who.direction,
      subject: message.subject,
      bodyPlain: message.body_plain,
      counterpartyName: who.name,
      companyName,
    }, { onUsage })
    note = written.note
    noteModel = written.model
  }

  await appendContactNote(supabase, {
    contactId: match.contactId,
    existingNotes: match.contact?.notes || '',
    note,
    sentAt,
    // An auto-reply must never mark an approach answered — that is how a real
    // follow-up gets silently dropped. A bounce is excluded for the stronger
    // reason that the message never arrived, so there was no contact at all.
    countsAsContact: !auto.isAutoReply && !bounce.isBounce,
  })

  await finish({
    contact_id: match.contactId,
    note,
    note_model: noteModel,
    is_auto_reply: auto.isAutoReply,
    away_until: auto.awayUntil,
    is_bounce: bounce.isBounce,
  })

  // --- did this answer an approach? ----------------------------------------
  // Last, and after the note, because it is the only write here that changes
  // what the customer is TOLD rather than what they can read for themselves.
  // If it fails, the note and the contact record are already correct.
  const replied = isHumanReply
    ? await recordReply(supabase, { userId, who, sentAt, ledgerId, message })
    : { matched: false }

  return {
    ingested: true,
    ledgerId,
    outcome: match.outcome,
    contactId: match.contactId,
    companyId,
    companyName,
    noted: true,
    isAutoReply: auto.isAutoReply,
    isBounce: bounce.isBounce,
    answeredApproach: replied.matched === true,
    enrichedFields: enriched.fields,
  }
}

// Never allowed to fail the ingest it is part of: a message is filed whether
// or not the loop-closing bookkeeping succeeds, exactly as the note is.
async function recordReply(supabase, { userId, who, sentAt, ledgerId, message }) {
  try {
    return await markApproachReplied(supabase, {
      userId,
      fromEmail: who.email,
      repliedAt: sentAt,
      emailMessageId: ledgerId,
      threadId: message?.thread_id || null,
    })
  } catch {
    return { matched: false, reason: 'threw' }
  }
}

/**
 * Run a batch and report what happened, in the shape the connect screen shows
 * back to the recruiter: how many people, how many companies, what was skipped.
 */
export async function ingestBatch(supabase, { messages = [], ...ctx }) {
  const summary = {
    read: messages.length,
    created: 0, matchedEmail: 0, matchedName: 0,
    // Logged in the ledger but deliberately not filed as a contact: candidates
    // on gmail, and a company's front desk. Counted so the connect screen can
    // say what it chose not to do, rather than silently dropping them.
    heldPersonal: 0, heldRole: 0,
    skipped: 0, noted: 0, enriched: 0, autoReplies: 0,
    // Delivery failures and answered approaches. Both are counted here so a
    // sweep can be read back as "what did this actually find" without a second
    // query — and so a sudden run of bounces is visible in the report rather
    // than only in the ledger.
    bounces: 0, repliesToApproaches: 0,
    companies: new Set(), reasons: {},
  }

  for (const message of messages) {
    let result
    try {
      result = await ingestMessage(supabase, { ...ctx, message })
    } catch (err) {
      // One malformed message must never stop a mailbox sync.
      result = SKIP('threw', { error: err?.message })
    }

    if (!result.ingested) {
      summary.skipped += 1
      summary.reasons[result.reason] = (summary.reasons[result.reason] || 0) + 1
      continue
    }
    if (result.outcome === 'created') summary.created += 1
    if (result.outcome === 'matched_email') summary.matchedEmail += 1
    if (result.outcome === 'matched_name') summary.matchedName += 1
    if (result.outcome === 'skipped_personal') summary.heldPersonal += 1
    if (result.outcome === 'skipped_role') summary.heldRole += 1
    if (result.noted) summary.noted += 1
    if (result.isAutoReply) summary.autoReplies += 1
    if (result.isBounce) summary.bounces += 1
    if (result.answeredApproach) summary.repliesToApproaches += 1
    if (result.enrichedFields?.length) summary.enriched += 1
    if (result.companyName) summary.companies.add(result.companyName)
  }

  return { ...summary, companies: [...summary.companies] }
}

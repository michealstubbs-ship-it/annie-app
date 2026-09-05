// The 18-month mailbox sweep — the pure decisions, with no network and no
// database in them.
//
// WHY THIS FILE EXISTS AT ALL
//
// The sweep that shipped before this one read 12 pages of 50 messages in each
// direction and stopped: about 600 sent and 600 received, covering whatever
// period that happened to be. It fetched full bodies (meta_only=false) and
// handed every matched message to writeNote(), which is an Anthropic call. The
// obvious fix — "read 18 months instead of 600 messages" — would have taken a
// normal recruiter mailbox of ~12,000 sent and ~40,000 received messages and
// produced on the order of ten thousand model calls on the day somebody signs
// up, before they have seen a single screen of the product. That version was
// rejected on cost, and this file is the design that replaced it.
//
// The whole sweep is METADATA ONLY. meta_only=true, no bodies, no note writer,
// no Anthropic, zero AI tokens. Notes stay forward-only: mail arriving from now
// on still gets its note through the webhook exactly as before. The backfill
// writes none, ever. Nothing in this module imports emailNote.js or aiUsage.js
// and nothing in it ever should — mailboxSweep.test.js asserts that as a
// standing guarantee rather than a convention.
//
// THE PROMOTION RULE
//
// A person becomes a contact only if the conversation went BOTH WAYS: the
// recruiter sent to them AND they sent back, at some point in the window.
//
// One-way mail is not a relationship. It is newsletters, blasts, suppliers,
// conference organisers, no-reply addresses and the long tail of everyone who
// has ever been cc'd on a mailing list. A REPLY is a human being choosing to
// answer — it is the cheapest available proof that a real exchange happened,
// and it needs no model to read it.
//
// The evidence for insisting on this is the LinkedIn CSV import, which is the
// failure this sweep must not repeat at ten times the scale. Michael, on his
// own imported network: "when I did mine it looked very messy with limited
// organisation." That was 753 rows. An 18-month sweep that promoted every
// address it saw would produce several thousand, and it would be the same
// failure with more of it.
//
// Everything that fails the test is still kept — as background interaction
// data, in email_interactions — and is NEVER written into contacts. It is not
// deleted, because a one-way address that later replies becomes two-way, and
// because the counts are worth knowing.
//
// WHAT THE COUNTS ARE FOR
//
// Measured on the production account 2026-09-05: 753 contacts, and ZERO of
// them with any interaction history at all — last_contacted null on all 753,
// notes empty on all 753. That is why deriveRelationshipTier's 'client' rung
// ("proven two-way history") has never once fired for anybody, for any
// customer. This sweep is the first thing in the codebase able to supply
// hasTwoWayHistory truthfully, so it records the relationship rather than just
// the name: first exchange, last exchange, messages sent, messages received.

import { classifyAddress, pickCounterparty, detectAutoReply, detectBounce } from './emailSync.js'

// Eighteen months. Long enough to cover a full hiring cycle plus the year
// before it, so a mandate placed 14 months ago and the person who signed it
// both fall inside the window; short enough that the request count stays in the
// low hundreds. At 250 messages per request, a 12,000-sent / 40,000-received
// mailbox is 52,000 messages and therefore ~208 API requests for the entire
// backfill. The rejected body-reading version was the same 208 requests plus
// roughly 10,000 Anthropic calls.
export const SWEEP_WINDOW_MONTHS = 18

// Unipile caps `limit` at 250 and listEmails() clamps to it. Asking for the
// maximum is the single biggest lever on request count: at the old PAGE = 50
// the same mailbox would cost 1,040 requests instead of 208.
export const SWEEP_PAGE_SIZE = 250

// Kinds classifyAddress can return that the sweep will never promote, with the
// reason recorded rather than inferred later.
//
// 'personal' is free mail — gmail, hotmail, yahoo, outlook.com, icloud and the
// rest of FREE_MAIL_DOMAINS. These ARE promoted when they pass the two-way
// test, but they are filed with NO COMPANY, which is the whole distinction.
//
// Michael, 2026-09-05, settling this directly: "Becomes a contact: anyone you
// and they both sent to each other... Their company: from the email domain.
// Corporate domain = a company Annie watches. Gmail/Hotmail = no company."
//
// The earlier draft held free mail out of the CRM entirely, reasoning that a
// personal address carries no employer for the intelligence engine to watch.
// That was the wrong call and it was mine, not his. Somebody you have genuinely
// corresponded with both ways IS part of your network whatever address they
// wrote from — a candidate, a former colleague, a client who mails from a
// personal account. Filing them without a company is honest about exactly what
// Annie does and does not know: they are in your contacts, they generate no
// company signals, and the day their employer becomes known the rest follows.
//
// 'role' is a company's front desk — info@, careers@, accounts@. Two-way mail
// with a shared mailbox is real, and worth knowing at company level, but a
// contact called "info" helps nobody. This matches what matchContact() already
// does on the forward path, so the two cannot disagree.
export const HELD_KINDS = {
  role: 'role_address',
}

// Kinds that become a contact but never carry a company. classifyAddress's
// 'personal' means the address is on a free-mail domain, so there is no
// employer to derive, watch, or attach signals to.
export const NO_COMPANY_KINDS = new Set(['personal'])

// ---------------------------------------------------------------------------
// The window

/**
 * The `after` bound for the sweep, as an ISO timestamp.
 *
 * Month arithmetic with the day clamped, so a sweep started on the 31st does
 * not silently roll into the next month and quietly shorten the window.
 */
export function sweepWindowStart(now = new Date(), months = SWEEP_WINDOW_MONTHS) {
  const ref = now instanceof Date ? now : new Date(now)
  const base = Number.isNaN(ref.getTime()) ? new Date() : ref

  const year = base.getUTCFullYear()
  const month = base.getUTCMonth() - months
  const day = base.getUTCDate()

  // Day 0 of the following month is the last day of the month we want.
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(
    year, month, Math.min(day, lastDayOfTarget),
    base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(),
  )).toISOString()
}

// ---------------------------------------------------------------------------
// Reading a page defensively
//
// Nobody has ever connected a real mailbox to this product — email_accounts has
// zero rows — so every line below is written against fixtures and against the
// documented response shape, not against something anyone has watched work. The
// rule that follows from that: an unexpected field shape must make the sweep
// stop or skip, never throw. A sweep that dies on page 40 of 208 leaves a
// customer with a half-filled CRM and no explanation.

export function readItems(payload) {
  const candidates = [payload?.items, payload?.emails, payload?.data?.items, payload?.data]
  for (const c of candidates) if (Array.isArray(c)) return c
  return []
}

/**
 * The paging cursor, or null to stop.
 *
 * Only a non-empty string is accepted. If the provider ever returns an object,
 * a number or a boolean here, the sweep ends this role cleanly and resumes from
 * the top of the window next time rather than passing garbage back as a query
 * parameter and paging forever on the same 250 messages.
 */
export function readCursor(payload) {
  const candidates = [payload?.cursor, payload?.next_cursor, payload?.paging?.cursor]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

function toTime(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function earlier(a, b) {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}

function later(a, b) {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

// ---------------------------------------------------------------------------
// Folding a page into per-person tallies

export function emptyTally(email, domain, kind) {
  return {
    email,
    domain: domain || '',
    name: null,
    kind: kind || 'person',
    sent: 0,
    received: 0,
    // Counted, never credited. See the fold below.
    autoReplies: 0,
    firstAt: null,
    lastAt: null,
  }
}

/**
 * Merge two tallies for the same person. Used both to combine pages within a
 * run and to combine a stored email_interactions row with a fresh page, which
 * is what makes the sweep resumable: the numbers are absolute, so re-reading a
 * page you have already seen is the only thing that can double-count, and the
 * cursor is persisted specifically so that does not happen.
 */
export function mergeTally(a, b) {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  return {
    email: a.email || b.email,
    domain: a.domain || b.domain,
    // A confirmed display name beats a name guessed from the local part, and
    // the first one that arrives wins over later ones — providers vary on
    // whether they echo the recruiter's own address-book name back.
    name: a.name || b.name || null,
    kind: a.kind || b.kind || 'person',
    sent: (a.sent || 0) + (b.sent || 0),
    received: (a.received || 0) + (b.received || 0),
    autoReplies: (a.autoReplies || 0) + (b.autoReplies || 0),
    firstAt: earlier(a.firstAt, b.firstAt),
    lastAt: later(a.lastAt, b.lastAt),
  }
}

/**
 * One page of metadata in, a Map of email -> tally out.
 *
 * @param messages  whatever readItems() pulled off the response
 * @param identity  { ownAddresses, ownDomains } from ownIdentity()
 * @param into      an existing Map to fold into, so several pages accumulate
 */
export function foldPage(messages, identity = {}, into = new Map()) {
  const list = Array.isArray(messages) ? messages : []
  // Carried on the Map so several pages folded into the same accumulator report
  // one running total rather than only the last page's.
  const skipped = into.skipped || { noCounterparty: 0, filtered: 0, threw: 0 }

  for (const message of list) {
    try {
      const who = pickCounterparty(message, { ownAddresses: identity.ownAddresses || [] })
      if (!who || !who.email) { skipped.noCounterparty += 1; continue }

      const verdict = classifyAddress(who.email, {
        ownAddresses: identity.ownAddresses || [],
        ownDomains: identity.ownDomains || [],
      })
      if (verdict.kind === 'reject') { skipped.filtered += 1; continue }

      const at = toTime(message?.date || message?.sent_at || message?.timestamp)
      const key = who.email

      const tally = into.get(key) || emptyTally(who.email, who.domain, verdict.kind)
      // classifyAddress is the authority on kind; a later page must not be able
      // to reclassify a person as a role address just because one message came
      // in with a differently-shaped display name.
      tally.kind = verdict.kind
      if (!tally.name && who.name) tally.name = who.name
      if (!tally.domain && who.domain) tally.domain = who.domain

      if (who.direction === 'out') {
        tally.sent += 1
        tally.firstAt = earlier(tally.firstAt, at)
        tally.lastAt = later(tally.lastAt, at)
        into.set(key, tally)
        continue
      }

      // Inbound. This is the half of the test that does the work, so it is also
      // the half that has to be right about what an answer is.
      //
      // An out-of-office is not a reply. Hannah Wild's auto-responder arrived
      // 40 seconds after Michael's mail; counting it as "she wrote back" would
      // promote every address that happens to run a vacation responder, which
      // is the exact one-way blast this rule exists to keep out. A bounce is
      // worse still — it proves the message never arrived, so treating it as
      // evidence of a relationship would be reporting something false rather
      // than merely unproven.
      //
      // With meta_only the body is absent, so this runs on subject and headers
      // alone. detectAutoReply already handles that (Auto-Submitted,
      // Precedence, X-Autoreply, and the subject regex) and detectBounce reads
      // the DSN content type, X-Failed-Recipients and the subject. Both simply
      // return false when they have nothing to go on, which is the safe
      // direction to be wrong in for a bounce and the risky one for an
      // auto-reply — hence keeping include_headers on for the sweep.
      const meta = { subject: message?.subject || '', bodyPlain: '', headers: message?.headers || [], date: at }
      const auto = detectAutoReply(meta)
      const bounce = detectBounce(meta)

      if (auto.isAutoReply || bounce.isBounce) {
        tally.autoReplies += 1
        into.set(key, tally)
        continue
      }

      tally.received += 1
      tally.firstAt = earlier(tally.firstAt, at)
      tally.lastAt = later(tally.lastAt, at)
      into.set(key, tally)
    } catch {
      // One malformed message must never stop a mailbox sweep. There is no
      // fixture for whatever this was, which is precisely why it is counted
      // and stepped over rather than allowed to unwind 200 pages of work.
      skipped.threw += 1
    }
  }

  into.skipped = skipped
  return into
}

// ---------------------------------------------------------------------------
// The rule itself

/**
 * Did the conversation go both ways?
 *
 * Deliberately `> 0` on both sides and nothing else — no threshold, no
 * scoring, no "three messages counts more than one". A single genuine reply is
 * a human choosing to answer, and that is the whole claim being made.
 */
export function isTwoWay(row) {
  return Number(row?.sent || row?.messages_sent || 0) > 0
    && Number(row?.received || row?.messages_received || 0) > 0
}

/**
 * Should this person become a contact, and if not, why not?
 *
 * The reasons are stored, not just returned, so "why is this person not in my
 * CRM" has an answer that is a fact rather than a reconstruction.
 */
export function promotionVerdict(row) {
  if (!row || !(row.email || row.counterparty_email)) {
    return { promote: false, reason: 'no_address' }
  }
  if (!isTwoWay(row)) return { promote: false, reason: 'one_way' }

  const kind = row.kind || 'person'
  if (HELD_KINDS[kind]) return { promote: false, reason: HELD_KINDS[kind] }

  // Promoted, but with no employer — see NO_COMPANY_KINDS. The caller must not
  // invent a company for these: "gmail.com" is not where anybody works.
  if (NO_COMPANY_KINDS.has(kind)) return { promote: true, reason: 'two_way_no_company', company: false }

  return { promote: true, reason: 'two_way', company: true }
}

/**
 * The tally the connect screen and the report are built from.
 *
 * freeMailTwoWay counts the promoted people who came from a free-mail domain
 * and therefore carry no company. They ARE in the CRM; they simply generate no
 * company signals, and the number says how much of the network sits in that
 * state.
 */
export function summariseSweep(rows = []) {
  const out = {
    people: 0,
    twoWay: 0,
    promotable: 0,
    freeMailTwoWay: 0,
    roleTwoWay: 0,
    oneWay: 0,
    messagesSent: 0,
    messagesReceived: 0,
    autoReplies: 0,
  }
  for (const row of rows || []) {
    if (!row) continue
    out.people += 1
    out.messagesSent += Number(row.sent || row.messages_sent || 0)
    out.messagesReceived += Number(row.received || row.messages_received || 0)
    out.autoReplies += Number(row.autoReplies || row.auto_replies || 0)

    const verdict = promotionVerdict(row)
    if (verdict.promote) {
      out.twoWay += 1
      out.promotable += 1
      if (verdict.company === false) out.freeMailTwoWay += 1
      continue
    }
    if (verdict.reason === 'role_address') { out.twoWay += 1; out.roleTwoWay += 1; continue }
    out.oneWay += 1
  }
  return out
}

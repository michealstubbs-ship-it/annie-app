import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SWEEP_WINDOW_MONTHS, SWEEP_PAGE_SIZE, sweepWindowStart,
  readItems, readCursor, foldPage, mergeTally,
  isTwoWay, promotionVerdict, summariseSweep,
} from './mailboxSweep.js'
import { ownIdentity } from './emailSync.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ME = { email_address: 'mstubbs@vantagesearchgroup.me' }
const IDENTITY = ownIdentity(ME)

function sent(to, name, at, extra = {}) {
  return {
    id: `s-${to}-${at}`,
    date: at,
    subject: 'Re: Recruitment',
    from_attendee: { identifier: 'mstubbs@vantagesearchgroup.me', display_name: 'Michael Stubbs' },
    to_attendees: [{ identifier: to, ...(name ? { display_name: name } : {}) }],
    ...extra,
  }
}
function received(from, name, at, extra = {}) {
  return {
    id: `r-${from}-${at}`,
    date: at,
    subject: 'Re: Recruitment',
    from_attendee: { identifier: from, display_name: name },
    to_attendees: [{ identifier: 'mstubbs@vantagesearchgroup.me' }],
    ...extra,
  }
}

describe('the sweep window', () => {
  it('reaches back eighteen months, not a page count', () => {
    // The rejected design read 12 pages of 50 each way and called it done —
    // ~600 messages covering whatever period that happened to be, which on a
    // busy mailbox is a fortnight and on a quiet one is three years. The window
    // is a duration so that what a customer gets does not depend on how much
    // mail they happen to send.
    expect(SWEEP_WINDOW_MONTHS).toBe(18)
    expect(sweepWindowStart(new Date('2026-09-05T10:00:00.000Z'))).toBe('2025-03-05T10:00:00.000Z')
  })

  it('clamps the day rather than rolling into the next month', () => {
    // 31 August minus 18 months is "31 February". Left to Date's own
    // arithmetic that becomes 3 March and silently shortens the window by
    // three days — small, invisible, and the kind of thing nobody would ever
    // find by looking at the output.
    expect(sweepWindowStart(new Date('2026-08-31T00:00:00.000Z'))).toBe('2025-02-28T00:00:00.000Z')
  })

  it('asks for the largest page the provider allows', () => {
    // The single biggest lever on request count. A 12,000-sent / 40,000-received
    // mailbox is 52,000 messages: 208 requests at 250 a page, 1,040 at the old
    // page size of 50. Same data, five times the API traffic.
    expect(SWEEP_PAGE_SIZE).toBe(250)
    expect(Math.ceil(52000 / SWEEP_PAGE_SIZE)).toBe(208)
  })
})

describe('reading a page defensively', () => {
  // Nobody has ever connected a real mailbox to this product — email_accounts
  // has zero rows — so every one of these shapes is a guess about a provider
  // response nobody has watched arrive. The rule is that a surprise makes the
  // sweep stop or skip, never throw: dying on page 40 of 208 leaves a customer
  // with a half-filled CRM and no explanation.
  it('finds the items wherever they are, and never returns a non-array', () => {
    expect(readItems({ items: [1, 2] })).toEqual([1, 2])
    expect(readItems({ data: { items: [3] } })).toEqual([3])
    expect(readItems({ emails: [4] })).toEqual([4])
    expect(readItems({ items: { nope: true } })).toEqual([])
    expect(readItems(null)).toEqual([])
    expect(readItems(undefined)).toEqual([])
  })

  it('only accepts a cursor that is a non-empty string', () => {
    expect(readCursor({ cursor: 'abc' })).toBe('abc')
    expect(readCursor({ next_cursor: 'def' })).toBe('def')
    expect(readCursor({ paging: { cursor: 'ghi' } })).toBe('ghi')
    // A cursor of the wrong type ends the pass cleanly. Passing an object back
    // as a query parameter would page forever over the same 250 messages.
    expect(readCursor({ cursor: { token: 'x' } })).toBeNull()
    expect(readCursor({ cursor: 42 })).toBeNull()
    expect(readCursor({ cursor: '' })).toBeNull()
    expect(readCursor(null)).toBeNull()
  })
})

describe('foldPage — counting the relationship, not the name', () => {
  it('counts each direction separately and records the span', () => {
    // This is the thing the product has never had. Measured on the production
    // account 2026-09-05: 753 contacts, ZERO with any interaction history —
    // last_contacted null on all 753. Nothing could answer "have I actually
    // spoken to this person", which is why the way-in ladder's top rung has
    // never fired for anybody.
    const map = foldPage([
      sent('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2025-06-01T09:00:00.000Z'),
      received('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2025-06-02T09:00:00.000Z'),
      sent('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2026-02-11T09:00:00.000Z'),
    ], IDENTITY)

    expect(map.get('balkhalaf@al-akaria.com')).toMatchObject({
      email: 'balkhalaf@al-akaria.com',
      name: 'Bayan AlKhalaf',
      kind: 'person',
      sent: 2,
      received: 1,
      firstAt: '2025-06-01T09:00:00.000Z',
      lastAt: '2026-02-11T09:00:00.000Z',
    })
  })

  it('never counts the robots that make up most of an inbox', () => {
    // From the measured 50-message inbox sample: 30 LinkedIn notifications, 6
    // DMARC reports, 1 bank statement. classifyAddress rejects them before
    // anything is counted, so they cannot inflate a received count and cannot
    // make a one-way blast look two-way.
    const map = foldPage([
      received('messaging-digest-noreply@linkedin.com', 'LinkedIn', '2026-01-02T09:00:00.000Z'),
      received('dmarcreport@microsoft.com', 'Microsoft', '2026-01-03T09:00:00.000Z'),
      received('communications@mail.wio.io', 'Wio', '2026-01-04T09:00:00.000Z'),
      received('outreach@vantagesearchgroup.me', 'Outreach', '2026-01-05T09:00:00.000Z'),
    ], IDENTITY)

    expect(map.size).toBe(0)
    expect(map.skipped.filtered).toBe(4)
  })

  it('does NOT let an out-of-office count as a reply', () => {
    // Hannah Wild's auto-responder arrived 40 seconds after Michael's mail. If
    // that counted as "she wrote back", every address behind a vacation
    // responder would pass the two-way test — which is exactly the one-way
    // blast the rule exists to exclude. Recorded, so the sweep can say it saw
    // it, and never credited.
    const map = foldPage([
      sent('hwild@adcouncil.ae', 'Hannah Wild', '2026-09-03T05:24:00.000Z'),
      received('hwild@adcouncil.ae', 'Hannah Wild', '2026-09-03T05:24:40.000Z', {
        subject: 'Automatic reply: Follow up to call',
      }),
    ], IDENTITY)

    const row = map.get('hwild@adcouncil.ae')
    expect(row.sent).toBe(1)
    expect(row.received).toBe(0)
    expect(row.autoReplies).toBe(1)
    expect(promotionVerdict(row)).toEqual({ promote: false, reason: 'one_way' })
  })

  it('spots an out-of-office from headers alone, with no body to read', () => {
    // The sweep is metadata-only, so detectAutoReply runs on subject and
    // headers with bodyPlain empty. A localised auto-responder ("Réponse
    // automatique" was in the subject regex already, but plenty are not) is
    // caught by Auto-Submitted instead. This is why include_headers stays on
    // for the sweep even though the body does not.
    const map = foldPage([
      sent('erwin.dioso@taqa.com', 'Erwin Dioso', '2026-03-01T09:00:00.000Z'),
      received('erwin.dioso@taqa.com', 'Erwin Dioso', '2026-03-01T09:01:00.000Z', {
        subject: 'Re: Recruitment',
        headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }],
      }),
    ], IDENTITY)

    expect(map.get('erwin.dioso@taqa.com')).toMatchObject({ sent: 1, received: 0, autoReplies: 1 })
  })

  it('does NOT let a bounce count as a reply', () => {
    // Worse than the out-of-office case. A bounce proves the message never
    // arrived, so counting it as evidence of a relationship reports something
    // that is false rather than merely unproven.
    const map = foldPage([
      sent('nobody@limad.com', 'Nobody', '2026-04-01T09:00:00.000Z'),
      received('nobody@limad.com', 'Nobody', '2026-04-01T09:00:30.000Z', {
        subject: 'Undeliverable: Re: Recruitment',
      }),
    ], IDENTITY)

    expect(map.get('nobody@limad.com')).toMatchObject({ sent: 1, received: 0, autoReplies: 1 })
  })

  it('an auto-reply does not drag the last-exchange date forward either', () => {
    const map = foldPage([
      sent('hwild@adcouncil.ae', 'Hannah Wild', '2025-05-01T09:00:00.000Z'),
      received('hwild@adcouncil.ae', 'Hannah Wild', '2026-08-01T09:00:00.000Z', {
        subject: 'Automatic reply: still away',
      }),
    ], IDENTITY)
    expect(map.get('hwild@adcouncil.ae').lastAt).toBe('2025-05-01T09:00:00.000Z')
  })

  it('steps over a malformed message instead of unwinding the sweep', () => {
    const map = foldPage([
      { id: 'broken', from_attendee: null },
      { id: 'worse', get from_attendee() { throw new Error('provider changed its mind') } },
      sent('malmakheeti@limad.com', 'Muna Almakheeti', '2026-05-01T09:00:00.000Z'),
      'not an object at all',
      null,
    ], IDENTITY)

    expect(map.size).toBe(1)
    expect(map.get('malmakheeti@limad.com').sent).toBe(1)
    expect(map.skipped.threw + map.skipped.noCounterparty).toBe(4)
  })

  it('survives a message with no usable date', () => {
    const map = foldPage([sent('malmakheeti@limad.com', 'Muna', 'the day before yesterday')], IDENTITY)
    expect(map.get('malmakheeti@limad.com')).toMatchObject({ sent: 1, firstAt: null, lastAt: null })
  })

  it('accumulates across pages, which is what makes the sweep resumable', () => {
    const acc = new Map()
    foldPage([sent('kalkhalid@jash.com.sa', 'Khalid AlKhalid', '2025-11-01T09:00:00.000Z')], IDENTITY, acc)
    foldPage([received('kalkhalid@jash.com.sa', 'Khalid AlKhalid', '2025-11-02T09:00:00.000Z')], IDENTITY, acc)
    expect(acc.get('kalkhalid@jash.com.sa')).toMatchObject({ sent: 1, received: 1 })
  })
})

describe('mergeTally', () => {
  it('sums the counts and widens the span', () => {
    // Used to merge a stored row with a fresh page. The values written back are
    // absolute, which is what lets an interrupted run re-read its last page
    // without inventing extra messages at the row level.
    const merged = mergeTally(
      { email: 'a@b.com', domain: 'b.com', name: 'A B', kind: 'person', sent: 3, received: 1, autoReplies: 2, firstAt: '2025-06-01T00:00:00.000Z', lastAt: '2025-09-01T00:00:00.000Z' },
      { email: 'a@b.com', domain: 'b.com', name: null, kind: 'person', sent: 1, received: 4, autoReplies: 0, firstAt: '2025-02-01T00:00:00.000Z', lastAt: '2026-01-01T00:00:00.000Z' },
    )
    expect(merged).toMatchObject({
      sent: 4, received: 5, autoReplies: 2,
      firstAt: '2025-02-01T00:00:00.000Z',
      lastAt: '2026-01-01T00:00:00.000Z',
      name: 'A B',
    })
  })

  it('tolerates either side being missing', () => {
    expect(mergeTally(null, { email: 'a@b.com', sent: 1 })).toMatchObject({ email: 'a@b.com', sent: 1 })
    expect(mergeTally({ email: 'a@b.com', sent: 1 }, null)).toMatchObject({ sent: 1 })
    expect(mergeTally(null, null)).toBeNull()
  })
})

describe('the promotion rule', () => {
  // THE rule. A person becomes a contact only if the conversation went both
  // ways. One-way mail is newsletters, blasts, suppliers and no-reply
  // addresses; a reply is a human being choosing to answer.
  //
  // The failure this avoids is the LinkedIn CSV import, in the customer's own
  // words: "when I did mine it looked very messy with limited organisation."
  // That was 753 rows. An 18-month sweep promoting everything it saw would be
  // the same complaint about several thousand.
  const person = (over) => ({ email: 'x@corp.com', domain: 'corp.com', kind: 'person', sent: 0, received: 0, ...over })

  it('promotes a two-way work exchange', () => {
    expect(promotionVerdict(person({ sent: 4, received: 3 }))).toEqual({ promote: true, reason: 'two_way', company: true })
  })

  it('refuses mail that only ever went one way — outbound', () => {
    // The supplier nobody ever answered, the mandate pitch that went nowhere.
    expect(promotionVerdict(person({ sent: 9, received: 0 }))).toEqual({ promote: false, reason: 'one_way' })
  })

  it('refuses mail that only ever came one way — inbound', () => {
    // The newsletter, the conference organiser, the platform that mails you
    // weekly. Nine hundred of these is what "messy with limited organisation"
    // looks like at sweep scale.
    expect(promotionVerdict(person({ sent: 0, received: 40 }))).toEqual({ promote: false, reason: 'one_way' })
  })

  it('takes a single genuine reply as proof', () => {
    // No threshold and no scoring, deliberately. The claim being made is "a
    // human chose to answer you", and one reply is that claim in full.
    expect(promotionVerdict(person({ sent: 1, received: 1 })).promote).toBe(true)
    expect(isTwoWay({ sent: 1, received: 1 })).toBe(true)
    expect(isTwoWay({ sent: 1, received: 0 })).toBe(false)
  })

  it('reads the stored column names as well as the in-memory ones', () => {
    // promotionVerdict runs both over a freshly folded page and over a row read
    // back out of email_interactions. One rule, two shapes.
    expect(isTwoWay({ messages_sent: 2, messages_received: 1 })).toBe(true)
    expect(isTwoWay({ messages_sent: 2, messages_received: 0 })).toBe(false)
  })

  it('promotes a two-way free-mail correspondent, but never gives them a company', () => {
    // Michael, 2026-09-05, settling this himself: "Becomes a contact: anyone
    // you and they both sent to each other... Corporate domain = a company
    // Annie watches. Gmail/Hotmail = no company."
    //
    // The first draft held these out of the CRM entirely. Wrong: somebody you
    // have genuinely written to and heard back from is part of your network
    // whatever address they used. What they are NOT is an employer — so they
    // are filed as a contact and carry no company, which is exactly what Annie
    // does and does not know about them.
    for (const domain of ['gmail.com', 'hotmail.co.uk', 'yahoo.com', 'outlook.com', 'icloud.com']) {
      const row = person({ email: `someone@${domain}`, domain, kind: 'personal', sent: 6, received: 6 })
      expect(promotionVerdict(row)).toEqual({ promote: true, reason: 'two_way_no_company', company: false })
    }
  })

  it('still requires a free-mail address to have written back', () => {
    // The two-way rule is the filter, and it applies to everyone. A one-way
    // blast to a personal address is as much noise as a newsletter.
    const row = person({ email: 'someone@gmail.com', domain: 'gmail.com', kind: 'personal', sent: 9, received: 0 })
    expect(promotionVerdict(row)).toEqual({ promote: false, reason: 'one_way' })
  })

  it('never promotes a company front desk', () => {
    // info@, careers@, accounts@. Real two-way mail happens with shared
    // mailboxes, and a contact called "info" still helps nobody. Matches what
    // matchContact() already does on the forward path, so the two cannot
    // disagree about the same address.
    const row = person({ email: 'info@limad.com', kind: 'role', sent: 3, received: 2 })
    expect(promotionVerdict(row)).toEqual({ promote: false, reason: 'role_address' })
  })

  it('classifies free mail as personal straight off the wire', () => {
    // End to end rather than by hand-setting kind: the fold must produce the
    // 'personal' verdict itself for the rule to be able to act on it.
    const map = foldPage([
      sent('shuaa.ms@gmail.com', 'Shuaa Al Harbi', '2026-01-01T09:00:00.000Z'),
      received('shuaa.ms@gmail.com', 'Shuaa Al Harbi', '2026-01-02T09:00:00.000Z'),
    ], IDENTITY)
    expect(promotionVerdict(map.get('shuaa.ms@gmail.com'))).toEqual({ promote: true, reason: 'two_way_no_company', company: false })
  })

  it('has nothing to say about a row with no address', () => {
    expect(promotionVerdict(null)).toEqual({ promote: false, reason: 'no_address' })
    expect(promotionVerdict({ sent: 5, received: 5 })).toEqual({ promote: false, reason: 'no_address' })
  })
})

describe('summariseSweep', () => {
  it('counts the promoted people who carry no company', () => {
    // freeMailTwoWay says how much of the filed network sits on personal
    // addresses and therefore produces no company signals — real contacts, but
    // nothing for the scan to watch.
    const stats = summariseSweep([
      { email: 'a@corp.com', kind: 'person', sent: 3, received: 2 },
      { email: 'b@corp.com', kind: 'person', sent: 1, received: 1 },
      { email: 'c@corp.com', kind: 'person', sent: 40, received: 0 },
      { email: 'd@newsletter.io', kind: 'person', sent: 0, received: 60 },
      { email: 'e@gmail.com', kind: 'personal', sent: 5, received: 5 },
      { email: 'f@gmail.com', kind: 'personal', sent: 0, received: 9 },
      { email: 'info@corp.com', kind: 'role', sent: 2, received: 2, autoReplies: 1 },
    ])

    expect(stats).toMatchObject({
      people: 7,
      promotable: 3,
      freeMailTwoWay: 1,
      roleTwoWay: 1,
      oneWay: 3,
      twoWay: 4,
      autoReplies: 1,
    })
    expect(stats.messagesSent).toBe(51)
    expect(stats.messagesReceived).toBe(79)
  })

  it('copes with an empty or junk-filled list', () => {
    expect(summariseSweep([]).people).toBe(0)
    expect(summariseSweep(null).people).toBe(0)
    expect(summariseSweep([null, undefined]).people).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The cost guarantee, enforced rather than remembered.

describe('the backfill cannot reach a model', () => {
  // The whole reason this design was chosen over the obvious one: the naive
  // 18-month sweep that read bodies and wrote a note per message worked out at
  // roughly ten thousand Anthropic calls per signup. "Zero AI tokens on the
  // backfill" is the feature, so it is asserted structurally and not left as a
  // convention somebody could break with one convenient import.
  function importClosure(entry) {
    const seen = new Set()
    const stack = [entry]
    while (stack.length) {
      const file = stack.pop()
      if (seen.has(file)) continue
      seen.add(file)
      let src
      try { src = readFileSync(file, 'utf8') } catch { continue }
      for (const m of src.matchAll(/^\s*(?:import|export)[^'"\n]*from\s+['"](\.[^'"]+)['"]/gm)) {
        const raw = resolve(dirname(file), m[1])
        stack.push(/\.jsx?$/.test(raw) ? raw : `${raw}.js`)
      }
    }
    return [...seen]
  }

  it('imports neither the note writer nor the AI token ledger, transitively', () => {
    for (const entry of ['mailboxSweep.js', 'mailboxSweepApply.js']) {
      const closure = importClosure(resolve(HERE, entry))
      expect(closure.length).toBeGreaterThan(1)          // the scan actually walked something
      expect(closure.some(f => f.endsWith('emailNote.js'))).toBe(false)
      expect(closure.some(f => f.endsWith('aiUsage.js'))).toBe(false)
      expect(closure.some(f => f.endsWith('chatWebSearch.js'))).toBe(false)
    }
  })

  it('calls nothing that could issue an HTTP request', () => {
    // Neither sweep module contains a fetch call of its own. Every request the
    // backfill makes goes through listEmails(), and listEmails() talks to
    // Unipile and to nowhere else.
    for (const entry of ['mailboxSweep.js', 'mailboxSweepApply.js']) {
      const src = readFileSync(resolve(HERE, entry), 'utf8')
      expect(src).not.toMatch(/\bfetch\s*\(/)
      expect(src).not.toMatch(/api\.anthropic\.com/)
    }
  })
})

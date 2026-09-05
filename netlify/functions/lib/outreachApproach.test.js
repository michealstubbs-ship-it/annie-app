import { describe, it, expect } from 'vitest'
import {
  recordApproach, markApproachReplied, countOtherContactsAtCompany, REPLY_WINDOW_DAYS,
} from './outreachApproach.js'

// A fake supabase with the parts these two writes actually use — including
// `.is(col, null)`, which is what "an approach nobody has answered" means in
// the query and therefore has to be real here rather than stubbed away.
function makeDb({ approaches = [], contacts = [] } = {}) {
  const db = {
    outreach_approaches: approaches.map(r => ({ ...r })),
    contacts: contacts.map(r => ({ ...r })),
  }
  let seq = 0

  function from(table) {
    const q = { rows: (db[table] || []).slice() }
    q.select = () => q
    q.eq = (col, val) => { q.rows = q.rows.filter(r => r[col] === val); return q }
    q.is = (col, val) => {
      q.rows = q.rows.filter(r => (val === null ? r[col] == null : r[col] === val))
      return q
    }
    q.limit = () => q
    q.maybeSingle = () => Promise.resolve({ data: q.rows[0] || null, error: null })
    q.single = () => Promise.resolve({ data: q.rows[0] || null, error: null })
    q.then = (res) => Promise.resolve({ data: q.rows, error: null }).then(res)

    q.insert = (row) => {
      if (table === 'outreach_approaches' && row.email_message_id) {
        const clash = db.outreach_approaches.some(r => r.email_message_id === row.email_message_id)
        if (clash) {
          return {
            select: () => ({
              single: () => Promise.resolve({
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
              }),
            }),
          }
        }
      }
      const made = { id: `${table}-${++seq}`, replied_at: null, ...row }
      db[table].push(made)
      return { select: () => ({ single: () => Promise.resolve({ data: made, error: null }) }) }
    }

    q.update = (patch) => ({
      eq: (col, val) => {
        for (const r of db[table]) if (r[col] === val) Object.assign(r, patch)
        return Promise.resolve({ error: null })
      },
    })
    return q
  }

  return { supabase: { from }, db }
}

const DAY = 24 * 60 * 60 * 1000

describe('countOtherContactsAtCompany', () => {
  it('counts by company_id and by normalised name, and excludes the recipient', () => {
    // Measured on the production account 2026-09-05: 642 companies, 1 with a
    // website. Contacts carry a free-text company far more reliably than a
    // company_id, so both routes have to work or the count is silently zero
    // for most of the CRM.
    const { supabase } = makeDb({
      contacts: [
        { id: 'k1', user_id: 'u1', company: 'Al-Akaria LLC', company_id: null },
        { id: 'k2', user_id: 'u1', company: 'Al Akaria | العقارية', company_id: null },
        { id: 'k3', user_id: 'u1', company: null, company_id: 'c-akaria' },
        { id: 'k4', user_id: 'u1', company: 'Limad', company_id: null },
        { id: 'k5', user_id: 'u2', company: 'Al Akaria', company_id: null },
      ],
    })
    return countOtherContactsAtCompany(supabase, {
      userId: 'u1', companyId: 'c-akaria', companyName: 'Al Akaria', excludeContactId: 'k1',
    }).then(n => {
      // k2 (name), k3 (id). k1 is the person being written to, k4 is another
      // company, k5 belongs to another tenant.
      expect(n).toBe(2)
    })
  })

  it('returns null, never 0, when there is nothing to match on', async () => {
    // The distinction the readout depends on: null is "we could not establish
    // this", 0 is "you knew nobody there". Collapsing them would let a failed
    // lookup be reported to the customer as a cold approach.
    const { supabase } = makeDb({ contacts: [{ id: 'k1', user_id: 'u1', company: 'Limad' }] })
    expect(await countOtherContactsAtCompany(supabase, { userId: 'u1' })).toBeNull()
    expect(await countOtherContactsAtCompany(supabase, { userId: null, companyName: 'Limad' })).toBeNull()
  })
})

describe('recordApproach', () => {
  const BASE = {
    userId: 'u1',
    signalId: 'sig-1',
    signalType: 'expansion',
    contactId: 'k-bayan',
    companyId: 'c-akaria',
    companyName: 'Al Akaria',
    toEmail: 'BAlKhalaf@Al-Akaria.com',
    subject: 'Al Akaria — hiring',
    sentAt: '2026-09-05T09:00:00.000Z',
    emailMessageId: 'ledger-1',
    threadId: 'thr-1',
  }

  function db() {
    return makeDb({
      contacts: [
        { id: 'k-bayan', user_id: 'u1', company: 'Al Akaria', company_id: 'c-akaria', seniority_band: 'c_suite' },
        { id: 'k-other', user_id: 'u1', company: 'Al Akaria', company_id: 'c-akaria', seniority_band: 'manager_plus' },
      ],
    })
  }

  it('records the lead, the contact, and what was true at the time', async () => {
    const { supabase, db: store } = db()
    const got = await recordApproach(supabase, BASE)

    expect(got.recorded).toBe(true)
    const row = store.outreach_approaches[0]
    expect(row).toMatchObject({
      user_id: 'u1',
      signal_id: 'sig-1',
      contact_id: 'k-bayan',
      company_name: 'Al Akaria',
      email_message_id: 'ledger-1',
      thread_id: 'thr-1',
      replied_at: null,
    })
    // The two snapshots. Both would drift if computed at read time: a contact
    // added next week must not rewrite what the recruiter knew last week.
    expect(row.seniority_band).toBe('c_suite')
    expect(row.known_at_company).toBe(1)
  })

  it('lowercases the address, because the reply will not match the casing', () => {
    // Real rows from the measured mailbox arrive as "Christina.Westhuizen@
    // e7group.ae" outbound and "christina.westhuizen@e7group.ae" inbound.
    // Storing what the recruiter typed would leave the approach open forever.
    const { supabase, db: store } = db()
    return recordApproach(supabase, BASE).then(() => {
      expect(store.outreach_approaches[0].to_email).toBe('balkhalaf@al-akaria.com')
    })
  })

  it('does not double-count a retried send', async () => {
    // The send endpoint is best-effort and its caller may retry. Two approach
    // rows for one message would halve the reply rate the customer is shown.
    const { supabase, db: store } = db()
    await recordApproach(supabase, BASE)
    const again = await recordApproach(supabase, BASE)
    expect(again).toMatchObject({ recorded: false, reason: 'already_recorded' })
    expect(store.outreach_approaches).toHaveLength(1)
  })

  it('still records an approach with no lead and no contact behind it', async () => {
    // A send to someone with no CRM row (a personal address — see
    // matchContact's tier three) is still an approach that was made, and
    // dropping it would under-report the denominator.
    const { supabase, db: store } = db()
    const got = await recordApproach(supabase, {
      userId: 'u1', toEmail: 'shuaa.ms@gmail.com', emailMessageId: 'ledger-9',
    })
    expect(got.recorded).toBe(true)
    expect(store.outreach_approaches[0]).toMatchObject({
      signal_id: null, contact_id: null, seniority_band: null, known_at_company: null,
    })
  })

  it('refuses to write without a recipient', async () => {
    const { supabase, db: store } = db()
    expect(await recordApproach(supabase, { userId: 'u1', toEmail: '  ' })).toMatchObject({ recorded: false })
    expect(store.outreach_approaches).toHaveLength(0)
  })
})

describe('markApproachReplied', () => {
  const SENT = '2026-09-05T09:00:00.000Z'
  const open = (over = {}) => ({
    id: 'ap-1', user_id: 'u1', to_email: 'balkhalaf@al-akaria.com',
    sent_at: SENT, thread_id: 'thr-1', replied_at: null, contact_id: 'k-bayan', signal_id: 'sig-1',
    ...over,
  })

  it('closes the approach a reply answers', async () => {
    const { supabase, db } = makeDb({ approaches: [open()] })
    const got = await markApproachReplied(supabase, {
      userId: 'u1',
      fromEmail: 'BAlKhalaf@al-akaria.com',
      repliedAt: '2026-09-05T09:20:19.000Z',
      emailMessageId: 'ledger-2',
      threadId: 'thr-1',
    })
    expect(got).toMatchObject({ matched: true, approachId: 'ap-1', basis: 'thread', signalId: 'sig-1' })
    expect(db.outreach_approaches[0].replied_at).toBe('2026-09-05T09:20:19.000Z')
    expect(db.outreach_approaches[0].reply_message_id).toBe('ledger-2')
  })

  it('never credits a reply that predates the send', async () => {
    // The mailbox backfill reads up to 600 messages each way in one sweep, in
    // no guaranteed order, so an older thread from the same person is a real
    // thing to encounter — not a hypothetical.
    const { supabase, db } = makeDb({ approaches: [open()] })
    const got = await markApproachReplied(supabase, {
      userId: 'u1', fromEmail: 'balkhalaf@al-akaria.com', repliedAt: '2026-09-01T09:00:00.000Z',
    })
    expect(got).toMatchObject({ matched: false, reason: 'no_open_approach' })
    expect(db.outreach_approaches[0].replied_at).toBeNull()
  })

  it('does not credit an unrelated message a year later', async () => {
    // Without a window an approach stays open forever, and any mail that
    // person ever sends becomes an answer to it. That is the difference
    // between "they replied" and "we heard from them at some point".
    const { supabase } = makeDb({ approaches: [open({ thread_id: null })] })
    const late = new Date(Date.parse(SENT) + (REPLY_WINDOW_DAYS + 5) * DAY).toISOString()
    expect(await markApproachReplied(supabase, {
      userId: 'u1', fromEmail: 'balkhalaf@al-akaria.com', repliedAt: late,
    })).toMatchObject({ matched: false, reason: 'no_open_approach' })
  })

  it('applies no window at all when the thread id matches', async () => {
    // A thread match is evidence, not a guess: this message is literally in
    // the conversation the approach started. Age is then irrelevant.
    const { supabase } = makeDb({ approaches: [open()] })
    const late = new Date(Date.parse(SENT) + (REPLY_WINDOW_DAYS + 200) * DAY).toISOString()
    expect(await markApproachReplied(supabase, {
      userId: 'u1', fromEmail: 'balkhalaf@al-akaria.com', repliedAt: late, threadId: 'thr-1',
    })).toMatchObject({ matched: true, basis: 'thread' })
  })

  it('closes one approach, not both, when the same person was approached twice', async () => {
    // One reply answers one attempt. Closing both would report two results
    // from one event, which is the same overclaim in a different shape.
    const { supabase, db } = makeDb({
      approaches: [
        open({ id: 'ap-old', sent_at: '2026-07-01T09:00:00.000Z', thread_id: 'thr-old' }),
        open({ id: 'ap-new', sent_at: '2026-09-05T09:00:00.000Z', thread_id: 'thr-new' }),
      ],
    })
    const got = await markApproachReplied(supabase, {
      userId: 'u1', fromEmail: 'balkhalaf@al-akaria.com', repliedAt: '2026-09-06T09:00:00.000Z',
    })
    expect(got.approachId).toBe('ap-new')     // the most recent one it could answer
    expect(db.outreach_approaches.find(r => r.id === 'ap-old').replied_at).toBeNull()
  })

  it('prefers a thread match over a more recent send', async () => {
    const { supabase } = makeDb({
      approaches: [
        open({ id: 'ap-thread', sent_at: '2026-08-20T09:00:00.000Z', thread_id: 'thr-x' }),
        open({ id: 'ap-recent', sent_at: '2026-09-05T09:00:00.000Z', thread_id: 'thr-y' }),
      ],
    })
    const got = await markApproachReplied(supabase, {
      userId: 'u1', fromEmail: 'balkhalaf@al-akaria.com',
      repliedAt: '2026-09-06T09:00:00.000Z', threadId: 'thr-x',
    })
    expect(got).toMatchObject({ matched: true, approachId: 'ap-thread', basis: 'thread' })
  })

  it('ignores an approach that has already been answered', async () => {
    const { supabase } = makeDb({ approaches: [open({ replied_at: '2026-09-05T10:00:00.000Z' })] })
    expect(await markApproachReplied(supabase, {
      userId: 'u1', fromEmail: 'balkhalaf@al-akaria.com', repliedAt: '2026-09-07T09:00:00.000Z',
    })).toMatchObject({ matched: false, reason: 'no_open_approach' })
  })

  it('never reaches across tenants', async () => {
    const { supabase, db } = makeDb({ approaches: [open({ user_id: 'u2' })] })
    expect(await markApproachReplied(supabase, {
      userId: 'u1', fromEmail: 'balkhalaf@al-akaria.com', repliedAt: '2026-09-06T09:00:00.000Z',
    })).toMatchObject({ matched: false })
    expect(db.outreach_approaches[0].replied_at).toBeNull()
  })
})

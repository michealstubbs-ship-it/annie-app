import { describe, it, expect } from 'vitest'
import {
  recordInteractions, loadPromotionQueue, promoteInteraction, runPromotions,
  sweepTotals, tallyFromRow, rowFromTally, INTERACTIONS_TABLE,
} from './mailboxSweepApply.js'
import { foldPage } from './mailboxSweep.js'
import { ownIdentity } from './emailSync.js'

// A fake Supabase with the behaviour that actually matters here: real filtered
// selects, a real unique key on (account_id, counterparty_email) behind upsert,
// and every write recorded so a test can assert what was NOT written as easily
// as what was.
function makeDb({ contacts = [], companies = [], enrichment = [], interactions = [] } = {}) {
  const db = {
    contacts: contacts.map(c => ({ ...c })),
    companies: companies.map(c => ({ ...c })),
    company_enrichment: enrichment.map(c => ({ ...c })),
    email_interactions: interactions.map(c => ({ ...c })),
    team_members: [],
  }
  let seq = 0

  function from(table) {
    const q = { rows: db[table] ? db[table].slice() : [] }
    q.select = () => q
    q.eq = (col, val) => { q.rows = q.rows.filter(r => r[col] === val); return q }
    q.is = (col, val) => {
      q.rows = q.rows.filter(r => (val === null ? r[col] == null : r[col] === val))
      return q
    }
    q.gt = (col, val) => { q.rows = q.rows.filter(r => Number(r[col] || 0) > val); return q }
    q.in = (col, vals) => { q.rows = q.rows.filter(r => vals.includes(r[col])); return q }
    q.ilike = (col, val) => {
      const n = String(val).toLowerCase()
      q.rows = q.rows.filter(r => String(r[col] ?? '').toLowerCase() === n)
      return q
    }
    q.limit = (n) => { q.rows = q.rows.slice(0, n); return q }
    q.range = (a, b) => { q.rows = q.rows.slice(a, b + 1); return q }
    q.maybeSingle = () => Promise.resolve({ data: q.rows[0] || null, error: null })
    q.single = () => Promise.resolve({ data: q.rows[0] || null, error: null })
    q.then = (res) => Promise.resolve({ data: q.rows, error: null }).then(res)

    q.insert = (row) => {
      const made = { id: `${table}-${++seq}`, ...row }
      db[table].push(made)
      return { select: () => ({ single: () => Promise.resolve({ data: made, error: null }) }) }
    }

    q.upsert = (rows) => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        const hit = db[table].find(r =>
          r.account_id === row.account_id && r.counterparty_email === row.counterparty_email)
        if (hit) Object.assign(hit, row)
        else db[table].push({ id: `${table}-${++seq}`, ...row })
      }
      return Promise.resolve({ error: null })
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

const ACCOUNT = { id: 'acct-1', user_id: 'u1', email_address: 'mstubbs@vantagesearchgroup.me' }
const IDENTITY = ownIdentity(ACCOUNT)
const CTX = { userId: 'u1', accountId: ACCOUNT.id }

function sent(to, name, at) {
  return {
    id: `s-${to}-${at}`, date: at, subject: 'Re: Recruitment',
    from_attendee: { identifier: ACCOUNT.email_address, display_name: 'Michael Stubbs' },
    to_attendees: [{ identifier: to, display_name: name }],
  }
}
function received(from, name, at) {
  return {
    id: `r-${from}-${at}`, date: at, subject: 'Re: Recruitment',
    from_attendee: { identifier: from, display_name: name },
    to_attendees: [{ identifier: ACCOUNT.email_address }],
  }
}

const row = (over = {}) => ({
  id: 'int-1',
  counterparty_email: 'balkhalaf@al-akaria.com',
  counterparty_domain: 'al-akaria.com',
  counterparty_name: 'Bayan AlKhalaf',
  kind: 'person',
  messages_sent: 4,
  messages_received: 3,
  auto_replies: 0,
  first_exchange_at: '2025-06-01T09:00:00.000Z',
  last_exchange_at: '2026-02-11T09:00:00.000Z',
  decided_at: null,
  ...over,
})

describe('row <-> tally', () => {
  it('round-trips without losing the relationship', () => {
    const back = rowFromTally(tallyFromRow(row()), CTX)
    expect(back).toMatchObject({
      user_id: 'u1',
      account_id: 'acct-1',
      counterparty_email: 'balkhalaf@al-akaria.com',
      messages_sent: 4,
      messages_received: 3,
      first_exchange_at: '2025-06-01T09:00:00.000Z',
      last_exchange_at: '2026-02-11T09:00:00.000Z',
    })
  })
})

describe('recordInteractions', () => {
  it('writes one row per person, not one per message', () => {
    // 250 messages a page collapsing to a few dozen people is the whole reason
    // this table exists separately from email_messages.
    const { supabase, db } = makeDb()
    const tallies = foldPage([
      sent('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2025-06-01T09:00:00.000Z'),
      sent('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2025-06-03T09:00:00.000Z'),
      received('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2025-06-04T09:00:00.000Z'),
      sent('malmakheeti@limad.com', 'Muna Almakheeti', '2025-07-01T09:00:00.000Z'),
    ], IDENTITY)

    return recordInteractions(supabase, { ...CTX, tallies }).then(() => {
      expect(db.email_interactions).toHaveLength(2)
      const bayan = db.email_interactions.find(r => r.counterparty_email === 'balkhalaf@al-akaria.com')
      expect(bayan).toMatchObject({ messages_sent: 2, messages_received: 1, kind: 'person' })
    })
  })

  it('merges a new page into what a previous run already stored', async () => {
    // This is what makes the sweep resumable. Run one reads the sent pass, dies
    // at the wall clock; run two reads the inbox pass and must ADD to the same
    // person rather than replace them — otherwise the two-way test could never
    // pass on a mailbox big enough to need resuming, which is every mailbox the
    // resumption exists for.
    const { supabase, db } = makeDb()
    await recordInteractions(supabase, {
      ...CTX,
      tallies: foldPage([sent('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2025-06-01T09:00:00.000Z')], IDENTITY),
    })
    await recordInteractions(supabase, {
      ...CTX,
      tallies: foldPage([received('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2026-02-11T09:00:00.000Z')], IDENTITY),
    })

    expect(db.email_interactions).toHaveLength(1)
    expect(db.email_interactions[0]).toMatchObject({
      messages_sent: 1,
      messages_received: 1,
      first_exchange_at: '2025-06-01T09:00:00.000Z',
      last_exchange_at: '2026-02-11T09:00:00.000Z',
    })
  })

  it('does nothing at all for an empty page', async () => {
    const { supabase, db } = makeDb()
    const got = await recordInteractions(supabase, { ...CTX, tallies: new Map() })
    expect(got.written).toBe(0)
    expect(db.email_interactions).toHaveLength(0)
  })

  it('reports a read failure instead of writing half a page', async () => {
    // The caller uses this to hold the cursor back, so the page is re-read next
    // run rather than the people in it being silently skipped.
    const broken = { from: () => ({ select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'relation does not exist' } }) }) }) }) }
    const got = await recordInteractions(broken, {
      ...CTX,
      tallies: foldPage([sent('a@corp.com', 'A', '2026-01-01T09:00:00.000Z')], IDENTITY),
    })
    expect(got.written).toBe(0)
    expect(got.error).toBeTruthy()
  })
})

describe('loadPromotionQueue', () => {
  it('asks only for undecided rows that now pass the two-way test', async () => {
    // The filter is in the query because the one-way majority is the bulk of
    // the table. On a 52,000-message mailbox that is most of several thousand
    // rows that never need to cross the wire.
    const { supabase } = makeDb({
      interactions: [
        row({ id: 'a', account_id: 'acct-1' }),
        row({ id: 'b', account_id: 'acct-1', counterparty_email: 'one@way.com', messages_received: 0 }),
        row({ id: 'c', account_id: 'acct-1', counterparty_email: 'in@only.com', messages_sent: 0 }),
        row({ id: 'd', account_id: 'acct-1', counterparty_email: 'done@corp.com', decided_at: '2026-09-05T00:00:00.000Z' }),
        row({ id: 'e', account_id: 'other-acct', counterparty_email: 'someone@else.com' }),
      ],
    })
    const { rows } = await loadPromotionQueue(supabase, { accountId: 'acct-1' })
    expect(rows.map(r => r.id)).toEqual(['a'])
  })
})

describe('promoteInteraction', () => {
  it('creates the contact and stores the relationship, not just the name', async () => {
    // Measured on production 2026-09-05: zero of 753 contacts had any
    // interaction history, which is why deriveRelationshipTier's 'client' rung
    // ("proven two-way history") had never fired for anybody. This is the first
    // write in the codebase that can honestly pass hasTwoWayHistory: true.
    const { supabase, db } = makeDb({ enrichment: [{ domain: 'al-akaria.com', company_name: 'Al Akaria' }] })
    const got = await promoteInteraction(supabase, { userId: 'u1', row: row() })

    expect(got).toMatchObject({ promoted: true, outcome: 'created' })
    expect(db.contacts).toHaveLength(1)
    expect(db.contacts[0]).toMatchObject({
      email: 'balkhalaf@al-akaria.com',
      company: 'Al Akaria',
      relationship_tier: 'client',
      messages_sent: 4,
      messages_received: 3,
      first_exchange_at: '2025-06-01T09:00:00.000Z',
      last_exchange_at: '2026-02-11T09:00:00.000Z',
      last_contacted: '2026-02-11T09:00:00.000Z',
    })
  })

  it('enriches the row the LinkedIn import already made, rather than duplicating it', async () => {
    // The single most important thing this pass must not get wrong. The CRM it
    // runs against has already been filled by a CSV import — 753 rows on the
    // measured account — and a second row for someone already imported is
    // precisely the mess that import was criticised for: "when I did mine it
    // looked very messy with limited organisation."
    const { supabase, db } = makeDb({
      enrichment: [{ domain: 'al-akaria.com', company_name: 'Al Akaria' }],
      contacts: [{
        id: 'k-bayan', user_id: 'u1', name: 'Bayan AlKhalaf',
        email: 'balkhalaf@al-akaria.com', company: 'Al Akaria',
        relationship_tier: 'contact', tags: ['linkedin-import'],
      }],
    })
    const got = await promoteInteraction(supabase, { userId: 'u1', row: row() })

    expect(got).toMatchObject({ promoted: true, outcome: 'matched_email', contactId: 'k-bayan' })
    expect(db.contacts).toHaveLength(1)
    expect(db.contacts[0]).toMatchObject({
      tags: ['linkedin-import'],            // their row, enriched — not replaced
      relationship_tier: 'client',
      messages_received: 3,
    })
  })

  it('matches on name and company when the imported row has no email', async () => {
    // Tier two of matchContact. 735 of the 753 imported contacts had no email
    // address at all, so email-only dedupe would have created a duplicate for
    // almost every person the mailbox knows.
    const { supabase, db } = makeDb({
      enrichment: [{ domain: 'al-akaria.com', company_name: 'Al Akaria' }],
      contacts: [{
        id: 'k-bayan', user_id: 'u1', name: 'Bayan AlKhalaf',
        email: null, company: 'Al Akaria', relationship_tier: 'connection',
      }],
    })
    const got = await promoteInteraction(supabase, { userId: 'u1', row: row() })

    expect(got).toMatchObject({ promoted: true, outcome: 'matched_name', contactId: 'k-bayan' })
    expect(db.contacts).toHaveLength(1)
    expect(db.contacts[0].relationship_tier).toBe('client')
  })

  it('never drags last_contacted backwards', async () => {
    // The sweep reaches 18 months back. A contact the recruiter spoke to last
    // week must not be re-dated to an exchange from last year: the backlog
    // ranking reads last_contacted, so that would make a live relationship look
    // dormant and quietly bury it.
    const { supabase, db } = makeDb({
      contacts: [{
        id: 'k-bayan', user_id: 'u1', name: 'Bayan AlKhalaf',
        email: 'balkhalaf@al-akaria.com', company: 'Al Akaria',
        last_contacted: '2026-09-01T00:00:00.000Z',
      }],
    })
    await promoteInteraction(supabase, { userId: 'u1', row: row() })
    expect(db.contacts[0].last_contacted).toBe('2026-09-01T00:00:00.000Z')
    expect(db.contacts[0].last_exchange_at).toBe('2026-02-11T09:00:00.000Z')
  })

  it('files a two-way free-mail correspondent as a contact with no company', async () => {
    // Michael, 2026-09-05: "Corporate domain = a company Annie watches.
    // Gmail/Hotmail = no company." They are a real contact — you wrote to each
    // other — but gmail.com is not an employer, and inventing one would put it
    // into the watchlist for the scan to go looking for leadership changes at.
    const { supabase, db } = makeDb()
    const got = await promoteInteraction(supabase, {
      userId: 'u1',
      row: row({ counterparty_email: 'shuaa.ms@gmail.com', counterparty_domain: 'gmail.com', kind: 'personal' }),
    })

    expect(got).toMatchObject({ promoted: true })
    expect(db.contacts).toHaveLength(1)
    expect(db.contacts[0].company).toBeFalsy()
    expect(db.contacts[0].company_id).toBeFalsy()
    expect(db.companies).toHaveLength(0)
  })

  it('holds a two-way company front desk', async () => {
    const { supabase, db } = makeDb()
    const got = await promoteInteraction(supabase, {
      userId: 'u1',
      row: row({ counterparty_email: 'info@limad.com', counterparty_domain: 'limad.com', kind: 'role' }),
    })
    expect(got).toMatchObject({ promoted: false, outcome: 'role_address' })
    expect(db.contacts).toHaveLength(0)
  })

  it('refuses a one-way row even if something hands it one directly', async () => {
    // Defence in depth: loadPromotionQueue already filters these out, and the
    // rule is checked again here so no future caller can route round it.
    const { supabase, db } = makeDb()
    const got = await promoteInteraction(supabase, {
      userId: 'u1',
      row: row({ messages_received: 0 }),
    })
    expect(got).toMatchObject({ promoted: false, outcome: 'one_way' })
    expect(db.contacts).toHaveLength(0)
  })

  it('sums the history when one person is reached at two addresses', async () => {
    // A work address and a later alias can both match the same contact on name
    // + company. Overwriting would erase the first address's history; the
    // second one widens the span and adds to the counts instead.
    const { supabase, db } = makeDb({
      enrichment: [{ domain: 'al-akaria.com', company_name: 'Al Akaria' }],
      contacts: [{
        id: 'k-bayan', user_id: 'u1', name: 'Bayan AlKhalaf',
        email: 'balkhalaf@al-akaria.com', company: 'Al Akaria',
      }],
    })
    await promoteInteraction(supabase, { userId: 'u1', row: row() })
    await promoteInteraction(supabase, {
      userId: 'u1',
      row: row({
        id: 'int-2', counterparty_email: 'b.alkhalaf@al-akaria.com',
        messages_sent: 1, messages_received: 2,
        first_exchange_at: '2025-01-05T09:00:00.000Z',
        last_exchange_at: '2025-03-05T09:00:00.000Z',
      }),
    })

    expect(db.contacts).toHaveLength(1)
    expect(db.contacts[0]).toMatchObject({
      messages_sent: 5,
      messages_received: 5,
      first_exchange_at: '2025-01-05T09:00:00.000Z',
      last_exchange_at: '2026-02-11T09:00:00.000Z',
    })
  })
})

describe('runPromotions', () => {
  it('works the queue and reports what it chose not to do', async () => {
    const { supabase, db } = makeDb({
      enrichment: [{ domain: 'al-akaria.com', company_name: 'Al Akaria' }],
      interactions: [
        row({ id: 'a', account_id: 'acct-1' }),
        row({ id: 'b', account_id: 'acct-1', counterparty_email: 'muna@limad.com', counterparty_domain: 'limad.com', counterparty_name: 'Muna Almakheeti' }),
        row({ id: 'c', account_id: 'acct-1', counterparty_email: 'shuaa.ms@gmail.com', counterparty_domain: 'gmail.com', kind: 'personal' }),
        row({ id: 'd', account_id: 'acct-1', counterparty_email: 'info@limad.com', counterparty_domain: 'limad.com', kind: 'role' }),
        row({ id: 'e', account_id: 'acct-1', counterparty_email: 'news@substack.com', counterparty_domain: 'substack.com', messages_sent: 0 }),
      ],
    })

    const got = await runPromotions(supabase, { userId: 'u1', account: ACCOUNT })

    expect(got).toMatchObject({ promoted: 3, created: 3, heldFreeMail: 0, heldRole: 1, outOfTime: false })
    // The free-mail correspondent is filed like anyone else who wrote back.
    expect(db.contacts.map(c => c.email).sort()).toEqual(['balkhalaf@al-akaria.com', 'muna@limad.com', 'shuaa.ms@gmail.com'])
    // ...but carries no employer. gmail.com is not where she works, and a
    // company invented here would go into the watchlist for the scan to search.
    expect(db.contacts.find(c => c.email === 'shuaa.ms@gmail.com').company).toBeFalsy()
    expect(db.companies.map(c => c.name)).not.toContain('gmail.com')
    // The one-way newsletter is never even looked at, and is still on record.
    expect(db.email_interactions.find(r => r.id === 'e').decided_at).toBeNull()
    // The front desk is still held — a contact called "info" helps nobody.
    expect(db.email_interactions.find(r => r.id === 'd')).toMatchObject({ promotion_outcome: 'role_address', contact_id: null })
  })

  it('stops on the deadline and leaves the rest undecided for the next run', async () => {
    // A 15-minute background function on a big mailbox. Stopping is a normal
    // outcome: decided_at is per row, so the next invocation picks up exactly
    // where this one stopped without redoing any of it.
    const { supabase, db } = makeDb({
      interactions: [row({ id: 'a', account_id: 'acct-1' })],
    })
    const got = await runPromotions(supabase, { userId: 'u1', account: ACCOUNT, deadlineAt: Date.now() - 1 })
    expect(got.outOfTime).toBe(true)
    expect(got.promoted).toBe(0)
    expect(db.contacts).toHaveLength(0)
    expect(db.email_interactions[0].decided_at).toBeNull()
  })

  it('one exploding row does not stop the pass', async () => {
    const { supabase, db } = makeDb({
      interactions: [
        row({ id: 'a', account_id: 'acct-1', counterparty_email: 'boom@corp.com', counterparty_domain: 'corp.com' }),
        row({ id: 'b', account_id: 'acct-1', counterparty_email: 'muna@limad.com', counterparty_domain: 'limad.com' }),
      ],
    })
    const guarded = {
      from: (table) => {
        if (table === 'company_enrichment') {
          const q = supabase.from(table)
          const original = q.eq
          q.eq = (col, val) => {
            if (val === 'corp.com') throw new Error('company_enrichment is on fire')
            return original(col, val)
          }
          return q
        }
        return supabase.from(table)
      },
    }
    const got = await runPromotions(guarded, { userId: 'u1', account: ACCOUNT })
    expect(got.failed).toBe(1)
    expect(got.promoted).toBe(1)
    expect(db.contacts.map(c => c.email)).toEqual(['muna@limad.com'])
  })
})

describe('sweepTotals', () => {
  it('counts the whole sweep off storage, not off the current run', async () => {
    // A sweep can span several invocations. A total accumulated in memory would
    // be wrong on every mailbox large enough to need resuming — which is the
    // only kind of mailbox the resumption exists for.
    const { supabase } = makeDb({
      interactions: [
        row({ id: 'a', account_id: 'acct-1' }),
        row({ id: 'b', account_id: 'acct-1', counterparty_email: 'g@gmail.com', kind: 'personal' }),
        row({ id: 'c', account_id: 'acct-1', counterparty_email: 'n@news.io', messages_sent: 0, messages_received: 30 }),
        row({ id: 'd', account_id: 'other', counterparty_email: 'x@y.com' }),
      ],
    })
    const stats = await sweepTotals(supabase, { accountId: 'acct-1' })
    // Both two-way people are promotable now; freeMailTwoWay says how many of
    // them carry no company and so produce no company signals.
    expect(stats).toMatchObject({ people: 3, promotable: 2, freeMailTwoWay: 1, oneWay: 1 })
  })
})

describe('the table it writes to', () => {
  it('is email_interactions, and it is not the message ledger', () => {
    // email_messages is one row per MESSAGE and only holds what the forward
    // path ingested. The sweep needs one row per PERSON accumulated across up
    // to 52,000 messages, with the two directions counted apart — which is the
    // only shape the two-way rule can be evaluated against.
    expect(INTERACTIONS_TABLE).toBe('email_interactions')
  })
})

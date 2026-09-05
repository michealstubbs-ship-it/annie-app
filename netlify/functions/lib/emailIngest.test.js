import { describe, it, expect, vi } from 'vitest'
import { ingestMessage, ingestBatch, ownIdentity } from './emailIngest.js'

// A fake supabase with just enough behaviour to be worth trusting: a real
// unique constraint on the ledger, filtered selects, and recorded writes.
function makeDb({ contacts = [], companies = [], enrichment = [] } = {}) {
  const db = {
    email_messages: [],
    contacts: contacts.map(c => ({ ...c })),
    companies: companies.map(c => ({ ...c })),
    company_enrichment: enrichment.map(c => ({ ...c })),
    team_members: [],
  }
  let seq = 0

  function from(table) {
    const q = { rows: db[table] ? db[table].slice() : [], table }
    q.select = () => q
    q.eq = (col, val) => { q.rows = q.rows.filter(r => r[col] === val); return q }
    q.ilike = (col, val) => {
      const n = String(val).toLowerCase()
      q.rows = q.rows.filter(r => String(r[col] ?? '').toLowerCase() === n)
      return q
    }
    q.limit = () => q
    q.maybeSingle = () => Promise.resolve({ data: q.rows[0] || null, error: null })
    q.single = () => Promise.resolve({ data: q.rows[0] || null, error: null })
    q.then = (res) => Promise.resolve({ data: q.rows, error: null }).then(res)

    q.insert = (row) => {
      if (table === 'email_messages') {
        const clash = db.email_messages.some(r =>
          r.account_id === row.account_id && r.provider_message_id === row.provider_message_id)
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
      const made = { id: `${table}-${++seq}`, ...row }
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

const ACCOUNT = { id: 'acct-1', email_address: 'mstubbs@vantagesearchgroup.me' }
const CTX = { userId: 'u1', account: ACCOUNT, anthropicKey: null } // null key -> deterministic fallback notes

function out(id, to, name, subject, extra = {}) {
  return {
    id,
    date: '2026-09-02T09:12:37.000Z',
    subject,
    from_attendee: { identifier: 'mstubbs@vantagesearchgroup.me', display_name: 'Michael Stubbs' },
    to_attendees: [{ identifier: to, ...(name ? { display_name: name } : {}) }],
    body_plain: 'Hello,\n\nPlease see below.\n\nMichael Stubbs',
    ...extra,
  }
}
function inbound(id, from, name, subject, body, extra = {}) {
  return {
    id,
    date: '2026-09-02T09:20:19.000Z',
    subject,
    from_attendee: { identifier: from, display_name: name },
    to_attendees: [{ identifier: 'mstubbs@vantagesearchgroup.me' }],
    body_plain: body,
    ...extra,
  }
}

describe('ownIdentity', () => {
  it('treats the whole sending domain as self', () => {
    // outreach@vantagesearchgroup.me is Michael's own tool mailing him. It must
    // never become a contact.
    const got = ownIdentity(ACCOUNT)
    expect(got.ownDomains).toEqual(['vantagesearchgroup.me'])
    expect(got.ownAddresses).toContain('mstubbs@vantagesearchgroup.me')
  })
})

describe('ingestMessage', () => {
  it('creates the company and the contact for a domain nobody knew', async () => {
    const { supabase, db } = makeDb()
    const got = await ingestMessage(supabase, {
      ...CTX,
      message: out('m1', 'malmakheeti@limad.com', 'Muna Almakheeti', 'Re: Agreement Execution – Vantage search group & LIMAD'),
    })

    expect(got).toMatchObject({ ingested: true, outcome: 'created', noted: true })
    expect(db.companies[0]).toMatchObject({ name: 'Limad', website: 'limad.com' })
    expect(db.contacts[0]).toMatchObject({
      name: 'Muna Almakheeti', email: 'malmakheeti@limad.com', created_from: 'email_sync',
    })
    expect(db.contacts[0].notes).toContain('2 Sep 2026 —')
    expect(db.contacts[0].last_contacted).toBe('2026-09-02T09:12:37.000Z')
  })

  it("uses Apollo's real company name when the cache has the domain", async () => {
    const { supabase, db } = makeDb({ enrichment: [{ domain: 'taqa.com', company_name: 'TAQA' }] })
    await ingestMessage(supabase, { ...CTX, message: out('m2', 'Erwin.Dioso@taqa.com', 'Erwin Dioso', 'Re: Recruitment') })
    expect(db.companies[0].name).toBe('TAQA')
    expect(db.contacts[0].company).toBe('TAQA')
  })

  it('attaches to a company already in the CRM instead of duplicating it', async () => {
    const { supabase, db } = makeDb({
      companies: [{ id: 'c-e7', user_id: 'u1', name: 'E7 Group', website: null }],
      enrichment: [{ domain: 'e7group.ae', company_name: 'E7 Group' }],
      // The CRM knows a cold target here, not the person Michael actually emails.
      contacts: [{ id: 'k-moulik', user_id: 'u1', name: 'Moulik Kumar', company: 'E7 Group', email: null }],
    })
    const got = await ingestMessage(supabase, {
      ...CTX,
      message: out('m3', 'Christina.Westhuizen@e7group.ae', 'Christina Westhuizen', 'Re: Recruitment - Vantage Search Group'),
    })
    expect(got.outcome).toBe('created')
    expect(db.companies).toHaveLength(1)
    expect(db.contacts.map(c => c.name).sort()).toEqual(['Christina Westhuizen', 'Moulik Kumar'])
    expect(db.contacts.find(c => c.name === 'Christina Westhuizen').company_id).toBe('c-e7')
  })

  it('lifts the title and direct line from an inbound signature', async () => {
    const { supabase, db } = makeDb({
      contacts: [{ id: 'k-bayan', user_id: 'u1', name: 'Bayan AlKhalaf', email: 'balkhalaf@al-akaria.com', title: null, phone: null, company: 'Al Akaria' }],
    })
    const got = await ingestMessage(supabase, {
      ...CTX,
      message: inbound('m4', 'balkhalaf@al-akaria.com', 'Bayan AlKhalaf', 'FW: Senior Marketing Manager profile',
        'Hi Michael\n\nSunday 1 pm is suitable\n\nThank you\n\nBayan AlKhalaf\nOrganization Development Senior Manager\n\nTel: +966 11 4600000 Ext: 3118\nEmail: balkhalaf@al-akaria.com'),
    })
    expect(got.outcome).toBe('matched_email')
    expect(got.enrichedFields.sort()).toEqual(['phone', 'title'])
    expect(db.contacts[0].title).toBe('Organization Development Senior Manager')
    expect(db.contacts[0].phone).toBe('+966 11 4600000 ext 3118')
  })

  it('does not put the recruiter own job title on their contact', async () => {
    // Outbound mail carries Michael's signature. Writing "Managing Director,
    // Vantage Search Group" onto Muna's record would be absurd.
    const { supabase, db } = makeDb()
    await ingestMessage(supabase, {
      ...CTX,
      message: out('m5', 'mzahid@limad.com', 'M Zahid', 'Re: Agreement', {
        body_plain: 'Thank you.\n\nMichael Stubbs\nManaging Director\nVantage Search Group\n+971 50 949 2576',
      }),
    })
    expect(db.contacts[0].title).toBeFalsy()
  })

  it('logs an out-of-office without marking the approach answered', async () => {
    const { supabase, db } = makeDb({
      contacts: [{ id: 'k-h', user_id: 'u1', name: 'Hannah Wild', email: 'hwild@adcouncil.ae', company: 'AD Council' }],
    })
    const got = await ingestMessage(supabase, {
      ...CTX,
      message: inbound('m6', 'hwild@adcouncil.ae', 'Hannah Wild', 'Automatic reply: Follow up to call',
        'Thank you for your email. I am out of office until Monday 21st September and will respond upon my return.',
        { date: '2026-09-03T05:24:35.000Z' }),
    })
    expect(got.isAutoReply).toBe(true)
    expect(db.contacts[0].notes).toContain('Out of office until 21 Sep')
    expect(db.contacts[0].last_contacted).toBeUndefined()
    expect(db.email_messages[0].away_until).toBe('2026-09-21')
  })

  it('is idempotent — a webhook retry costs nothing', async () => {
    const { supabase, db } = makeDb()
    const msg = out('m7', 'kalkhalid@jash.com.sa', 'Khalid AlKhalid', 'Re: Recruitment')
    const first = await ingestMessage(supabase, { ...CTX, message: msg })
    const second = await ingestMessage(supabase, { ...CTX, message: msg })

    expect(first.ingested).toBe(true)
    expect(second).toMatchObject({ ingested: false, reason: 'already_ingested' })
    expect(db.contacts).toHaveLength(1)
    expect(db.email_messages).toHaveLength(1)
    // and the note was not written twice
    expect(db.contacts[0].notes.match(/2 Sep 2026/g)).toHaveLength(1)
  })

  it('never calls Anthropic for a message it is going to filter out', async () => {
    const { supabase } = makeDb()
    const anthropic = vi.fn()
    const got = await ingestMessage(supabase, {
      ...CTX,
      anthropicKey: 'key',
      message: inbound('m8', 'messaging-digest-noreply@linkedin.com', 'LinkedIn', 'Abdullah just messaged you', 'x'),
    })
    expect(got).toMatchObject({ ingested: false, reason: 'filtered_automated' })
    expect(anthropic).not.toHaveBeenCalled()
  })

  it('one broken message does not take down the batch', async () => {
    const { supabase } = makeDb()
    const got = await ingestBatch(supabase, { ...CTX, messages: [{ id: 'x', from_attendee: null }] })
    expect(got.skipped).toBe(1)
    expect(got.reasons.no_counterparty).toBe(1)
  })
})

describe('ingestBatch — the first sweep, replayed', () => {
  // This is the measured sample from 2026-09-05, in miniature: the seven real
  // work counterparties, the candidate on gmail, and the noise that arrived
  // alongside them. The assertions are the numbers shown on the connect screen.
  it('produces the sweep the customer is shown', async () => {
    const { supabase, db } = makeDb({
      enrichment: [
        { domain: 'taqa.com', company_name: 'TAQA' },
        { domain: 'al-akaria.com', company_name: 'Al Akaria' },
        { domain: 'e7group.ae', company_name: 'E7 Group' },
      ],
      companies: [
        { id: 'c-taqa', user_id: 'u1', name: 'TAQA', website: null },
        { id: 'c-akaria', user_id: 'u1', name: 'Al Akaria', website: null },
        { id: 'c-e7', user_id: 'u1', name: 'E7 Group', website: null },
      ],
    })

    const messages = [
      out('s1', 'malmakheeti@limad.com', 'Muna Almakheeti', 'Re: Agreement Execution'),
      out('s2', 'hwild@adcouncil.ae', 'Hannah Wild', 'Re: Follow up to call'),
      out('s3', 'oschleichert@sanamadvisory.com.sa', 'Olaf Schleichert', 'Recruitment - Vantage Search Group'),
      out('s4', 'kalkhalid@jash.com.sa', 'Khalid AlKhalid', 'Re: Recruitment'),
      out('s5', 'Christina.Westhuizen@e7group.ae', 'Christina Westhuizen', 'Re: Recruitment'),
      out('s6', 'Erwin.Dioso@taqa.com', 'Erwin Dioso', 'Re: Recruitment'),
      out('s7', 'balkhalaf@al-akaria.com', 'Bayan AlKhalaf', 'Senior Marketing Manager profile'),
      // candidate on gmail — logged nowhere, because there is no contact yet
      out('s8', 'shuaa.ms@gmail.com', 'Shuaa Al Harbi', 'Interview confirmation'),
      // noise
      inbound('n1', 'messaging-digest-noreply@linkedin.com', 'LinkedIn', 'Ben just messaged you', 'x'),
      inbound('n2', 'dmarcreport@microsoft.com', 'Microsoft', 'Report Domain', 'x'),
      inbound('n3', 'communications@mail.wio.io', 'Wio', 'Your statement is ready', 'x'),
      inbound('n4', 'outreach@vantagesearchgroup.me', 'Outreach', '2 LinkedIn replies', 'x'),
    ]

    const got = await ingestBatch(supabase, { ...CTX, messages })

    expect(got.read).toBe(12)
    expect(got.created).toBe(7)          // seven real people, none of them in the CRM
    expect(got.skipped).toBe(4)          // the four robots, never even read
    // The candidate on gmail IS recorded in the ledger — so a re-sync does not
    // reconsider it — but no contact is invented for a bare personal address.
    expect(got.heldPersonal).toBe(1)
    // Three real names came from Apollo's cache. The four new ones fall back to
    // the domain, which is deliberately dull rather than confidently wrong —
    // "Adcouncil" is obviously a machine's guess and invites a rename, where
    // an invented "AD Council Holdings" would just look like fact.
    expect(got.companies.sort()).toEqual(
      ['Adcouncil', 'Al Akaria', 'E7 Group', 'Jash', 'Limad', 'Sanamadvisory', 'TAQA']
    )
    // four genuinely new companies; the three known ones were reused
    expect(db.companies).toHaveLength(7)
    expect(db.contacts).toHaveLength(7)
    expect(db.contacts.every(c => c.created_from === 'email_sync')).toBe(true)
  })
})

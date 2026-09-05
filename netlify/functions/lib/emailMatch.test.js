import { describe, it, expect } from 'vitest'
import {
  normaliseName, normaliseCompany, domainRoot, companyNameFromDomain,
  resolveCompanyName, ensureCompany, matchContact, applySignature, appendContactNote,
} from './emailMatch.js'

// A small stand-in for supabase-js that records what was written. Real company
// and contact rows below are taken from the production account on 2026-09-05.
function makeSupabase({ contacts = [], companies = [], enrichment = [], team = null } = {}) {
  const writes = { contacts: [], companies: [], updates: [] }

  function table(name) {
    const rows =
      name === 'contacts' ? contacts :
      name === 'companies' ? companies :
      name === 'company_enrichment' ? enrichment :
      name === 'team_members' ? (team ? [team] : []) : []

    const q = { _rows: rows.slice(), _table: name }
    q.select = () => q
    q.eq = (col, val) => { q._rows = q._rows.filter(r => r[col] === val); return q }
    q.ilike = (col, val) => {
      const needle = String(val).toLowerCase()
      q._rows = q._rows.filter(r => String(r[col] ?? '').toLowerCase() === needle)
      return q
    }
    q.limit = () => q
    q.maybeSingle = () => Promise.resolve({ data: q._rows[0] || null, error: null })
    q.single = () => Promise.resolve({ data: q._rows[0] || null, error: null })
    q.then = (res) => Promise.resolve({ data: q._rows, error: null }).then(res)

    q.insert = (row) => {
      const made = { id: `new-${name}-${writes[name].length + 1}`, ...row }
      writes[name].push(row)
      rows.push(made)
      return { select: () => ({ single: () => Promise.resolve({ data: made, error: null }) }) }
    }
    q.update = (patch) => ({
      eq: (col, val) => {
        writes.updates.push({ table: name, patch, [col]: val })
        return Promise.resolve({ error: null })
      },
    })
    return q
  }

  return { from: table, __writes: writes }
}

describe('normaliseName', () => {
  it('ignores honorifics and punctuation', () => {
    expect(normaliseName('Dr.Abdalla Sulaiman Alhammadi')).toBe('abdalla sulaiman alhammadi')
    expect(normaliseName('Bayan  AlKhalaf ')).toBe('bayan alkhalaf')
  })
})

describe('normaliseCompany', () => {
  it('reduces the real shapes in the CRM to one key', () => {
    // These are genuine company strings from the production account.
    expect(normaliseCompany('Al Akaria | العقارية')).toBe('al akaria')
    expect(normaliseCompany('E7 Group')).toBe('e7')
    expect(normaliseCompany('Vantage Search Group ME DWC-LLC')).toBe('vantage search me')
  })
  it('does not collapse two genuinely different companies', () => {
    expect(normaliseCompany('TAQA Distribution')).not.toBe(normaliseCompany('TAQA Water Solutions'))
  })
})

describe('domainRoot / companyNameFromDomain', () => {
  it('handles the real domains from the sent folder', () => {
    expect(domainRoot('e7group.ae')).toBe('e7group')
    expect(domainRoot('sanamadvisory.com.sa')).toBe('sanamadvisory')
    expect(domainRoot('jash.com.sa')).toBe('jash')
    expect(domainRoot('al-akaria.com')).toBe('al-akaria')
    expect(domainRoot('www.limad.com')).toBe('limad')
  })
  it('produces a dull, readable fallback name', () => {
    expect(companyNameFromDomain('limad.com')).toBe('Limad')
    expect(companyNameFromDomain('al-akaria.com')).toBe('Al Akaria')
    expect(companyNameFromDomain('jash.com.sa')).toBe('Jash')
  })
})

describe('resolveCompanyName', () => {
  it("prefers Apollo's real name over the domain", async () => {
    const sb = makeSupabase({ enrichment: [{ domain: 'taqa.com', company_name: 'TAQA' }] })
    expect(await resolveCompanyName(sb, 'taqa.com')).toEqual({ name: 'TAQA', source: 'enrichment' })
  })
  it('falls back to the domain when nothing knows it', async () => {
    const sb = makeSupabase()
    expect(await resolveCompanyName(sb, 'limad.com')).toEqual({ name: 'Limad', source: 'domain' })
  })
})

describe('ensureCompany', () => {
  it('reuses the existing row despite a different written form', async () => {
    const sb = makeSupabase({ companies: [{ id: 'c1', user_id: 'u1', name: 'Al Akaria | العقارية', website: null }] })
    const got = await ensureCompany(sb, { userId: 'u1', companyName: 'Al-Akaria', domain: 'al-akaria.com' })
    expect(got).toMatchObject({ id: 'c1', created: false })
    // and learns the website, which 641 of 642 rows are missing
    expect(sb.__writes.updates).toContainEqual({ table: 'companies', patch: { website: 'al-akaria.com' }, id: 'c1' })
  })

  it('creates the four companies the mailbox knew about and the CRM did not', async () => {
    for (const [name, domain] of [
      ["L'IMAD", 'limad.com'], ['AD Council', 'adcouncil.ae'],
      ['Sanam Advisory', 'sanamadvisory.com.sa'], ['JASH', 'jash.com.sa'],
    ]) {
      const sb = makeSupabase({ companies: [] })
      const got = await ensureCompany(sb, { userId: 'u1', companyName: name, domain })
      expect(got.created, name).toBe(true)
      expect(sb.__writes.companies[0]).toMatchObject({ name, website: domain, user_id: 'u1' })
    }
  })

  it('stamps the active team so a team user does not get a stranded personal row', async () => {
    const sb = makeSupabase({ team: { team_id: 't9', user_id: 'u1', status: 'active' } })
    await ensureCompany(sb, { userId: 'u1', companyName: 'JASH', domain: 'jash.com.sa' })
    expect(sb.__writes.companies[0].team_id).toBe('t9')
  })
})

describe('matchContact', () => {
  const base = { userId: 'u1', domain: 'al-akaria.com', companyName: 'Al Akaria' }

  it('tier one: matches on the address', async () => {
    const sb = makeSupabase({
      contacts: [{ id: 'k1', user_id: 'u1', name: 'Someone Else', email: 'balkhalaf@al-akaria.com', company: 'Al Akaria' }],
    })
    const got = await matchContact(sb, { ...base, email: 'balkhalaf@al-akaria.com', name: 'Bayan AlKhalaf' })
    expect(got).toMatchObject({ contactId: 'k1', outcome: 'matched_email' })
  })

  it('tier two: same name AND same company', async () => {
    const sb = makeSupabase({
      contacts: [{ id: 'k2', user_id: 'u1', name: 'Bayan AlKhalaf', email: null, company: 'Al-Akaria LLC' }],
    })
    const got = await matchContact(sb, { ...base, email: 'balkhalaf@al-akaria.com', name: 'Bayan AlKhalaf' })
    expect(got).toMatchObject({ contactId: 'k2', outcome: 'matched_name' })
  })

  it('will not merge the same name at a different company', async () => {
    // The failure this whole file exists to prevent. A silent merge here fuses
    // two people's histories and nobody ever finds out.
    const sb = makeSupabase({
      contacts: [{ id: 'k3', user_id: 'u1', name: 'Michael Lebhar', email: null, company: 'TAQA Distribution' }],
    })
    const got = await matchContact(sb, {
      userId: 'u1', email: 'michael.lebhar@adnoc.ae', name: 'Michael Lebhar',
      domain: 'adnoc.ae', companyName: 'ADNOC',
    })
    expect(got.outcome).toBe('created')
    expect(got.contactId).not.toBe('k3')
  })

  it('will not merge on a first name alone', async () => {
    const sb = makeSupabase({ contacts: [{ id: 'k4', user_id: 'u1', name: 'Muna', email: null, company: 'Limad' }] })
    const got = await matchContact(sb, {
      userId: 'u1', email: 'malmakheeti@limad.com', name: 'Muna', domain: 'limad.com', companyName: 'Limad',
    })
    expect(got.outcome).toBe('created')
  })

  it('tier three: creates, and marks where it came from', async () => {
    const sb = makeSupabase({ contacts: [] })
    const got = await matchContact(sb, {
      userId: 'u1', email: 'malmakheeti@limad.com', name: 'Muna Almakheeti',
      domain: 'limad.com', companyName: "L'IMAD", companyId: 'c7',
    })
    expect(got.outcome).toBe('created')
    expect(sb.__writes.contacts[0]).toMatchObject({
      name: 'Muna Almakheeti', email: 'malmakheeti@limad.com',
      company: "L'IMAD", company_id: 'c7', created_from: 'email_sync', status: 'cold',
    })
  })

  it('never invents a contact from a bare gmail address', async () => {
    const sb = makeSupabase({ contacts: [] })
    const got = await matchContact(sb, {
      userId: 'u1', email: 'shuaa.ms@gmail.com', name: 'Shuaa Al Harbi',
      domain: 'gmail.com', kind: 'personal',
    })
    expect(got.outcome).toBe('skipped_personal')
    expect(sb.__writes.contacts).toHaveLength(0)
  })

  it('but does log against a personal address already in the CRM', async () => {
    const sb = makeSupabase({
      contacts: [{ id: 'k9', user_id: 'u1', name: 'Shuaa Al Harbi', email: 'shuaa.ms@gmail.com', company: null }],
    })
    const got = await matchContact(sb, {
      userId: 'u1', email: 'shuaa.ms@gmail.com', name: 'Shuaa Al Harbi', domain: 'gmail.com', kind: 'personal',
    })
    expect(got).toMatchObject({ contactId: 'k9', outcome: 'matched_email' })
  })

  it('never creates a contact called "info"', async () => {
    const sb = makeSupabase({ contacts: [] })
    const got = await matchContact(sb, {
      userId: 'u1', email: 'info@e7group.ae', name: '', domain: 'e7group.ae', kind: 'role',
    })
    expect(got.outcome).toBe('skipped_role')
    expect(sb.__writes.contacts).toHaveLength(0)
  })
})

describe('applySignature', () => {
  it('fills an empty title and direct line', async () => {
    const sb = makeSupabase()
    const got = await applySignature(sb, { id: 'k1', title: null, phone: null }, {
      title: 'Organization Development Senior Manager', phone: '+966 11 4600000 ext 3118',
    })
    expect(got.updated).toBe(true)
    expect(got.fields.sort()).toEqual(['phone', 'title'])
  })

  it('never overwrites what the recruiter typed', async () => {
    const sb = makeSupabase()
    const got = await applySignature(sb, { id: 'k1', title: 'Head of OD', phone: '+971 50 000 0000' }, {
      title: 'Organization Development Senior Manager', phone: '+966 11 4600000 ext 3118',
    })
    expect(got.updated).toBe(false)
    expect(sb.__writes.updates).toHaveLength(0)
  })
})

describe('appendContactNote', () => {
  it('appends in the same format the recruiter sees elsewhere', async () => {
    const sb = makeSupabase()
    const got = await appendContactNote(sb, {
      contactId: 'k1', existingNotes: '25 Aug 2026 — Sent two candidate profiles',
      note: 'Confirmed Sunday 1pm for the interview', sentAt: '2026-09-02T09:20:19.000Z',
    })
    expect(got.ok).toBe(true)
    expect(got.notes).toBe('25 Aug 2026 — Sent two candidate profiles\n\n2 Sep 2026 — Confirmed Sunday 1pm for the interview')
  })

  it('stamps last_contacted for real contact', async () => {
    const sb = makeSupabase()
    await appendContactNote(sb, { contactId: 'k1', note: 'Asked for alternative times', sentAt: '2026-09-02T09:12:00.000Z' })
    expect(sb.__writes.updates[0].patch.last_contacted).toBe('2026-09-02T09:12:00.000Z')
  })

  it('does NOT stamp last_contacted for an out-of-office', async () => {
    // Hannah Wild's auto-reply. Counting it as contact would mark the approach
    // answered and stop Annie chasing a mandate that was never discussed.
    const sb = makeSupabase()
    await appendContactNote(sb, {
      contactId: 'k1', note: 'Out of office until 21 Sep', sentAt: '2026-09-03T05:24:35.000Z',
      countsAsContact: false,
    })
    expect(sb.__writes.updates[0].patch.last_contacted).toBeUndefined()
    expect(sb.__writes.updates[0].patch.notes).toContain('Out of office until 21 Sep')
  })

  it('does not write the same note twice', async () => {
    const sb = makeSupabase()
    const got = await appendContactNote(sb, {
      contactId: 'k1', existingNotes: '2 Sep 2026 — Confirmed Sunday 1pm',
      note: 'Confirmed Sunday 1pm', sentAt: '2026-09-02T09:20:19.000Z',
    })
    expect(got.skipped).toBe('duplicate')
    expect(sb.__writes.updates).toHaveLength(0)
  })
})

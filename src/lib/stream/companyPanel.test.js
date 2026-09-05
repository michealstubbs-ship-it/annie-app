import { describe, it, expect } from 'vitest'
import { buildCompanyPanel, readoutFor } from './companyPanel'

// The real Khazna rows, titles and all. Using real data is how the ranking
// bugs were found in the first place — "Assistant Manager - CEO Office" ranked
// number one, and no unit test would have caught it.
const khazna = [
  { id: '1', name: 'Johan Nilerud', company: 'Khazna Data Centers', title: 'Chief Strategy Officer', seniority_band: 'c_suite', function_area: 'Strategy & Corporate Development' },
  { id: '2', name: 'Jogesh Ajay', company: 'Khazna Data Centers', title: 'Chief of Staff', seniority_band: 'director_vp', function_area: 'General Management' },
  { id: '3', name: 'Carrie Hon', company: 'Khazna Data Centers', title: 'Senior Director, Corporate PMO', seniority_band: 'director_vp', function_area: 'Operations & Supply Chain' },
  { id: '4', name: 'Aprajita Bansal', company: 'Khazna Data Centers', title: 'Assistant Manager, CEO Office', seniority_band: 'manager_plus', function_area: 'General Management' },
  { id: '5', name: 'Layla H', company: 'Khazna Data Centers', title: 'Human Resources Business Partner', seniority_band: 'below', function_area: 'Human Resources' },
  { id: '9', name: 'Someone Else', company: 'ADQ', title: 'CFO', seniority_band: 'c_suite' },
]

const signal = { company_name: 'Khazna Data Centers', linked_contact_id: '1' }

describe('buildCompanyPanel', () => {
  it('lists everyone else at the company and leaves the person on the card out', () => {
    const panel = buildCompanyPanel({ signal, wayIn: { person: khazna[0] }, contacts: khazna })
    expect(panel.others.map(p => p.name)).not.toContain('Johan Nilerud')
    expect(panel.others).toHaveLength(4)
    expect(panel.total).toBe(5)
  })

  it('does not drag in a contact at a different company', () => {
    const panel = buildCompanyPanel({ signal, wayIn: { person: khazna[0] }, contacts: khazna })
    expect(panel.others.map(p => p.name)).not.toContain('Someone Else')
  })

  it('orders by seniority, so the useful names are first', () => {
    const panel = buildCompanyPanel({ signal, wayIn: { person: khazna[0] }, contacts: khazna })
    expect(panel.others.map(p => p.bandLabel)).toEqual(['Dir/VP', 'Dir/VP', 'Manager', 'Below'])
  })

  it('returns null rather than an empty block', () => {
    expect(buildCompanyPanel({ signal, wayIn: { person: khazna[0] }, contacts: [khazna[0]] })).toBeNull()
    expect(buildCompanyPanel({ signal: { company_name: 'Confidential' }, contacts: khazna })).toBeNull()
    expect(buildCompanyPanel({ signal: {}, contacts: khazna })).toBeNull()
  })

  it('marks the ones you have actually spoken to, which is the whole ladder', () => {
    const withHistory = khazna.map(c => c.id === '3' ? { ...c, last_contacted: '2026-08-01' } : c)
    const panel = buildCompanyPanel({ signal, wayIn: { person: khazna[0] }, contacts: withHistory })
    expect(panel.others.find(p => p.name === 'Carrie Hon').spokenTo).toBe(true)
    expect(panel.others.find(p => p.name === 'Layla H').spokenTo).toBe(false)
  })
})

describe('readoutFor — the sentence that makes the list worth opening', () => {
  const functions = ['Strategy & Corporate Development', 'Operations & Supply Chain', 'Technology']

  it('says the shape of the relationship, not just the count', () => {
    const panel = buildCompanyPanel({ signal, wayIn: { person: khazna[0] }, contacts: khazna, functions })
    expect(panel.readout).toContain('Two at director or head level')
    expect(panel.readout).toContain('One of the four sits in functions you recruit into')
  })

  it('says plainly when there is no route into the roles you actually recruit', () => {
    const line = readoutFor([
      { name: 'A B', band: 'director_vp', functionArea: 'Legal & Compliance' },
      { name: 'C D', band: 'manager_plus', functionArea: 'Legal & Compliance' },
    ], ['Finance & Accounting'])
    expect(line).toContain('None of them sits in a function you recruit into')
  })

  it('leads with logged contact when there is any, because it is the strongest fact', () => {
    const line = readoutFor([{ name: 'Carrie Hon', band: 'director_vp', spokenTo: true }], [])
    expect(line).toContain('You have logged contact with Carrie before')
  })

  // Deliberately says nothing about competitors. Everyone in this panel is by
  // definition at the company on the card, so the title-keyword competitor
  // flag fires on in-house recruiters — on the real account it told Michael
  // his own Talent Acquisition Lead at Emirates NBD was "at a search firm,
  // not the company itself", which is false.
  it('does not call an in-house recruiter a rival', () => {
    const line = readoutFor([{ name: 'Jason Paul Sarmiento', band: 'manager_plus', functionArea: 'HR & People', isCompetitor: true }], [])
    expect(line).not.toContain('search firm')
  })

  it('says nothing about function fit when the customer never chose any', () => {
    const line = readoutFor([{ name: 'A B', band: 'c_suite', functionArea: 'Finance & Accounting' }], [])
    expect(line).not.toContain('recruit into')
  })
})

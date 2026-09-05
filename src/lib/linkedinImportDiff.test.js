import { describe, it, expect } from 'vitest'
import {
  detectChange,
  detectChanges,
  detectCoMovement,
  buildChangeSignals,
  buildAllChangeSignals,
  contactUpdateFor,
  CHANGE_JOB_MOVE,
  CHANGE_PROMOTION,
} from './linkedinImportDiff'

const existing = {
  id: 'c1',
  name: 'Mohammad Maghaireh',
  company: 'Al Akaria',
  title: 'Chief Strategy Officer',
  linkedin_url: 'https://www.linkedin.com/in/mohammad',
}

describe('detectChange', () => {
  it('detects a change of employer', () => {
    const change = detectChange({ company: 'PIF', title: 'Group Chief Strategy Officer' }, existing)
    expect(change.type).toBe(CHANGE_JOB_MOVE)
    expect(change.from.company).toBe('Al Akaria')
    expect(change.to.company).toBe('PIF')
  })

  it('ignores a legal-suffix rewrite of the same employer', () => {
    expect(detectChange({ company: 'Al Akaria LLC', title: existing.title }, existing)).toBeNull()
  })

  // LinkedIn returns an empty or hidden employer for a member who tightens
  // their privacy settings. Announcing "they left Al Akaria" on the strength of
  // that would invent an event out of a settings change.
  it('does not call a hidden or missing employer a move', () => {
    expect(detectChange({ company: '', title: existing.title }, existing)).toBeNull()
    expect(detectChange({ company: 'Confidential', title: existing.title }, existing)).toBeNull()
    expect(detectChange({ company: 'Stealth Startup', title: existing.title }, existing)).toBeNull()
  })

  it('detects a promotion that crosses a seniority band', () => {
    const before = { ...existing, title: 'Head of Strategy' }
    const change = detectChange({ company: 'Al Akaria', title: 'Chief Strategy Officer' }, before)
    expect(change.type).toBe(CHANGE_PROMOTION)
    expect(change.from.title).toBe('Head of Strategy')
  })

  // The most common edit in a LinkedIn re-export is someone lengthening their
  // own title. Reporting those as promotions would bury the real ones.
  it('ignores a title that got longer without getting bigger', () => {
    const before = { ...existing, title: 'Head of Strategy' }
    expect(detectChange({ company: 'Al Akaria', title: 'Head of Strategy & Transformation' }, before)).toBeNull()
  })

  it('ignores a sideways or downward title change', () => {
    const before = { ...existing, title: 'Chief Strategy Officer' }
    expect(detectChange({ company: 'Al Akaria', title: 'Head of Strategy' }, before)).toBeNull()
  })

  it('returns null for junk input rather than throwing', () => {
    expect(detectChange(null, existing)).toBeNull()
    expect(detectChange({ company: 'X' }, null)).toBeNull()
  })
})

describe('detectChanges', () => {
  it('matches on LinkedIn URL, then email, and ignores rows with neither', () => {
    const byKey = new Map([
      ['https://www.linkedin.com/in/mohammad', existing],
      ['a@visa.com', { id: 'c2', name: 'Lanbo', company: 'Visa', title: 'Director' }],
    ])
    const out = detectChanges([
      { linkedin_url: 'https://www.linkedin.com/in/mohammad', company: 'PIF', title: 'CSO' },
      { email: 'A@Visa.com', company: 'Mastercard', title: 'Director' },
      { company: 'Nobody Ltd', title: 'CEO' },
    ], byKey)
    expect(out.map(c => c.to.company)).toEqual(['PIF', 'Mastercard'])
  })

  it('is empty when nothing moved', () => {
    const byKey = new Map([['https://www.linkedin.com/in/mohammad', existing]])
    expect(detectChanges([{ linkedin_url: 'https://www.linkedin.com/in/mohammad', company: 'Al Akaria', title: existing.title }], byKey)).toEqual([])
  })
})

describe('buildChangeSignals', () => {
  const change = {
    type: CHANGE_JOB_MOVE,
    contactId: 'c1',
    name: 'Mohammad Maghaireh',
    linkedin_url: 'https://www.linkedin.com/in/mohammad',
    from: { company: 'Al Akaria', title: 'Chief Strategy Officer' },
    to: { company: 'PIF', title: 'Group CSO' },
  }

  // The correction that produced this test. An earlier mock read "September had
  // him at Al Akaria, October does not" and narrated it as an arrival — telling
  // the recruiter about a new seat the data never showed. What the data
  // supports is that he LEFT, so his old employer probably has a role open.
  it('produces two leads from one move, vacated seat first', () => {
    const rows = buildChangeSignals(change, { userId: 'u1' })
    expect(rows).toHaveLength(2)
    expect(rows[0].company_name).toBe('Al Akaria')
    expect(rows[0].headline).toBe('Mohammad Maghaireh has left Al Akaria')
    expect(rows[1].company_name).toBe('PIF')
    expect(rows[1].headline).toBe('Mohammad Maghaireh has joined PIF')
  })

  it('says the old employer is likely replacing them', () => {
    const [vacated] = buildChangeSignals(change, { userId: 'u1' })
    expect(vacated.why_it_matters).toContain('likely replacing them')
    expect(vacated.why_it_matters).toContain('you already have a relationship there')
  })

  // The copy rule, pinned as a test because it was a real correction: nobody
  // in recruitment says "a senior person in a new seat, with a budget and
  // something to prove — the warmest call in recruitment".
  it('uses no recruiter-marketing language', () => {
    const text = buildChangeSignals(change, { userId: 'u1' }).map(r => `${r.headline} ${r.why_it_matters}`).join(' ')
    expect(text).not.toMatch(/warmest|something to prove|bench|new seat|budget and/i)
  })

  it('never claims a verified contact', () => {
    for (const row of buildChangeSignals(change, { userId: 'u1' })) {
      expect(row.contact_verified).toBe(false)
      expect(row.source_label).toBe('Your LinkedIn export')
    }
  })

  it('gives each side its own dedup key so a re-import does not duplicate them', () => {
    const rows = buildChangeSignals(change, { userId: 'u1' })
    expect(rows[0].dedup_key).not.toBe(rows[1].dedup_key)
    const again = buildChangeSignals(change, { userId: 'u1' })
    expect(again.map(r => r.dedup_key)).toEqual(rows.map(r => r.dedup_key))
  })

  it('produces only the arrival when the previous employer was hidden', () => {
    const rows = buildChangeSignals({ ...change, from: { company: 'Confidential', title: 'CSO' } }, { userId: 'u1' })
    expect(rows).toHaveLength(1)
    expect(rows[0].company_name).toBe('PIF')
  })

  it('produces one signal for a promotion, at the same company', () => {
    const rows = buildChangeSignals({
      type: CHANGE_PROMOTION,
      contactId: 'c9',
      name: 'Aisha Rahman',
      from: { company: 'ADQ', title: 'Head of Strategy' },
      to: { company: 'ADQ', title: 'Chief Strategy Officer' },
    }, { userId: 'u1' })
    expect(rows).toHaveLength(1)
    expect(rows[0].headline).toContain('promoted at ADQ')
    expect(rows[0].why_it_matters).toContain('Head of Strategy to Chief Strategy Officer')
  })

  it('returns nothing for nothing', () => {
    expect(buildChangeSignals(null, { userId: 'u1' })).toEqual([])
    expect(buildAllChangeSignals([], { userId: 'u1' })).toEqual([])
  })
})

describe('detectCoMovement', () => {
  // Two contacts landing at the same employer in one import is a team being
  // built, which is a much bigger opportunity than two unrelated moves.
  it('groups contacts who landed at the same new employer', () => {
    const groups = detectCoMovement([
      { type: CHANGE_JOB_MOVE, to: { company: 'NEOM' }, from: { company: 'A' } },
      { type: CHANGE_JOB_MOVE, to: { company: 'NEOM Ltd' }, from: { company: 'B' } },
      { type: CHANGE_JOB_MOVE, to: { company: 'PIF' }, from: { company: 'C' } },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(2)
  })

  it('ignores promotions and single movers', () => {
    expect(detectCoMovement([
      { type: CHANGE_PROMOTION, to: { company: 'ADQ' }, from: { company: 'ADQ' } },
      { type: CHANGE_JOB_MOVE, to: { company: 'PIF' }, from: { company: 'C' } },
    ])).toEqual([])
  })
})

describe('contactUpdateFor', () => {
  // Kept separate from the signals deliberately: losing a lead is recoverable
  // on the next import, silently keeping a stale employer on a contact is not.
  it('returns the new employer and title for the CRM row', () => {
    expect(contactUpdateFor({
      contactId: 'c1',
      to: { company: 'PIF', title: 'Group CSO' },
    })).toMatchObject({ id: 'c1', company: 'PIF', title: 'Group CSO' })
  })

  // The facets are derived from the title, so a move or a promotion makes the
  // stored ones wrong the moment the title changes — and both the backlog and
  // the scan watchlist rank on them. Writing the new company without the new
  // band would leave a promoted Head of Strategy still filed as a Director.
  it('recomputes the facets rather than leaving them stale', () => {
    const promoted = contactUpdateFor({
      contactId: 'c1',
      from: { company: 'ADQ', title: 'Head of Strategy' },
      to: { company: 'ADQ', title: 'Chief Strategy Officer' },
    })
    expect(promoted.seniority_band).toBe('c_suite')
    expect(promoted.function_area).toBe('Strategy & Corporate Development')
    expect(promoted.is_competitor).toBe(false)
  })

  // A contact who moves to a search firm becomes a competitor, and the ranking
  // has to stop offering them as a lead.
  it('notices when the move made them a competitor', () => {
    const moved = contactUpdateFor({
      contactId: 'c2',
      from: { company: 'ADQ', title: 'Head of Strategy' },
      to: { company: 'Some Executive Search', title: 'Managing Partner' },
    })
    expect(moved.is_competitor).toBe(true)
  })

  it('returns null for nothing', () => {
    expect(contactUpdateFor(null)).toBeNull()
  })
})

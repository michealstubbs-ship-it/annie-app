import { describe, it, expect } from 'vitest'
import {
  isPlaceholderCompany,
  exclusionReason,
  functionFit,
  recencyBonus,
  scoreContact,
  buildCompanyDepth,
  rankBacklog,
  backlogWhyItMatters,
  SENIORITY_SCORE,
  DEPTH_CAP,
} from './backlogRanking'

const FUNCTIONS = ['Strategy & Corporate Development', 'Finance & Accounting', 'Technology, Data & Engineering']

function contact(over = {}) {
  return {
    id: over.id || Math.random().toString(36).slice(2),
    name: 'A Person',
    company: 'ADQ',
    title: 'Chief Strategy Officer',
    seniority_band: 'c_suite',
    function_area: 'Strategy & Corporate Development',
    relationship_tier: 'connection',
    is_competitor: false,
    connected_on: null,
    last_contacted: null,
    ...over,
  }
}

describe('isPlaceholderCompany', () => {
  // Every string here is a real value from the measured account. "Confidential"
  // was also the top card in the live feed the day it was reviewed — the same
  // bug arriving through the CSV and through the scan.
  it('rejects the names LinkedIn uses when someone hides their employer', () => {
    expect(isPlaceholderCompany('Confidential')).toBe(true)
    expect(isPlaceholderCompany('Confidential Government')).toBe(true)
    expect(isPlaceholderCompany('Confidential Portfolio Company')).toBe(true)
    expect(isPlaceholderCompany('Stealth Startup')).toBe(true)
    expect(isPlaceholderCompany('Self-employed')).toBe(true)
    expect(isPlaceholderCompany('N/A')).toBe(true)
    expect(isPlaceholderCompany('')).toBe(true)
    expect(isPlaceholderCompany(null)).toBe(true)
  })

  it('does not reject real employers', () => {
    expect(isPlaceholderCompany('ADQ')).toBe(false)
    expect(isPlaceholderCompany('Khazna Data Centers')).toBe(false)
    expect(isPlaceholderCompany('Public Investment Fund (PIF)')).toBe(false)
    // Guarding the obvious false positive from the startsWith rule.
    expect(isPlaceholderCompany('Confidence Capital')).toBe(false)
  })
})

describe('exclusionReason', () => {
  it('keeps a qualifying senior contact', () => {
    expect(exclusionReason(contact(), { functions: FUNCTIONS })).toBeNull()
  })

  it('drops rival recruiters', () => {
    expect(exclusionReason(contact({ is_competitor: true }), { functions: FUNCTIONS })).toBe('competitor')
  })

  it('drops anyone whose employer cannot be named', () => {
    expect(exclusionReason(contact({ company: 'Confidential' }), { functions: FUNCTIONS })).toBe('no_real_employer')
  })

  it('drops below-manager contacts, who cannot commission a search', () => {
    expect(exclusionReason(contact({ seniority_band: 'below' }), { functions: FUNCTIONS })).toBe('too_junior')
  })

  // FEED-6: a regulatory/HSE lead reached a recruiter who works in Strategy,
  // Finance and Technology. The filter existed in onboarding and was enforced
  // nowhere.
  it('enforces the function filter that onboarding collects', () => {
    const hse = contact({ function_area: 'HSE, Sustainability & Quality' })
    expect(exclusionReason(hse, { functions: FUNCTIONS })).toBe('wrong_function')
    // With no functions chosen, nothing is filtered out on that basis.
    expect(exclusionReason(hse, { functions: [] })).toBeNull()
  })

  // A title the classifier could not read is a failure of the classifier. It
  // must not silently delete a real relationship.
  it('keeps a contact whose function could not be classified', () => {
    expect(exclusionReason(contact({ function_area: null }), { functions: FUNCTIONS })).toBeNull()
  })

  it('drops anyone already contacted', () => {
    const spoken = contact({ last_contacted: '2026-08-01T00:00:00Z' })
    expect(exclusionReason(spoken, { functions: FUNCTIONS })).toBe('already_contacted')
  })
})

describe('functionFit', () => {
  it('scores a confirmed match above an unreadable title above a mismatch', () => {
    expect(functionFit(contact(), { functions: FUNCTIONS })).toBe(1)
    expect(functionFit(contact({ function_area: null }), { functions: FUNCTIONS })).toBe(0.75)
    expect(functionFit(contact({ function_area: 'HR & People' }), { functions: FUNCTIONS })).toBe(0)
  })
})

describe('recencyBonus', () => {
  const now = new Date('2026-09-05T00:00:00Z')
  it('rewards a recent connection over an old one', () => {
    expect(recencyBonus('2026-06-01', now)).toBe(12)
    expect(recencyBonus('2024-06-01', now)).toBe(8)
    expect(recencyBonus('2021-06-01', now)).toBe(4)
    expect(recencyBonus('2015-06-01', now)).toBe(0)
  })

  it('is never negative and survives junk', () => {
    expect(recencyBonus(null, now)).toBe(0)
    expect(recencyBonus('not a date', now)).toBe(0)
    expect(recencyBonus('2030-01-01', now)).toBe(0)
  })
})

describe('scoreContact', () => {
  it('ranks C-suite above Director even at maximum account depth', () => {
    const depth = new Map([['adq', 10]])
    const cLevel = scoreContact(contact({ seniority_band: 'c_suite', company: 'Solo Co' }), { functions: FUNCTIONS })
    const director = scoreContact(contact({ seniority_band: 'director_vp' }), { functions: FUNCTIONS, depthByCompany: depth })
    expect(cLevel.score).toBeGreaterThan(director.score)
    expect(director.score).toBe(SENIORITY_SCORE.director_vp + DEPTH_CAP)
  })

  it('rewards knowing several people at one company', () => {
    const one = scoreContact(contact({ company: 'Solo Co' }), { functions: FUNCTIONS })
    const many = scoreContact(contact(), { functions: FUNCTIONS, depthByCompany: new Map([['adq', 7]]) })
    expect(many.score).toBeGreaterThan(one.score)
    expect(many.reasons.join(' ')).toContain('7 people at ADQ')
  })

  it('scores an excluded contact at zero and says why', () => {
    const out = scoreContact(contact({ is_competitor: true }), { functions: FUNCTIONS })
    expect(out.score).toBe(0)
    expect(out.excluded).toBe('competitor')
  })
})

describe('rankBacklog', () => {
  const many = [
    contact({ id: 'a', name: 'Aaa CSO', seniority_band: 'c_suite', company: 'ADQ' }),
    contact({ id: 'b', name: 'Bbb VP', seniority_band: 'director_vp', company: 'ADQ' }),
    contact({ id: 'c', name: 'Ccc Junior', seniority_band: 'below', company: 'ADQ' }),
    contact({ id: 'd', name: 'Ddd Rival', is_competitor: true, company: 'Some Search Firm' }),
    contact({ id: 'e', name: 'Eee Hidden', company: 'Confidential' }),
    contact({ id: 'f', name: 'Fff HSE', function_area: 'HSE, Sustainability & Quality' }),
    contact({ id: 'g', name: 'Ggg Spoken', last_contacted: '2026-08-01T00:00:00Z' }),
  ]

  it('returns only the people a recruiter could actually call', () => {
    const out = rankBacklog(many, { functions: FUNCTIONS })
    expect(out.map(e => e.contact.id)).toEqual(['a', 'b'])
  })

  it('caps the list rather than emptying 600 contacts into the feed', () => {
    const lots = Array.from({ length: 100 }, (_, i) => contact({ id: `x${i}`, name: `P${i}` }))
    expect(rankBacklog(lots, { functions: FUNCTIONS }).length).toBe(8)
    expect(rankBacklog(lots, { functions: FUNCTIONS, limit: 3 }).length).toBe(3)
  })

  // A list that reshuffles between page loads reads as broken, even when every
  // entry is individually correct.
  it('is deterministic for equal scores', () => {
    const tied = [contact({ id: '1', name: 'Zoe' }), contact({ id: '2', name: 'Adam' })]
    const first = rankBacklog(tied, { functions: FUNCTIONS }).map(e => e.contact.name)
    const second = rankBacklog(tied, { functions: FUNCTIONS }).map(e => e.contact.name)
    expect(first).toEqual(second)
    expect(first[0]).toBe('Adam')
  })

  it('honours an exclude set so live signals are not duplicated', () => {
    const out = rankBacklog(many, { functions: FUNCTIONS, exclude: new Set(['a']) })
    expect(out.map(e => e.contact.id)).toEqual(['b'])
  })

  // PINNING. Once a person has been PUT somewhere — marked Working by the
  // recruiter, or chosen into today's set this morning — the ranking no longer
  // gets a vote on whether they exist. Scores move during a day; a name on the
  // list at 9am has to still be there at 4pm, and losing in-flight work
  // because a score drifted is the one unforgivable bug in a feed.
  it('returns a pinned contact that the cap would otherwise have cut', () => {
    const lots = Array.from({ length: 50 }, (_, i) => contact({
      id: `x${i}`, name: `P${i}`, seniority_band: 'c_suite',
    }))
    const weak = contact({ id: 'pinned', name: 'Zed Weak', seniority_band: 'manager_plus' })
    const out = rankBacklog([...lots, weak], { functions: FUNCTIONS, limit: 8, pin: new Set(['pinned']) })
    expect(out.map(e => e.contact.id)).toContain('pinned')
  })

  it('costs the day no slots to pin somebody', () => {
    // A recruiter with six things in progress still gets a full pool of new
    // names underneath them, rather than two.
    const lots = Array.from({ length: 50 }, (_, i) => contact({ id: `x${i}`, name: `P${i}` }))
    const out = rankBacklog(lots, { functions: FUNCTIONS, limit: 8, pin: new Set(['x0', 'x1']) })
    expect(out).toHaveLength(10)
  })

  it('still drops a pinned contact who has since been contacted', () => {
    // Pinning holds a name against a wobble in the ranking, never against a
    // real change in the underlying fact. Logging a note is what removes
    // someone from the backlog, and it still does.
    const out = rankBacklog(
      [contact({ id: 'pinned', last_contacted: '2026-09-05T09:00:00Z' })],
      { functions: FUNCTIONS, pin: new Set(['pinned']) },
    )
    expect(out).toEqual([])
  })

  it('survives an empty CRM', () => {
    expect(rankBacklog([], { functions: FUNCTIONS })).toEqual([])
    expect(rankBacklog(undefined, { functions: FUNCTIONS })).toEqual([])
  })
})

describe('buildCompanyDepth', () => {
  it('counts contacts per company, case and space insensitive', () => {
    const d = buildCompanyDepth([
      { company: 'ADQ' }, { company: 'adq ' }, { company: 'Visa' }, { company: '' },
    ])
    expect(d.get('adq')).toBe(2)
    expect(d.get('visa')).toBe(1)
  })
})

describe('backlogWhyItMatters', () => {
  // The copy rule, stated plainly: no recruiter-marketing language. An earlier
  // draft wrote "a senior person in a new seat, with a budget and something to
  // prove" and the recruiter reading it said nobody talks that way.
  it('says what is true and stops', () => {
    const line = backlogWhyItMatters({
      contact: contact({ title: 'Group Chief Strategy Officer', company: 'ADQ' }),
      atCompany: 4,
    })
    expect(line).toBe('Group Chief Strategy Officer at ADQ. In your network, never contacted. You know 4 people there.'
      .replace('In your', 'in your').replace('You know', 'you know'))
    expect(line).not.toMatch(/warmest|budget|something to prove|bench|new seat/i)
  })
})

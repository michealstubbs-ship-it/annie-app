import { describe, it, expect } from 'vitest'
import { buildCandidatePitchPrompt, buildEnrichmentPrompt, fallbackHeadline, fallbackDetail, describeItem } from './actionsCopy.js'

describe('buildEnrichmentPrompt', () => {
  it('gives every item a positional id and tells the model to echo it back', () => {
    const items = [
      { category: 'dormant', signals: {}, contact: { name: 'A', company: 'Acme', title: 'CFO' } },
      { category: 'relationship', signals: {}, signal: { company_name: 'Zenith', headline: 'Raises Series B' }, contact: { name: 'B' } },
    ]
    const prompt = buildEnrichmentPrompt(items, null, null)
    expect(prompt).toContain('"id":0')
    expect(prompt).toContain('"id":1')
    expect(prompt).toMatch(/echo that same id back/i)
  })

  it('tells the model relationship items still need full substance, not just a softer tone', () => {
    const prompt = buildEnrichmentPrompt([{ category: 'relationship', signals: {}, signal: { company_name: 'Zenith', headline: 'x' }, contact: {} }], null, null)
    expect(prompt).toMatch(/do not skip or thin out an item/i)
  })

  // 2026-09-02 audit fix, real report: a company having ANY contact row in
  // the CRM (including a cold, unengaged LinkedIn import) got treated as
  // proof of an actual relationship, so every "relationship" item was
  // written soft and light-touch regardless of whether the recruiter had
  // ever actually spoken to anyone there.
  it('tells the model never to assume a relationship just because a contact row exists', () => {
    const prompt = buildEnrichmentPrompt([{ category: 'relationship', signals: {}, signal: { company_name: 'Zenith', headline: 'x' }, contact: {} }], null, null)
    expect(prompt).toMatch(/is NOT a relationship/i)
    expect(prompt).toMatch(/treat it as a cold approach by default/i)
  })

  it('tells the model it may reference a real prior contact only when priorNote/priorNoteDate evidence is present', () => {
    const prompt = buildEnrichmentPrompt([{ category: 'relationship', signals: {}, signal: { company_name: 'Zenith', headline: 'x' }, contact: {} }], null, null)
    expect(prompt).toMatch(/priorContactName, priorNote, AND priorNoteDate together/)
    expect(prompt).toMatch(/never invent or imply a relationship, a prior conversation, or the other person's disposition that isn't evidenced/i)
  })

  // 2026-09-04 audit fix, real report (Michael: "the contact... says
  // 'Mohammad is receptive'. This is not true as I have never spoken to
  // him"): this evidence rule used to only ever be stated for items
  // labeled "relationship" — every other category had no such instruction
  // at all, so nothing stopped the model from inventing the other side's
  // mood or claiming a conversation that never happened.
  it('applies the same evidence rule to every category, not just items labeled "relationship"', () => {
    const prompt = buildEnrichmentPrompt([{ category: 'dormant', signals: {}, contact: { name: 'Mohammad' } }], null, null)
    expect(prompt).toMatch(/APPLIES TO EVERY ITEM, WHATEVER ITS CATEGORY/)
    expect(prompt).toMatch(/never state or imply that the other person is receptive/i)
  })
})

describe('describeItem — relationship evidence', () => {
  it('passes no prior-contact evidence through when the matched CRM contact has no notes on file', () => {
    const item = { category: 'relationship', signals: {}, signal: { company_name: 'Mal', headline: 'CBUAE approval' }, contact: { name: 'Anas Bourani', notes: '' } }
    const d = describeItem(item)
    expect(d.priorContactName).toBeNull()
    expect(d.priorNote).toBeNull()
    expect(d.priorNoteDate).toBeNull()
  })

  it('passes no prior-contact evidence through when there is no matched CRM contact at all', () => {
    const item = { category: 'relationship', signals: {}, signal: { company_name: 'Mal', headline: 'CBUAE approval' } }
    const d = describeItem(item)
    expect(d.priorContactName).toBeNull()
  })

  it('passes real prior-contact evidence through when the matched CRM contact has a genuine note on file', () => {
    const item = {
      category: 'relationship',
      signals: {},
      signal: { company_name: 'Mal', headline: 'CBUAE approval' },
      contact: { name: 'Anas Bourani', notes: 'Spoke at GITEX, interested in a CTO-adjacent hire', last_contacted: '2026-06-01', status: 'warm' },
    }
    const d = describeItem(item)
    expect(d.priorContactName).toBe('Anas Bourani')
    expect(d.priorNote).toBe('Spoke at GITEX, interested in a CTO-adjacent hire')
    expect(d.priorNoteDate).toBe('2026-06-01')
    expect(d.priorContactStatus).toBe('warm')
  })

  it('treats a whitespace-only note as no real evidence', () => {
    const item = { category: 'relationship', signals: {}, signal: { company_name: 'Mal', headline: 'x' }, contact: { name: 'A', notes: '   ' } }
    expect(describeItem(item).priorContactName).toBeNull()
  })
})

// 2026-09-04 audit fix, real report (Michael: "the contact... says
// 'Mohammad is receptive'. This is not true as I have never spoken to
// him"): the relationship-only evidence check above used to be the ONLY
// place this gating existed — a "dormant" contact (often only ever added,
// never actually reached), a "new_client" contact whose hot/warm status
// came from something other than a logged conversation, or a "meeting"
// item whose own signals literally say "Reply so far: None logged" all
// used to pass zero evidence fields at all, so nothing in the data itself
// stopped the model from inventing the other side's receptiveness.
describe('describeItem — evidence gating now applies to every category', () => {
  it('dormant: passes no prior-contact evidence when the contact was only ever added, never actually reached', () => {
    const item = { category: 'dormant', signals: {}, contact: { name: 'Mohammad', company: 'Acme', title: 'CFO' } }
    const d = describeItem(item)
    expect(d.priorContactName).toBeNull()
    expect(d.priorNote).toBeNull()
    expect(d.priorNoteDate).toBeNull()
    expect(d.priorContactStatus).toBeNull()
  })

  it('dormant: passes real evidence through when a genuine note is actually on file', () => {
    const item = { category: 'dormant', signals: {}, contact: { name: 'Mohammad', company: 'Acme', title: 'CFO', notes: 'Called 2026-03-01, said to check back in Q3', last_contacted: '2026-03-01', status: 'warm' } }
    const d = describeItem(item)
    expect(d.priorContactName).toBe('Mohammad')
    expect(d.priorNote).toBe('Called 2026-03-01, said to check back in Q3')
  })

  it('meeting: passes no prior-contact evidence when there is no linked contact or no note on it', () => {
    expect(describeItem({ category: 'meeting', signals: {}, deal: { company: 'Acme', role: 'CFO' }, contact: null }).priorContactName).toBeNull()
    expect(describeItem({ category: 'meeting', signals: {}, deal: { company: 'Acme', role: 'CFO' }, contact: { name: 'A', notes: '' } }).priorContactName).toBeNull()
  })

  it('new_client: passes no prior-contact evidence just because status is hot/warm — that is not a logged conversation', () => {
    const item = { category: 'new_client', signals: {}, contact: { name: 'Mohammad', company: 'Acme', title: 'CFO', status: 'hot' } }
    expect(describeItem(item).priorContactName).toBeNull()
  })
})

describe('fallbackHeadline / fallbackDetail', () => {
  it('builds honest, grounded copy for a relationship item with no AI entry, distinct from the couldn\'t-load-details failure copy', () => {
    const item = { category: 'relationship', signal: { company_name: 'Zenith', headline: 'Appoints new CFO', why_it_matters: 'A new CFO often resets vendor relationships.' } }
    expect(fallbackHeadline(item)).toBe('Appoints new CFO')
    expect(fallbackDetail(item)).toBe('A new CFO often resets vendor relationships.')
  })

  it('falls back to a generic relationship line when the signal has no why_it_matters', () => {
    const item = { category: 'relationship', signal: { company_name: 'Zenith' } }
    expect(fallbackDetail(item)).toContain('Zenith')
  })

  it('builds a dormant-contact headline from the real contact name', () => {
    const item = { category: 'dormant', contact: { name: 'Hassan Al Rayes' }, signals: { 'Last contact': '90 days ago' } }
    expect(fallbackHeadline(item)).toBe('Re-engage Hassan Al Rayes')
    expect(fallbackDetail(item)).toBe('90 days ago')
  })

  it('never returns empty for an unrecognised category', () => {
    const item = { category: 'unknown' }
    expect(fallbackHeadline(item)).toBe('Follow up')
    expect(fallbackDetail(item).length).toBeGreaterThan(0)
  })
})

describe('buildCandidatePitchPrompt', () => {
  it('includes every pairing given, same order, with only the real grounding fields', () => {
    const targets = [
      { signal: { headline: 'Raises Series B', industry: 'Fintech' }, candidate: { role: 'CFO', company: 'Acme Ltd', industry: 'Fintech', status: 'warm', notes: 'Led a prior Series C raise' } },
      { signal: { headline: 'Appoints new CEO', industry: 'Logistics' }, candidate: { role: 'COO', company: 'Zenith Group', industry: 'Logistics', status: 'new', notes: '' } },
    ]
    const prompt = buildCandidatePitchPrompt(targets)
    expect(prompt).toContain('Raises Series B')
    expect(prompt).toContain('Led a prior Series C raise')
    expect(prompt).toContain('Appoints new CEO')
    expect(prompt).toContain('Zenith Group')
  })

  it('explicitly instructs the model not to invent facts beyond what is given', () => {
    const prompt = buildCandidatePitchPrompt([{ signal: { headline: 'x', industry: 'y' }, candidate: { role: 'r', company: 'c', industry: 'i', status: 's', notes: '' } }])
    expect(prompt).toMatch(/do not invent/i)
  })

  it('gives every pairing a positional id and tells the model to echo it back on each pitch object', () => {
    const prompt = buildCandidatePitchPrompt([
      { signal: { headline: 'a', industry: 'b' }, candidate: { role: 'r1', company: 'c1', industry: 'i1', status: 's1', notes: '' } },
      { signal: { headline: 'c', industry: 'd' }, candidate: { role: 'r2', company: 'c2', industry: 'i2', status: 's2', notes: '' } },
    ])
    expect(prompt).toContain('"id":0')
    expect(prompt).toContain('"id":1')
    expect(prompt).toMatch(/echo that same id back/i)
    expect(prompt).toMatch(/JSON array/i)
  })

  it('falls back to an empty string for a candidate with no notes on file, rather than throwing', () => {
    const prompt = buildCandidatePitchPrompt([{ signal: { headline: 'x', industry: 'y' }, candidate: { role: 'r', company: 'c', industry: 'i', status: 's' } }])
    expect(prompt).toContain('"notes":""')
  })
})

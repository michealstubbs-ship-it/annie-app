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
    expect(prompt).toMatch(/priorContactName\/priorNote\/priorNoteDate/)
    expect(prompt).toMatch(/never invent or imply a relationship that isn't evidenced/i)
  })

  // 2026-09-08 audit fix, Michael, real report, verbatim: "I have literally
  // never spoken to Mohammad but this is what Annie said" — of a
  // "new_client" card asserting "Fasset is signaling openness and Mohammad
  // is receptive" from nothing but the contact's own hot/warm status label.
  it('tells the model never to assert rapport on a new_client item unless priorNote/priorNoteDate evidence is present', () => {
    const prompt = buildEnrichmentPrompt([{ category: 'new_client', signals: {}, contact: { name: 'Mohammad Hossain', company: 'Fasset' } }], null, null)
    expect(prompt).toMatch(/do NOT write headline or detail copy that asserts or implies any existing rapport/i)
    expect(prompt).toMatch(/If you've ever spoken with them, it could be worth reaching out/)
  })
})

describe('describeItem — new_client evidence', () => {
  it('passes no prior-conversation evidence through when the contact has no notes on file', () => {
    const item = { category: 'new_client', signals: {}, contact: { name: 'Mohammad Hossain', company: 'Fasset', title: 'CEO', notes: '' } }
    const d = describeItem(item)
    expect(d.priorNote).toBeNull()
    expect(d.priorNoteDate).toBeNull()
  })

  it('passes real prior-conversation evidence through when the contact has a genuine note on file', () => {
    const item = {
      category: 'new_client',
      signals: {},
      contact: { name: 'Mohammad Hossain', company: 'Fasset', title: 'CEO', notes: 'Met at GITEX, discussed a CTO search', last_contacted: '2026-08-01' },
    }
    const d = describeItem(item)
    expect(d.priorNote).toBe('Met at GITEX, discussed a CTO search')
    expect(d.priorNoteDate).toBe('2026-08-01')
  })

  it('treats a whitespace-only note as no real evidence', () => {
    const item = { category: 'new_client', signals: {}, contact: { name: 'A', company: 'B', notes: '   ' } }
    expect(describeItem(item).priorNote).toBeNull()
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

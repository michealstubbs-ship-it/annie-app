import { describe, it, expect } from 'vitest'
import { provenanceFor } from './provenance'
import { BACKLOG_SIGNAL_TYPE } from './backlogSignals'

describe('provenanceFor', () => {
  // Michael, on the shipped card: "communication should be clear that we found
  // Johan In your contacts."
  it('says a CRM lead came out of the customer\'s own contacts, and how it got there', () => {
    const p = provenanceFor(
      { signal: { signal_type: BACKLOG_SIGNAL_TYPE }, wayIn: { person: { created_from: 'linkedin_import' } } })
    expect(p.label).toBe('From your contacts')
    expect(p.detail).toBe('Imported from LinkedIn · never contacted · no note logged')
  })

  it('does not claim warmth it has not earned, and does not deny it when it has', () => {
    const contact = { created_from: 'csv_import', last_contacted: '2026-08-11', notes: 'Met at the ADIPEC dinner' }
    expect(provenanceFor({ signal: { signal_type: BACKLOG_SIGNAL_TYPE } }, { contact }).detail)
      .toBe('Imported from your CSV · you have logged contact and written a note')
  })

  it('explains a job move by naming the comparison that found it', () => {
    const p = provenanceFor({ signal: { signal_type: 'leadership_change', linked_contact_id: 'c1' } })
    expect(p.label).toBe('Changed jobs')
    expect(p.detail).toContain('comparing your latest LinkedIn export')
  })

  it('names the board a live role was advertised on', () => {
    const p = provenanceFor({ signal: { signal_type: 'live_job', source_label: 'LinkedIn Jobs' } })
    expect(p.label).toBe('Live role')
    expect(p.detail).toContain('Advertised on LinkedIn Jobs')
  })

  it('says market news came from the scan, and that the scan watches their companies', () => {
    const p = provenanceFor({ signal: { signal_type: 'funding', source_label: 'Reuters' } })
    expect(p.detail).toContain('Reuters')
    expect(p.detail).toContain('watching your companies')
  })

  it('always returns both a label and a detail, on every type', () => {
    for (const signal_type of [BACKLOG_SIGNAL_TYPE, 'live_job', 'funding', 'regulatory', 'made_up_type']) {
      const p = provenanceFor({ signal: { signal_type } })
      expect(p.label).toBeTruthy()
      expect(p.detail).toBeTruthy()
    }
  })

  it('returns null on a row with no signal rather than throwing', () => {
    expect(provenanceFor(null)).toBeNull()
    expect(provenanceFor({})).toBeNull()
  })
})

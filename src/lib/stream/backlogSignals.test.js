import { describe, it, expect } from 'vitest'
import { buildBacklogSignals, isBacklogSignal, BACKLOG_SIGNAL_TYPE } from './backlogSignals'
import { buildStream } from './buildStream'

const FUNCTIONS = ['Strategy & Corporate Development']

function contact(over = {}) {
  return {
    id: over.id || 'c1',
    name: 'Aisha Rahman',
    company: 'ADQ',
    title: 'Group Chief Strategy Officer',
    seniority_band: 'c_suite',
    function_area: 'Strategy & Corporate Development',
    is_competitor: false,
    last_contacted: null,
    backlog_parked_at: null,
    linkedin_url: 'https://www.linkedin.com/in/aisha',
    email: null,
    created_at: '2026-08-01T00:00:00Z',
    ...over,
  }
}

describe('buildBacklogSignals', () => {
  it('shapes a contact like a signal row so the whole feed works on it unchanged', () => {
    const [row] = buildBacklogSignals({ contacts: [contact()], functions: FUNCTIONS })
    expect(row.signal_type).toBe(BACKLOG_SIGNAL_TYPE)
    expect(row.company_name).toBe('ADQ')
    expect(row.contact_name).toBe('Aisha Rahman')
    expect(row.linked_contact_id).toBe('c1')
    expect(row.id).toBe('backlog:c1')
    expect(row.status).toBe('new')
  })

  // The contact came from the customer's own CRM, which is better evidence
  // than an Apollo match — but contact_verified means one specific thing in
  // this product and must never be set by inference.
  it('never claims contact_verified', () => {
    const [row] = buildBacklogSignals({ contacts: [contact()], functions: FUNCTIONS })
    expect(row.contact_verified).toBe(false)
  })

  it('says the source is the customer’s own CRM rather than pointing at LinkedIn', () => {
    const [row] = buildBacklogSignals({ contacts: [contact()], functions: FUNCTIONS })
    expect(row.source_label).toBe('Your CRM')
  })

  // If ADQ already has a leadership-change card, a second ADQ card saying "you
  // know four people at ADQ" is noise — the way-in panel on the first card says
  // that already, with a reason attached.
  it('does not duplicate a company that already has a live signal', () => {
    const out = buildBacklogSignals({
      contacts: [contact({ id: 'c1', company: 'ADQ' }), contact({ id: 'c2', company: 'Mubadala' })],
      signals: [{ company_name: 'ADQ', status: 'new' }],
      functions: FUNCTIONS,
    })
    expect(out.map(r => r.company_name)).toEqual(['Mubadala'])
  })

  it('still offers a company whose only signal is already actioned', () => {
    const out = buildBacklogSignals({
      contacts: [contact()],
      signals: [{ company_name: 'ADQ', status: 'actioned' }],
      functions: FUNCTIONS,
    })
    expect(out).toHaveLength(1)
  })

  it('respects an explicit dismissal', () => {
    const out = buildBacklogSignals({
      contacts: [contact({ backlog_parked_at: '2026-09-01T00:00:00Z' })],
      functions: FUNCTIONS,
    })
    expect(out).toHaveLength(0)
  })

  // found_at drives freshness scoring. Stamping "now" would make every backlog
  // item permanently the newest thing in the feed and bury real news under
  // relationships that have not changed in two years.
  it('does not stamp itself as newer than real news', () => {
    const [row] = buildBacklogSignals({ contacts: [contact()], functions: FUNCTIONS })
    expect(row.found_at).toBe('2026-08-01T00:00:00Z')
    expect(row.event_at).toBeNull()
  })

  it('drops contacts with no usable employer', () => {
    const out = buildBacklogSignals({
      contacts: [contact({ id: 'x', company: 'Confidential' }), contact({ id: 'y', company: '' })],
      functions: FUNCTIONS,
    })
    expect(out).toHaveLength(0)
  })

  it('is empty rather than throwing on an empty CRM', () => {
    expect(buildBacklogSignals({})).toEqual([])
  })
})

describe('backlog items inside the real stream', () => {
  it('flows through buildStream and lands in one ranked list with real signals', () => {
    const items = buildStream({
      signals: [{
        id: 's1', signal_type: 'funding', company_name: 'Khazna Data Centers',
        headline: 'Raised a round', status: 'new', found_at: '2026-09-04T00:00:00Z',
      }],
      contacts: [contact()],
      functions: FUNCTIONS,
    })
    const types = items.map(i => i.signal.signal_type)
    expect(types).toContain('funding')
    expect(types).toContain(BACKLOG_SIGNAL_TYPE)
    // One list, not two: every item carries the same computed shape.
    for (const item of items) {
      expect(item.wayIn).toBeTruthy()
      expect(typeof item.score).toBe('number')
    }
  })

  // The whole reason the function filter is threaded through buildStream:
  // FEED-6 was an HSE card reaching a Strategy/Finance/Technology recruiter.
  it('keeps an off-function contact out of the feed entirely', () => {
    const items = buildStream({
      contacts: [contact({ function_area: 'HSE, Sustainability & Quality' })],
      functions: FUNCTIONS,
    })
    expect(items).toHaveLength(0)
  })

  it('adds nothing when the CRM is empty, leaving the feed as it was', () => {
    const items = buildStream({
      signals: [{ id: 's1', signal_type: 'funding', company_name: 'X', headline: 'Y', status: 'new' }],
      contacts: [],
    })
    expect(items).toHaveLength(1)
  })
})

describe('isBacklogSignal', () => {
  it('identifies synthesised rows and nothing else', () => {
    expect(isBacklogSignal({ signal_type: BACKLOG_SIGNAL_TYPE })).toBe(true)
    expect(isBacklogSignal({ signal_type: 'funding' })).toBe(false)
    expect(isBacklogSignal(null)).toBe(false)
  })
})

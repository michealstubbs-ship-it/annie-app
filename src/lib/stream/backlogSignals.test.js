import { describe, it, expect } from 'vitest'
import { buildBacklogSignals, backlogQueue, isBacklogSignal, BACKLOG_SIGNAL_TYPE } from './backlogSignals'
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
      // Two contacts on purpose. The Khazna one puts the funding signal inside
      // the network so the gate lets it through; the ADQ one has no signal of
      // its own, so it becomes the backlog card. With a single ADQ contact the
      // funding signal is a stranger and is correctly dropped - which is the
      // gate working, not the test failing.
      contacts: [
        contact({ id: 'k1', name: 'Johan Nilerud', company: 'Khazna Data Centers' }),
        contact({ id: 'a1', name: 'Mohamed Kaissi', company: 'ADQ' }),
      ],
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

  // FEED-1, Michael's first words about the rebuilt feed: "Confidential is not
  // a company. So, this should not have showed up." The card was still there
  // after the network-first release because isPlaceholderCompany had been wired
  // into the backlog and the import diff but never into the scan's own signals.
  it('drops a scan signal whose employer cannot be named', () => {
    const items = buildStream({
      signals: [
        { id: 's1', signal_type: 'live_job', company_name: 'Confidential', headline: 'Chief Investment Officer', status: 'new' },
        { id: 's2', signal_type: 'live_job', company_name: 'Confidential Government', headline: 'CDO', status: 'new' },
        { id: 's3', signal_type: 'live_job', company_name: 'ADQ', headline: 'Head of Strategy', status: 'new' },
      ],
      contacts: [],
    })
    expect(items.map(i => i.signal.company_name)).toEqual(['ADQ'])
  })

  it('adds nothing when the CRM is empty, leaving the feed as it was', () => {
    const items = buildStream({
      signals: [{ id: 's1', signal_type: 'funding', company_name: 'X', headline: 'Y', status: 'new' }],
      contacts: [],
    })
    expect(items).toHaveLength(1)
  })
})

// The measurement that produced the whole gate: on a real account the day
// after the network-first release, 35 of 38 feed items were at companies the
// recruiter had never heard of, and the 3 that matched his CRM were artefacts
// (two at a company he had called terrible, one at "Confidential"). Genuine
// network leads: zero.
describe('the network gate', () => {
  const known = [contact({ id: 'k1', company: 'ADQ' })]

  it('drops a signal at a company the customer has never heard of', () => {
    const items = buildStream({
      signals: [
        { id: 's1', signal_type: 'live_job', company_name: 'ALAS Emirates Ready Mix', headline: 'CFO', status: 'new' },
        { id: 's2', signal_type: 'live_job', company_name: 'The Justice Law Office', headline: 'Head of Strategy', status: 'new' },
      ],
      contacts: known,
      functions: FUNCTIONS,
    })
    expect(items.map(i => i.signal.id)).not.toContain('s1')
    expect(items.map(i => i.signal.id)).not.toContain('s2')
  })

  it('keeps a signal at a company the customer has a contact at', () => {
    const items = buildStream({
      signals: [{ id: 's1', signal_type: 'live_job', company_name: 'ADQ', headline: 'Head of Strategy', status: 'new' }],
      contacts: known,
      functions: FUNCTIONS,
    })
    expect(items.map(i => i.signal.id)).toContain('s1')
  })

  it('matches through a legal-suffix difference rather than on exact text', () => {
    const items = buildStream({
      signals: [{ id: 's1', signal_type: 'funding', company_name: 'ADQ LLC', headline: 'Raised', status: 'new' }],
      contacts: known,
      functions: FUNCTIONS,
    })
    expect(items.map(i => i.signal.id)).toContain('s1')
  })

  // A job move is about the person, and the destination is by definition a
  // company they do not know yet - that is what makes it a lead.
  it('lets a job move through to a company the customer does not know', () => {
    const items = buildStream({
      signals: [{
        id: 's1', signal_type: 'leadership_change', company_name: 'Somewhere New',
        headline: 'Mohammad has joined Somewhere New', status: 'new', linked_contact_id: 'k1',
      }],
      contacts: known,
      functions: FUNCTIONS,
    })
    expect(items.map(i => i.signal.id)).toContain('s1')
  })

  // Their judgment beats the filter. A card vanishing out of Working because a
  // filter changed is the product losing someone's work.
  it('never hides something the recruiter already marked working or parked', () => {
    const items = buildStream({
      signals: [
        { id: 'w', signal_type: 'live_job', company_name: 'Total Stranger Ltd', headline: 'X', status: 'working' },
        { id: 'p', signal_type: 'live_job', company_name: 'Total Stranger Ltd', headline: 'Y', status: 'parked' },
      ],
      contacts: known,
      functions: FUNCTIONS,
    })
    // The ADQ backlog card rides along too, which is correct - it is a real
    // lead. Assert on the two that matter rather than on an exact list.
    const ids = items.map(i => i.signal.id)
    expect(ids).toContain('w')
    expect(ids).toContain('p')
  })

  // A customer who has imported nothing has no network to be outside of.
  // Hiding everything would make the product look broken on day one.
  it('passes everything through for a customer with no CRM yet', () => {
    const items = buildStream({
      signals: [{ id: 's1', signal_type: 'live_job', company_name: 'Anywhere', headline: 'X', status: 'new' }],
      contacts: [],
    })
    expect(items).toHaveLength(1)
  })
})

describe('a backlog lead the recruiter is working', () => {
  // Before contacts.backlog_working_at existed, the New / Working / Park
  // buttons on a backlog card wrote to intelligence_signals by an id —
  // 'backlog:<contact uuid>' — that matches no row in that table. They were
  // dead controls: nothing saved, and nothing survived a reload.
  it('carries the recruiter own state onto the synthesised row', () => {
    const [row] = buildBacklogSignals({
      contacts: [contact()],
      functions: FUNCTIONS,
      working: new Set(['c1']),
    })
    expect(row.status).toBe('working')
  })

  it('is still built when a signal lands at the same company', () => {
    // Same-company backlog rows are normally dropped as noise. In-flight work
    // is the exception: a card vanishing mid-day underneath the person using
    // it is the one unforgivable bug in a feed.
    const args = {
      contacts: [contact()],
      signals: [{ id: 's1', company_name: 'ADQ', status: 'new' }],
      functions: FUNCTIONS,
    }
    expect(buildBacklogSignals(args)).toHaveLength(0)
    expect(buildBacklogSignals({ ...args, working: new Set(['c1']) })).toHaveLength(1)
  })

  it('drops a parked person even while a stale Working flag is set', () => {
    const out = buildBacklogSignals({
      contacts: [contact({ backlog_parked_at: '2026-09-05T09:00:00Z' })],
      functions: FUNCTIONS,
      working: new Set(['c1']),
    })
    expect(out).toHaveLength(0)
  })
})

describe('backlogQueue — the rest of the network, counted', () => {
  // Never hide a lead. What today's set does not reach is deferred to
  // tomorrow, and the count has to be sayable out loud — "612 more in your
  // network" — or a short list reads as software holding something back.
  it('returns everyone eligible, with no cap at all', () => {
    const contacts = Array.from({ length: 40 }, (_, i) => contact({ id: `c${i}`, company: `Company ${i}` }))
    expect(backlogQueue({ contacts, functions: FUNCTIONS })).toHaveLength(40)
  })

  it('counts the same population the feed itself would show', () => {
    // A second, subtly different eligibility rule here would let the queue
    // report a number the list could never reach.
    const contacts = [
      contact({ id: 'ok', company: 'ADQ' }),
      contact({ id: 'junior', company: 'Aldar', seniority_band: 'below' }),
      contact({ id: 'rival', company: 'A Search Firm', is_competitor: true }),
      contact({ id: 'called', company: 'Mubadala', last_contacted: '2026-09-01T00:00:00Z' }),
      contact({ id: 'parked', company: 'NEOM', backlog_parked_at: '2026-09-01T00:00:00Z' }),
    ]
    expect(backlogQueue({ contacts, functions: FUNCTIONS }).map(e => e.contact.id)).toEqual(['ok'])
  })

  it('leaves out anyone already on screen', () => {
    const contacts = [contact({ id: 'shown' }), contact({ id: 'waiting', company: 'Aldar' })]
    const out = backlogQueue({ contacts, functions: FUNCTIONS, exclude: new Set(['shown']) })
    expect(out.map(e => e.contact.id)).toEqual(['waiting'])
  })
})

describe('isBacklogSignal', () => {
  it('identifies synthesised rows and nothing else', () => {
    expect(isBacklogSignal({ signal_type: BACKLOG_SIGNAL_TYPE })).toBe(true)
    expect(isBacklogSignal({ signal_type: 'funding' })).toBe(false)
    expect(isBacklogSignal(null)).toBe(false)
  })
})

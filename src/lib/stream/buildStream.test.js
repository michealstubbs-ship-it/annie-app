import { describe, it, expect } from 'vitest'
import { buildStream, scoreStreamItem, streamCounts, itemStateFromStatus, STATE_NEW, STATE_WORKING, STATE_PARKED } from './buildStream.js'
import { RUNG_SPOKEN, RUNG_COLD } from './wayIn.js'

const sig = (over = {}) => ({
  id: Math.random().toString(36).slice(2),
  company_name: 'Acme Ltd',
  signal_type: 'funding',
  headline: 'Raised a round',
  status: 'new',
  found_at: new Date().toISOString(),
  source_url: 'https://example.com/a',
  source_label: 'example.com',
  source_verified: true,
  ...over,
})

describe('buildStream — nothing is hidden for lacking a contact', () => {
  it('returns a lead with no contact at all, which the old contact gate deleted', () => {
    // This is the whole point of the rebuild. Measured over seven days:
    // 338 of 446 BD signals were researched, enriched, then never shown.
    const items = buildStream({ signals: [sig({ company_name: 'Aldar Properties' })], contacts: [], candidates: [] })
    expect(items).toHaveLength(1)
    expect(items[0].wayIn.rung).toBe(RUNG_COLD)
  })

  it('keeps news-type signals in the same stream rather than a separate surface', () => {
    const items = buildStream({ signals: [
      sig({ signal_type: 'regulatory', company_name: 'Aldar Properties' }),
      sig({ signal_type: 'funding', company_name: 'Acme Ltd' }),
    ] })
    expect(items).toHaveLength(2)
    expect(items.some(i => i.isNews)).toBe(true)
  })

  // Michael, 2026-09-05: "a live role at NEOM and a person you know at NEOM
  // are the same lead." Two rows about one company became one card once the
  // scan was scoped to the customer's own companies and they started landing
  // on the same account constantly. See companyContext.js.
  it('folds two things at the same company into one card', () => {
    const items = buildStream({ signals: [
      sig({ signal_type: 'regulatory', headline: 'Filed for a licence' }),
      sig({ signal_type: 'funding', headline: 'Raised a round' }),
    ] })
    expect(items).toHaveLength(1)
    expect(items[0].happening).toHaveLength(1)
  })

  it('gives every card its provenance line', () => {
    const items = buildStream({ signals: [sig()] })
    expect(items[0].provenance.label).toBeTruthy()
    expect(items[0].provenance.detail).toBeTruthy()
  })

  it('drops an actioned signal, because that is done rather than hidden', () => {
    expect(buildStream({ signals: [sig({ status: 'actioned' })] })).toHaveLength(0)
  })

  it('drops a live job at a body that does not employ anyone', () => {
    const items = buildStream({ signals: [sig({ signal_type: 'live_job', company_name: 'Dubai Marketing Meetup Group' })] })
    expect(items).toHaveLength(0)
  })

  it('carries the source on every item, always', () => {
    const items = buildStream({ signals: [sig()] })
    expect(items[0].source).toEqual({ url: 'https://example.com/a', label: 'example.com', checked: true })
  })

  it('reports an unverified source as unchecked, never as fake', () => {
    // source_verified false means "not checked". Two unchecked URLs opened by
    // hand on 2026-09-04 were real pages.
    const items = buildStream({ signals: [sig({ source_verified: false })] })
    expect(items[0].source.checked).toBe(false)
  })

  it('gives every item a LinkedIn route even with nothing else to go on', () => {
    const items = buildStream({ signals: [sig({ company_name: 'ALAS Emirates Ready Mix' })] })
    expect(items[0].linkedinRoute.url).toContain('linkedin.com')
    expect(items[0].linkedinRoute.approximate).toBe(true)
  })
})

describe('buildStream — ordering', () => {
  it('ranks a strong route in above a cold lead of the same type and age', () => {
    const warm = sig({ id: 'warm', company_name: 'Investcorp' })
    const cold = sig({ id: 'cold', company_name: 'Nobody Ltd' })
    const items = buildStream({
      signals: [cold, warm],
      contacts: [{ name: 'V', company: 'Investcorp', last_contacted: '2026-06-01' }],
    })
    expect(items[0].id).toBe('warm')
    expect(items[0].wayIn.rung).toBe(RUNG_SPOKEN)
  })

  it('floats work in progress to the top regardless of score', () => {
    const items = buildStream({
      signals: [
        sig({ id: 'strong', company_name: 'Investcorp', signal_type: 'funding' }),
        sig({ id: 'inprogress', company_name: 'Nobody Ltd', signal_type: 'regulatory', status: 'working' }),
      ],
      contacts: [{ name: 'V', company: 'Investcorp', last_contacted: '2026-06-01' }],
    })
    expect(items[0].id).toBe('inprogress')
  })

  it('sinks parked items without removing them', () => {
    const items = buildStream({
      signals: [sig({ id: 'parked', status: 'parked' }), sig({ id: 'live' })],
    })
    expect(items.map(i => i.id)).toEqual(['live', 'parked'])
    expect(items).toHaveLength(2)
  })

  it('does not cliff-edge an older lead out of existence the way the 21-day cutoff did', () => {
    const old = sig({ id: 'old', found_at: new Date(Date.now() - 45 * 86400000).toISOString() })
    const items = buildStream({ signals: [old] })
    expect(items).toHaveLength(1)
  })

  it('ranks a fresh lead above an otherwise identical old one', () => {
    const items = buildStream({
      signals: [
        sig({ id: 'old', found_at: new Date(Date.now() - 45 * 86400000).toISOString() }),
        sig({ id: 'fresh' }),
      ],
    })
    expect(items[0].id).toBe('fresh')
  })
})

// What customers park, pooled across customers as a fact about the EMPLOYER.
// The evidence is signal_outcomes, which had been written since 21 Aug 2026
// and read by nothing. See src/lib/employerSignal.js and
// supabase/migrations/20260905170000_parked_employer_signal.sql.
describe('buildStream — the pooled employer weight', () => {
  const parked = (parkedVoters, workedVoters = 0) =>
    new Map([['aldar properties', { parkedVoters, workedVoters }]])

  it('ranks an employer several customers gave up on below an identical one they did not', () => {
    const items = buildStream({
      signals: [
        sig({ id: 'unloved', company_name: 'Aldar Properties' }),
        sig({ id: 'ordinary', company_name: 'Investcorp' }),
      ],
      parkedEmployers: parked(6),
    })
    expect(items.map(i => i.id)).toEqual(['ordinary', 'unloved'])
  })

  it('never hides the lead it ranks down — Michael: a weight, not a ban', () => {
    // "A firm wrong for one recruiter may be right for a contingency recruiter
    // on smaller roles." Nothing in this feature may remove a card, and the
    // penalty floors the score at zero rather than driving it negative.
    const items = buildStream({
      signals: [sig({ id: 'unloved', company_name: 'Aldar Properties', signal_type: 'regulatory' })],
      parkedEmployers: parked(50),
    })
    expect(items).toHaveLength(1)
    expect(items[0].score).toBeGreaterThanOrEqual(0)
  })

  it('cannot push a lead you have a route into below one you do not', () => {
    // THE CAP IS THE ARGUMENT. RUNG_WEIGHT here is 0/12/25/40, so the smallest
    // gap between two rungs of the way-in ladder is 12, and the maximum
    // penalty is 10. A company twelve recruiters unanimously gave up on, where
    // this recruiter knows somebody, still outranks a stranger's company
    // nobody has an opinion about — because the relationship is the product
    // and the pooled opinion is a tie-breaker on top of it.
    const items = buildStream({
      signals: [
        // linked_contact_id only to clear the network gate — a signal at a
        // company outside the CRM is dropped before it can be ranked at all.
        sig({ id: 'cold-clean', company_name: 'Investcorp', linked_contact_id: 'ghost' }),
        sig({ id: 'known-unloved', company_name: 'Aldar Properties' }),
      ],
      contacts: [{ id: 'c1', name: 'V', company: 'Aldar Properties' }],
      parkedEmployers: parked(12),
    })
    expect(items.map(i => i.id)).toEqual(['known-unloved', 'cold-clean'])
  })

  it('does nothing below four distinct customers, so a thin pool cannot reorder anything', () => {
    const signals = [
      sig({ id: 'unloved', company_name: 'Aldar Properties' }),
      sig({ id: 'ordinary', company_name: 'Investcorp' }),
    ]
    const thin = buildStream({ signals, parkedEmployers: parked(3) })
    const none = buildStream({ signals })
    expect(thin.find(i => i.id === 'unloved').score).toBe(none.find(i => i.id === 'unloved').score)
  })

  it('scores identically to before when nothing is passed at all', () => {
    // The weight is a refinement of this ranking, not a second ranking. Every
    // other caller of buildStream and scoreStreamItem — and every test above
    // this one — must be untouched by it.
    const item = { signal: sig({ signal_type: 'funding' }), wayIn: { rung: RUNG_COLD } }
    expect(scoreStreamItem(item)).toBe(scoreStreamItem(item, { parkedEmployers: new Map() }))
  })

  it('subtracts the same amount from a 60/40 pool of ten as from one of ten thousand', () => {
    // The anti-narrowing property, at the point where it actually reaches the
    // ranking: the weight is the SHARE of customers who gave up, not how many
    // of them there were, so Annie does not get more suppressive simply by
    // getting more popular.
    const item = { signal: sig({ company_name: 'Aldar Properties' }), wayIn: { rung: RUNG_COLD } }
    const small = scoreStreamItem(item, { parkedEmployers: parked(6, 4) })
    const large = scoreStreamItem(item, { parkedEmployers: parked(6000, 4000) })
    expect(small).toBe(large)
    expect(small).toBeLessThan(scoreStreamItem(item))
  })

  it('says out loud why a card ranked lower, in customers rather than names', () => {
    // Same reason exclusionReason returns its reason instead of silently
    // dropping a contact: a ranking nobody can inspect reads as broken.
    const items = buildStream({
      signals: [sig({ company_name: 'Aldar Properties' })],
      parkedEmployers: parked(6, 1),
    })
    expect(items[0].employerSignal).toContain('6 recruiters')
    expect(items[0].employerSignal).not.toContain('Aldar')
  })

  it('leaves the explanation null on the overwhelming majority of cards, which have no pooled verdict', () => {
    const items = buildStream({ signals: [sig({ company_name: 'Investcorp' })], parkedEmployers: parked(9) })
    expect(items[0].employerSignal).toBeNull()
  })
})

describe('itemStateFromStatus', () => {
  it('treats new and seen alike — both are still waiting on the recruiter', () => {
    expect(itemStateFromStatus('new')).toBe(STATE_NEW)
    expect(itemStateFromStatus('seen')).toBe(STATE_NEW)
  })

  it('reads the two states the recruiter sets themselves', () => {
    expect(itemStateFromStatus('working')).toBe(STATE_WORKING)
    expect(itemStateFromStatus('parked')).toBe(STATE_PARKED)
  })
})

describe('streamCounts', () => {
  it('counts over the whole stream so switching a filter never moves the other numbers', () => {
    const items = buildStream({
      signals: [sig({ company_name: 'Investcorp' }), sig({ status: 'parked' }), sig({ status: 'working' })],
      contacts: [{ name: 'V', company: 'Investcorp', notes: 'spoke' }],
    })
    const counts = streamCounts(items)
    expect(counts.all).toBe(3)
    expect(counts.working).toBe(1)
    expect(counts.parked).toBe(1)
    expect(counts.withWayIn).toBe(1)
    expect(counts.cold).toBe(2)
  })
})

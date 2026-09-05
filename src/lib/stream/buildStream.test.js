import { describe, it, expect } from 'vitest'
import { buildStream, streamCounts, itemStateFromStatus, STATE_NEW, STATE_WORKING, STATE_PARKED } from './buildStream.js'
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

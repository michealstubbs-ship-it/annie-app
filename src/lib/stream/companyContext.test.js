import { describe, it, expect } from 'vitest'
import { attachCompanyContext } from './companyContext'
import { BACKLOG_SIGNAL_TYPE } from './backlogSignals'
import { STATE_NEW, STATE_WORKING, STATE_PARKED } from './buildStream'

function item(over = {}) {
  const { signal = {}, ...rest } = over
  return {
    id: signal.id || Math.random().toString(36).slice(2),
    signal: { company_name: 'NEOM', signal_type: 'live_job', found_at: '2026-09-01', ...signal },
    wayIn: { person: null },
    state: STATE_NEW,
    score: 10,
    source: { url: null, label: null, checked: false },
    isNews: false,
    ...rest,
  }
}

describe('attachCompanyContext', () => {
  it('makes one card per company, headed by the person you can call', () => {
    const out = attachCompanyContext([
      item({ signal: { id: 'job', headline: 'Head of Corporate Strategy' }, score: 20 }),
      item({ signal: { id: 'person', signal_type: BACKLOG_SIGNAL_TYPE, linked_contact_id: 'c1' }, score: 14 }),
      item({ signal: { id: 'news', signal_type: 'funding', headline: 'Raised $1bn' }, score: 18, isNews: true }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].signal.id).toBe('person')
    expect(out[0].happening.map(h => h.id).sort()).toEqual(['job', 'news'])
  })

  // Merging must never bury an account. The card is headed by the person, but
  // the funding round is why it is near the top.
  it('inherits the best score in the group', () => {
    const out = attachCompanyContext([
      item({ signal: { id: 'person', signal_type: BACKLOG_SIGNAL_TYPE, linked_contact_id: 'c1' }, score: 14 }),
      item({ signal: { id: 'funding', signal_type: 'funding' }, score: 31 }),
    ])
    expect(out[0].score).toBe(31)
  })

  it('leaves different companies alone', () => {
    const out = attachCompanyContext([
      item({ signal: { id: 'a', company_name: 'NEOM' } }),
      item({ signal: { id: 'b', company_name: 'ADQ' } }),
    ])
    expect(out).toHaveLength(2)
    expect(out.every(i => i.happening.length === 0)).toBe(true)
  })

  // Losing somebody's work is the one unforgivable bug in a feed.
  it('never folds away a card the recruiter is working or has parked', () => {
    const out = attachCompanyContext([
      item({ signal: { id: 'person', signal_type: BACKLOG_SIGNAL_TYPE, linked_contact_id: 'c1' }, score: 30 }),
      item({ signal: { id: 'working' }, state: STATE_WORKING, score: 5 }),
      item({ signal: { id: 'parked' }, state: STATE_PARKED, score: 5 }),
    ])
    expect(out.map(i => i.signal.id).sort()).toEqual(['parked', 'person', 'working'])
    expect(out[0].signal.id).toBe('working')
  })

  // A move is two leads by design — the seat someone vacated and the seat they
  // took. Neither is background to the other.
  it('keeps a job move as its own card', () => {
    const out = attachCompanyContext([
      item({ signal: { id: 'move', signal_type: 'leadership_change', linked_contact_id: 'c9' } }),
      item({ signal: { id: 'job' } }),
    ])
    expect(out).toHaveLength(2)
  })

  it('puts the newest thing first inside the card', () => {
    const out = attachCompanyContext([
      item({ signal: { id: 'person', signal_type: BACKLOG_SIGNAL_TYPE, linked_contact_id: 'c1' }, score: 40 }),
      item({ signal: { id: 'old', found_at: '2026-07-01' } }),
      item({ signal: { id: 'new', found_at: '2026-09-04' } }),
    ])
    expect(out[0].happening.map(h => h.id)).toEqual(['new', 'old'])
  })

  it('survives rows with no company at all', () => {
    const out = attachCompanyContext([item({ signal: { id: 'x', company_name: null } })])
    expect(out).toHaveLength(1)
    expect(out[0].happening).toEqual([])
  })

  it('gives every surviving item a happening array', () => {
    for (const i of attachCompanyContext([item(), item({ signal: { company_name: 'ADQ' } })])) {
      expect(Array.isArray(i.happening)).toBe(true)
    }
  })
})

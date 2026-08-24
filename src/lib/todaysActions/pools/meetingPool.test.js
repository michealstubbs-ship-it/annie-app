import { describe, it, expect } from 'vitest'
import { buildMeetingPool } from './meetingPool.js'

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe('buildMeetingPool', () => {
  it('excludes a deal not in the approached stage', () => {
    const deals = [{ id: 'd1', stage: 'won', updated_at: daysAgoIso(10) }]
    expect(buildMeetingPool(deals, [])).toEqual([])
  })

  it('excludes an approached deal touched too recently to chase', () => {
    const deals = [{ id: 'd1', stage: 'approached', updated_at: daysAgoIso(1) }]
    expect(buildMeetingPool(deals, [])).toEqual([])
  })

  it('includes an approached deal silent for 2+ days', () => {
    const deals = [{ id: 'd1', stage: 'approached', updated_at: daysAgoIso(5) }]
    expect(buildMeetingPool(deals, [])).toHaveLength(1)
  })

  it('prefers the linked contact\'s last_contacted over the deal\'s updated_at when present', () => {
    const contacts = [{ id: 'c1', status: 'warm', last_contacted: daysAgoIso(1) }]
    const deals = [{ id: 'd1', stage: 'approached', contact_id: 'c1', updated_at: daysAgoIso(30) }]
    // Linked contact was touched only 1 day ago — too soon, even though the deal's own updated_at is old
    expect(buildMeetingPool(deals, contacts)).toEqual([])
  })
})

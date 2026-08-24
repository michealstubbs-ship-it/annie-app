import { describe, it, expect } from 'vitest'
import { buildDormantPool } from './dormantPool.js'

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe('buildDormantPool', () => {
  it('excludes contacts contacted recently', () => {
    const contacts = [{ id: 1, status: 'warm', last_contacted: daysAgoIso(5) }]
    expect(buildDormantPool(contacts)).toEqual([])
  })

  it('includes a contact silent well past the dormant threshold', () => {
    const contacts = [{ id: 1, status: 'warm', company: 'Acme', last_contacted: daysAgoIso(90) }]
    const pool = buildDormantPool(contacts)
    expect(pool).toHaveLength(1)
    expect(pool[0].score).toBeGreaterThan(0)
  })

  it('excludes client and inactive statuses regardless of staleness', () => {
    const contacts = [
      { id: 1, status: 'client', last_contacted: daysAgoIso(400) },
      { id: 2, status: 'inactive', last_contacted: daysAgoIso(400) },
    ]
    expect(buildDormantPool(contacts)).toEqual([])
  })
})

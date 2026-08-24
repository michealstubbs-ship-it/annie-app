import { describe, it, expect } from 'vitest'
import { buildNewClientPool } from './newClientPool.js'

describe('buildNewClientPool', () => {
  it('excludes a hot/warm contact that already has an active deal', () => {
    const contacts = [{ id: 1, status: 'hot', company: 'Acme Ltd' }]
    const deals = [{ company: 'Acme Ltd', stage: 'approached' }]
    expect(buildNewClientPool(contacts, deals)).toEqual([])
  })

  it('includes a hot contact with no active deal', () => {
    const contacts = [{ id: 1, status: 'hot', company: 'Acme Ltd', last_contacted: new Date().toISOString() }]
    expect(buildNewClientPool(contacts, [])).toHaveLength(1)
  })

  it('excludes a contact whose deal is won/lost — no longer an active deal, so the contact is eligible again', () => {
    const contacts = [{ id: 1, status: 'hot', company: 'Acme Ltd' }]
    const deals = [{ company: 'Acme Ltd', stage: 'won' }]
    expect(buildNewClientPool(contacts, deals)).toHaveLength(1)
  })

  it('excludes a cold contact', () => {
    const contacts = [{ id: 1, status: 'cold', company: 'Acme Ltd' }]
    expect(buildNewClientPool(contacts, [])).toEqual([])
  })
})

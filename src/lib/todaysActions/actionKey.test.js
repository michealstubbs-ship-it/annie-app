import { describe, it, expect } from 'vitest'
import { actionKey } from './actionKey.js'

describe('actionKey', () => {
  it('returns null for an action with no stable identity', () => {
    expect(actionKey({ category: 'sourced' })).toBeNull()
  })

  it('prefers signalId over any other identity', () => {
    expect(actionKey({ signalId: 's1', contactId: 'c1', dealId: 'd1' })).toBe('signal:s1')
  })

  it('falls back to dealId, scoped by keyContext', () => {
    expect(actionKey({ dealId: 'd1', keyContext: '2026-01-01' })).toBe('meeting:deal:d1:2026-01-01')
  })

  it('falls back to contactId, scoped by category and keyContext', () => {
    expect(actionKey({ category: 'dormant', contactId: 'c1', keyContext: '2026-01-01' })).toBe('dormant:contact:c1:2026-01-01')
  })

  it('produces distinct keys for the same contact at two different dormancy occurrences', () => {
    const a = actionKey({ category: 'dormant', contactId: 'c1', keyContext: '2026-01-01' })
    const b = actionKey({ category: 'dormant', contactId: 'c1', keyContext: '2026-06-01' })
    expect(a).not.toBe(b)
  })
})

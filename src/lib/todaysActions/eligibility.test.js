import { describe, it, expect } from 'vitest'
import { BD_ACTION_SIGNAL_TYPES } from './eligibility.js'

describe('BD_ACTION_SIGNAL_TYPES', () => {
  it('is exactly leadership_change and live_job — the two types that reliably carry an actual name/role', () => {
    expect(BD_ACTION_SIGNAL_TYPES).toEqual(['leadership_change', 'live_job'])
  })

  it('deliberately excludes funding and expansion (multi-candidate fallback territory, not Today\'s Actions)', () => {
    expect(BD_ACTION_SIGNAL_TYPES).not.toContain('funding')
    expect(BD_ACTION_SIGNAL_TYPES).not.toContain('expansion')
  })
})

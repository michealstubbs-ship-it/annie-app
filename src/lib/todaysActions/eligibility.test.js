import { describe, it, expect } from 'vitest'
import { BD_ACTION_SIGNAL_TYPES } from './eligibility.js'

describe('BD_ACTION_SIGNAL_TYPES', () => {
  // 2026-08-27: restored to all four (funding, expansion, leadership_change,
  // live_job) — see eligibility.js's own header comment for why the
  // 2026-08-24 narrowing to just leadership_change/live_job was actually a
  // regression once funding/expansion signals started getting a real
  // multi-contact panel from verifyContactsAcrossFunctions.
  it('is exactly funding, expansion, leadership_change, and live_job', () => {
    expect(BD_ACTION_SIGNAL_TYPES).toEqual(['funding', 'expansion', 'leadership_change', 'live_job'])
  })

  it('excludes m_and_a, regulatory, and other non-BD-action signal types', () => {
    expect(BD_ACTION_SIGNAL_TYPES).not.toContain('m_and_a')
    expect(BD_ACTION_SIGNAL_TYPES).not.toContain('regulatory')
    expect(BD_ACTION_SIGNAL_TYPES).not.toContain('public_commentary')
    expect(BD_ACTION_SIGNAL_TYPES).not.toContain('hiring_activity')
  })
})

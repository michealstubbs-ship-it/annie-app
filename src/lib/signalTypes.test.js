// Regression coverage for the exact drift this file exists to prevent: the
// signal-type taxonomy used to live independently in scanShared.js,
// IntelligenceFeed.jsx, and actionsEngine.js, with nothing keeping them in
// sync (adding live_job this session went into one list but not another,
// purely because they were separate files). These tests pin the derived
// exports' shape so a future edit to SIGNAL_TYPE_META can't silently break
// the prompt's allowed-types list or the urgency logic.
import { describe, it, expect } from 'vitest'
import { SIGNAL_TYPE_META, SIGNAL_TYPES, RACY_SIGNAL_TYPES, NEWS_SIGNAL_TYPES } from './signalTypes.js'
import { BD_ACTION_SIGNAL_TYPES } from './actionsEngine.js'

describe('SIGNAL_TYPES (the AI prompt\'s allowed signalType values)', () => {
  it('excludes live_job — that type is forced in code from entryType, never left to the AI', () => {
    expect(SIGNAL_TYPES).not.toContain('live_job')
  })

  it('preserves the original, exact prompt ordering (interpolated directly into prompt text)', () => {
    expect(SIGNAL_TYPES).toEqual([
      'funding', 'leadership_change', 'hiring_activity', 'expansion', 'team_building',
      'public_commentary', 'job_posting_unclaimed', 'm_and_a', 'regulatory',
    ])
  })

  it('every entry has metadata (every prompt-eligible type is also renderable)', () => {
    for (const id of SIGNAL_TYPES) expect(SIGNAL_TYPE_META[id]).toBeTruthy()
  })
})

describe('RACY_SIGNAL_TYPES (time-sensitive treatment, shared by actionsEngine and IntelligenceFeed)', () => {
  it('matches exactly the types flagged racy in the metadata', () => {
    const expected = Object.entries(SIGNAL_TYPE_META).filter(([, m]) => m.racy).map(([id]) => id)
    expect(RACY_SIGNAL_TYPES.sort()).toEqual(expected.sort())
  })

  it('includes live_job — a real open role is the most time-sensitive lead type', () => {
    expect(RACY_SIGNAL_TYPES).toContain('live_job')
  })
})

describe('NEWS_SIGNAL_TYPES (Intelligence Feed\'s News tab, and what Today\'s Actions must never surface)', () => {
  it('is exactly M&A, regulatory, and public commentary', () => {
    expect(NEWS_SIGNAL_TYPES.sort()).toEqual(['m_and_a', 'public_commentary', 'regulatory'])
  })

  it('every entry has metadata (every News-tab type is also renderable)', () => {
    for (const id of NEWS_SIGNAL_TYPES) expect(SIGNAL_TYPE_META[id]).toBeTruthy()
  })

  it('shares no type with BD_ACTION_SIGNAL_TYPES — News and Today\'s BD Actions are mutually exclusive by construction', () => {
    for (const id of NEWS_SIGNAL_TYPES) expect(BD_ACTION_SIGNAL_TYPES).not.toContain(id)
  })
})

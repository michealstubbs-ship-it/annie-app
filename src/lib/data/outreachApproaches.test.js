import { describe, it, expect, vi, beforeEach } from 'vitest'

const { q, fromMock } = vi.hoisted(() => {
  const q = {}
  const fromMock = vi.fn(() => q)
  return { q, fromMock }
})
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listRecentApproaches } from './outreachApproaches.js'

let result
beforeEach(() => {
  vi.clearAllMocks()
  result = { data: [{ id: 'a1' }], error: null }
  q.select = vi.fn(() => q)
  q.eq = vi.fn(() => q)
  q.gte = vi.fn(() => q)
  q.order = vi.fn(() => q)
  q.limit = vi.fn(() => Promise.resolve(result))
})

describe('listRecentApproaches', () => {
  it('reads only this user rows, newest first', async () => {
    await listRecentApproaches('u1')
    expect(fromMock).toHaveBeenCalledWith('outreach_approaches')
    expect(q.eq).toHaveBeenCalledWith('user_id', 'u1')
    expect(q.order).toHaveBeenCalledWith('sent_at', { ascending: false })
  })

  it('never selects the subject line or anything else the readout does not need', async () => {
    // The readout counts and compares. It has no use for what was written, and
    // pulling the subject of every approach into the browser to render two
    // sentences would be data movement with no reader.
    await listRecentApproaches('u1')
    const columns = q.select.mock.calls[0][0]
    expect(columns).not.toContain('subject')
    for (const needed of ['sent_at', 'replied_at', 'seniority_band', 'known_at_company', 'company_name']) {
      expect(columns).toContain(needed)
    }
  })

  it('returns an empty list rather than throwing when the table is unreachable', async () => {
    // The migration that creates this table is deliberately not applied by the
    // change that added it, so on a database without it every read fails. The
    // feed must render exactly as it did before — the readout is an extra at
    // the top of the page, never a dependency of the page.
    result = { data: null, error: { message: 'relation "outreach_approaches" does not exist' } }
    expect(await listRecentApproaches('u1')).toEqual([])
  })

  it('does not query at all without a user', async () => {
    expect(await listRecentApproaches(null)).toEqual([])
    expect(fromMock).not.toHaveBeenCalled()
  })
})

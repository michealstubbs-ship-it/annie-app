import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
const { mockAlertIfConfigured } = vi.hoisted(() => ({ mockAlertIfConfigured: vi.fn().mockResolvedValue() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('../lib/scanShared.js', () => ({ alertIfConfigured: mockAlertIfConfigured, createTimeoutFetch: () => fetch }))

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  vi.resetModules()
  ;({ default: handler } = await import('../data-retention.js'))
})

function mockRpc(impl) {
  mockCreateClient.mockReturnValue({ rpc: impl })
}

describe('data retention', () => {
  it('calls all five cleanup RPCs, sharing one cutoff except chat_rate_limit, and reports counts', async () => {
    const calls = []
    mockRpc((name, args) => {
      calls.push([name, args])
      return Promise.resolve({ data: 3, error: null })
    })
    const res = await handler()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual({
      intelligence_signals: 3, chat_messages: 3, support_messages: 3, error_logs: 3, chat_rate_limit: 3,
    })
    expect(calls).toHaveLength(5)
    expect(calls.map(c => c[0])).toEqual([
      'retention_cleanup_intelligence_signals', 'retention_cleanup_chat_messages',
      'retention_cleanup_support_messages', 'retention_cleanup_error_logs',
      'retention_cleanup_chat_rate_limit',
    ])
    // The four historical-data tables share the exact same (18-month)
    // cutoff — not recomputed per table — while chat_rate_limit gets its
    // own, much shorter cutoff since it's a rate-limit bucket, not history.
    const historicalCutoffs = new Set(calls.slice(0, 4).map(c => c[1].p_cutoff))
    expect(historicalCutoffs.size).toBe(1)
    const rateLimitCutoff = calls[4][1].p_cutoff
    expect(rateLimitCutoff).not.toBe(calls[0][1].p_cutoff)
    expect(new Date(rateLimitCutoff).getTime()).toBeGreaterThan(new Date(calls[0][1].p_cutoff).getTime())
    expect(mockAlertIfConfigured).not.toHaveBeenCalled()
  })

  it('alerts and returns 500 if any single table cleanup fails, without skipping the others', async () => {
    mockRpc((name) => {
      if (name === 'retention_cleanup_chat_messages') return Promise.resolve({ data: null, error: { message: 'lock timeout' } })
      return Promise.resolve({ data: 1, error: null })
    })
    const res = await handler()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.results.chat_messages).toContain('lock timeout')
    expect(body.results.intelligence_signals).toBe(1)
    expect(mockAlertIfConfigured).toHaveBeenCalledWith(expect.stringContaining('chat_messages'))
  })

  it('no-ops cleanly when env vars are missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = await handler()
    expect(res.status).toBe(200)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})

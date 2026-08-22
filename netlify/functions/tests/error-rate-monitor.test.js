import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
const { mockAlertIfConfigured } = vi.hoisted(() => ({ mockAlertIfConfigured: vi.fn().mockResolvedValue() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('../lib/scanShared.js', () => ({ alertIfConfigured: mockAlertIfConfigured }))

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  vi.resetModules()
  ;({ default: handler } = await import('../error-rate-monitor.js'))
})

function mockCount(count, error = null) {
  mockCreateClient.mockReturnValue({
    from: () => ({ select: () => ({ gte: () => Promise.resolve({ count, error }) }) }),
  })
}

describe('error rate monitor', () => {
  it('does not alert when the error count is below the threshold', async () => {
    mockCount(3)
    const res = await handler()
    expect(res.status).toBe(200)
    expect(mockAlertIfConfigured).not.toHaveBeenCalled()
  })

  it('alerts when the error count reaches the spike threshold', async () => {
    mockCount(25)
    const res = await handler()
    expect(res.status).toBe(200)
    expect(mockAlertIfConfigured).toHaveBeenCalledWith(expect.stringContaining('25'))
  })

  it('returns 500 without alerting when the count query itself errors', async () => {
    mockCount(null, { message: 'db unreachable' })
    const res = await handler()
    expect(res.status).toBe(500)
    expect(mockAlertIfConfigured).not.toHaveBeenCalled()
  })

  it('no-ops cleanly when env vars are missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = await handler()
    expect(res.status).toBe(200)
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})

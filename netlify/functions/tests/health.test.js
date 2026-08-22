import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  vi.resetModules()
  ;({ default: handler } = await import('../health.js'))
})

describe('health check', () => {
  it('reports ok with a 200 when the database round-trip succeeds', async () => {
    mockCreateClient.mockReturnValue({
      from: () => ({ select: () => ({ limit: () => Promise.resolve({ error: null }) }) }),
    })
    const res = await handler()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'ok', checks: { database: 'ok' } })
  })

  it('reports degraded with a 503 when the database round-trip errors, without leaking the error body', async () => {
    mockCreateClient.mockReturnValue({
      from: () => ({ select: () => ({ limit: () => Promise.resolve({ error: { message: 'connection refused' } }) }) }),
    })
    const res = await handler()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toEqual({ status: 'degraded', checks: { database: 'error' } })
    expect(JSON.stringify(body)).not.toContain('connection refused')
  })

  it('reports not_configured when env vars are missing, rather than throwing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const res = await handler()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.checks.database).toBe('not_configured')
    expect(mockCreateClient).not.toHaveBeenCalled()
  })
})

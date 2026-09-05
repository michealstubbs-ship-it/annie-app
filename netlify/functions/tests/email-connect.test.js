import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => globalThis.__db) }))
vi.mock('../lib/auth.js', () => ({ getAuthedUser: vi.fn(async () => globalThis.__auth) }))
vi.mock('../lib/entitlements.js', () => ({ getEntitlements: vi.fn(async () => globalThis.__ent) }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: vi.fn(async () => {}) }))
vi.mock('../lib/unipile.js', () => ({
  unipileConfig: vi.fn(() => ({ configured: true, base: 'https://api1.unipile.com:13111', key: 'k' })),
  createHostedAuthLink: vi.fn(async () => globalThis.__link),
}))

const handler = (await import('../email-connect.js')).default

function db({ account = null } = {}) {
  const writes = []
  return {
    __writes: writes,
    from() {
      const q = {}
      q.select = () => q
      q.eq = () => q
      q.maybeSingle = () => Promise.resolve({ data: account, error: null })
      q.upsert = (row) => { writes.push(['upsert', row]); return Promise.resolve({ error: null }) }
      q.delete = () => ({ eq: () => ({ eq: () => { writes.push(['delete']); return Promise.resolve({ error: null }) } }) })
      return q
    },
  }
}

const req = (method, body) => new Request('https://app.meetannie.ai/api/email-connect', {
  method,
  headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
})

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = 'https://x.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  globalThis.__auth = { user: { id: 'u1' }, error: null }
  globalThis.__ent = { tier: 'growth', limits: { emailSync: true } }
  globalThis.__link = { ok: true, data: { url: 'https://account.unipile.com/hosted/abc' } }
  globalThis.__db = db()
})

describe('email-connect', () => {
  it('refuses an anonymous caller', async () => {
    globalThis.__auth = { user: null, error: new Error('no') }
    expect((await handler(req('GET'))).status).toBe(401)
  })

  it('tells Starter it is not available, without leaking a link', async () => {
    globalThis.__ent = { tier: 'starter', limits: { emailSync: false } }
    const resp = await handler(req('POST', {}))
    expect(resp.status).toBe(402)
    const body = await resp.json()
    expect(body.upgrade).toBe(true)
    expect(body.url).toBeUndefined()
  })

  it('reports availability on GET without starting anything', async () => {
    const body = await (await handler(req('GET'))).json()
    expect(body).toMatchObject({ available: true, tier: 'growth', configured: true })
    expect(globalThis.__db.__writes).toHaveLength(0)
  })

  it('returns a hosted link for Growth and records the attempt', async () => {
    const resp = await handler(req('POST', {}))
    expect(resp.status).toBe(200)
    const body = await resp.json()
    expect(body.url).toBe('https://account.unipile.com/hosted/abc')
    // recorded as connecting, so an abandoned consent screen is visible
    expect(globalThis.__db.__writes[0][1]).toMatchObject({ user_id: 'u1', status: 'connecting' })
  })

  it('surfaces a Unipile failure as a server error, not a broken link', async () => {
    globalThis.__link = { ok: false, error: 'errors/invalid_credentials' }
    expect((await handler(req('POST', {}))).status).toBe(502)
  })

  it('disconnects without deleting the notes already written', async () => {
    globalThis.__db = db({ account: { id: 'a1' } })
    const resp = await handler(req('DELETE'))
    expect(resp.status).toBe(200)
    expect(globalThis.__db.__writes).toContainEqual(['delete'])
  })
})

describe('email-connect returnTo', () => {
  // The connect link is built server-side from a path the page asks for. A
  // full URL taken from the body would make this an open redirect any page
  // could aim at its own domain, so only same-origin paths are honoured.
  async function linkFor(body) {
    const { createHostedAuthLink } = await import('../lib/unipile.js')
    createHostedAuthLink.mockClear()
    await handler(req('POST', body))
    return createHostedAuthLink.mock.calls[0]?.[1] || {}
  }

  it('comes back where the page asked', async () => {
    const args = await linkFor({ returnTo: '/dashboard?email=connected' })
    expect(args.successUrl).toBe('https://app.meetannie.ai/dashboard?email=connected')
  })

  it('refuses an absolute URL', async () => {
    const args = await linkFor({ returnTo: 'https://evil.example.com/steal' })
    expect(args.successUrl).toBe('https://app.meetannie.ai/settings?email=connected')
  })

  it('refuses a protocol-relative URL', async () => {
    const args = await linkFor({ returnTo: '//evil.example.com' })
    expect(args.successUrl).toBe('https://app.meetannie.ai/settings?email=connected')
  })

  it('falls back to Settings when nothing is asked for', async () => {
    const args = await linkFor({})
    expect(args.successUrl).toBe('https://app.meetannie.ai/settings?email=connected')
  })
})

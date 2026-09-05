import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => globalThis.__db) }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: vi.fn(async () => {}) }))
vi.mock('../lib/unipile.js', () => ({
  unipileConfig: vi.fn(() => ({ configured: true, base: 'b', key: 'k' })),
  getAccount: vi.fn(async () => globalThis.__account),
  listEmails: vi.fn(async () => globalThis.__list),
}))
vi.mock('../lib/emailIngest.js', () => ({
  ingestBatch: vi.fn(async (_db, ctx) => {
    globalThis.__ingested = ctx
    return { read: ctx.messages.length, created: 1, skipped: 0, noted: 1, companies: ['Limad'] }
  }),
}))
vi.mock('../lib/aiUsage.js', () => ({
  reserveAnthropicTokens: vi.fn(async () => ({ ok: true })),
  reconcileAnthropicTokens: vi.fn(async () => ({})),
  anthropicBilledTokens: vi.fn(() => 100),
}))

const handler = (await import('../email-webhook.js')).default

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
      q.update = (patch) => ({ eq: () => { writes.push(['update', patch]); return Promise.resolve({ error: null }) } })
      q.delete = () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) })
      return q
    },
  }
}

const post = (body, headers = {}) => new Request('https://app.meetannie.ai/api/email-webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = 'https://x.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  delete process.env.UNIPILE_WEBHOOK_SECRET
  globalThis.__db = db()
  globalThis.__ingested = null
  globalThis.__list = { ok: true, data: { items: [] } }
  globalThis.__account = { ok: true, data: { type: 'GOOGLE', connection_params: { mail: { username: 'M@Vantage.me' } } } }
})

describe('email-webhook', () => {
  it('rejects a caller without the shared secret', async () => {
    process.env.UNIPILE_WEBHOOK_SECRET = 's3cret'
    expect((await handler(post({ account_id: 'a' }))).status).toBe(403)
    expect((await handler(post({ account_id: 'a' }, { 'x-annie-webhook-secret': 'wrong' }))).status).toBe(403)
  })

  it('accepts the caller when the secret matches', async () => {
    process.env.UNIPILE_WEBHOOK_SECRET = 's3cret'
    const resp = await handler(post({ account_id: 'a' }, { 'x-annie-webhook-secret': 's3cret' }))
    expect(resp.status).toBe(200)
  })

  it('records a newly connected mailbox against the user from the link, not the payload', async () => {
    const resp = await handler(post({ status: 'CREATION_SUCCESS', account_id: 'uni-1', name: 'u1' }))
    expect(resp.status).toBe(200)
    const upsert = globalThis.__db.__writes.find(w => w[0] === 'upsert')[1]
    expect(upsert).toMatchObject({
      user_id: 'u1', unipile_account_id: 'uni-1', email_address: 'm@vantage.me', status: 'connected',
    })
  })

  it('ignores mail for an account it has never seen', async () => {
    // A webhook body cannot name the tenant it wants written to: the account id
    // is looked up in our own table, and an unknown one does nothing at all.
    const body = await (await handler(post({ account_id: 'someone-elses', email: { id: 'm1' } }))).json()
    expect(body.ignored).toBe('unknown_account')
    expect(globalThis.__ingested).toBeNull()
  })

  it('ingests against the owning user of the account', async () => {
    globalThis.__db = db({ account: { id: 'a1', user_id: 'u7', email_address: 'm@v.me', status: 'connected' } })
    await handler(post({ account_id: 'uni-1', email: { id: 'm1', subject: 'Hello' } }))
    expect(globalThis.__ingested.userId).toBe('u7')
    expect(globalThis.__ingested.messages).toHaveLength(1)
  })

  it('does nothing for a disconnected mailbox', async () => {
    globalThis.__db = db({ account: { id: 'a1', user_id: 'u7', status: 'disconnected' } })
    const body = await (await handler(post({ account_id: 'uni-1', email: { id: 'm1' } }))).json()
    expect(body.ignored).toBe('not_connected')
  })

  it('always answers 200, so a failure is not retried into a storm', async () => {
    globalThis.__db = { from() { throw new Error('database on fire') } }
    const resp = await handler(post({ account_id: 'uni-1' }))
    expect(resp.status).toBe(200)
    expect((await resp.json()).error).toBe(true)
  })

  it('shrugs off an unparseable body', async () => {
    const resp = await handler(new Request('https://app.meetannie.ai/api/email-webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json',
    }))
    expect(resp.status).toBe(200)
  })
})

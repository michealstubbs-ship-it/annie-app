import { describe, it, expect, vi, beforeEach } from 'vitest'

// The send endpoint had no test before the outreach loop was added to it. It
// gets one now for a specific reason: this is the ONLY place an approach is
// recorded, and everything the customer is later told about which approaches
// worked rests on this handler doing it — and on it never, under any
// circumstance, letting that bookkeeping change whether mail goes out.

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => globalThis.__db) }))
vi.mock('../lib/auth.js', () => ({ getAuthedUser: vi.fn(async () => globalThis.__auth) }))
vi.mock('../lib/entitlements.js', () => ({ getEntitlements: vi.fn(async () => globalThis.__ent) }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: vi.fn(async () => {}) }))
vi.mock('../lib/unipile.js', () => ({
  unipileConfig: vi.fn(() => ({ configured: true, base: 'https://api1.unipile.com:13111', key: 'k' })),
  sendEmail: vi.fn(async (...args) => globalThis.__send(...args)),
  listEmails: vi.fn(async () => ({ ok: true, data: { items: [] } })),
}))
vi.mock('../lib/emailIngest.js', () => ({
  ingestMessage: vi.fn(async () => globalThis.__ingest()),
}))
vi.mock('../lib/outreachApproach.js', () => ({
  recordApproach: vi.fn(async (_db, args) => { globalThis.__approaches.push(args); return { recorded: true } }),
}))

const handler = (await import('../email-send.js')).default
const { sendEmail } = await import('../lib/unipile.js')
const { recordApproach } = await import('../lib/outreachApproach.js')

const ACCOUNT = {
  id: 'acct-1', user_id: 'u1',
  email_address: 'mstubbs@vantagesearchgroup.me',
  unipile_account_id: 'up-1', status: 'connected',
}

function db({ signal = null } = {}) {
  return {
    from(table) {
      const q = {}
      q.select = () => q
      q.eq = () => q
      q.maybeSingle = () => Promise.resolve({
        data: table === 'email_accounts' ? ACCOUNT : table === 'intelligence_signals' ? signal : null,
        error: null,
      })
      return q
    },
  }
}

const req = (body) => new Request('https://app.meetannie.ai/api/email-send', {
  method: 'POST',
  headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const BODY = {
  to: 'balkhalaf@al-akaria.com',
  subject: 'Al Akaria — hiring',
  body: 'Hello Bayan,\n\nMichael',
  signalId: 'sig-1',
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://x.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  delete process.env.ANTHROPIC_API_KEY
  globalThis.__auth = { user: { id: 'u1' }, error: null }
  globalThis.__ent = { tier: 'growth', limits: { emailSync: true } }
  globalThis.__send = async () => ({ ok: true, data: { id: 'msg-1' } })
  globalThis.__ingest = async () => ({
    ledgerId: 'ledger-1', contactId: 'k-bayan', companyId: 'c-akaria', companyName: 'Alakaria', noted: true,
  })
  globalThis.__approaches = []
  globalThis.__db = db({ signal: { id: 'sig-1', signal_type: 'expansion', company_name: 'Al Akaria' } })
})

describe('email-send — the guards that already existed', () => {
  it('refuses an anonymous caller', async () => {
    globalThis.__auth = { user: null, error: new Error('no') }
    expect((await handler(req(BODY))).status).toBe(401)
  })

  it('refuses anything but POST', async () => {
    const resp = await handler(new Request('https://app.meetannie.ai/api/email-send', { method: 'GET' }))
    expect(resp.status).toBe(405)
  })

  it('does not send to a missing or malformed address', async () => {
    expect((await handler(req({ ...BODY, to: 'not-an-address' }))).status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe('email-send — recording the approach', () => {
  it('records it against the lead and the contact, not just the address', async () => {
    const resp = await handler(req(BODY))
    expect(resp.status).toBe(200)
    expect(globalThis.__approaches).toHaveLength(1)
    expect(globalThis.__approaches[0]).toMatchObject({
      userId: 'u1',
      signalId: 'sig-1',
      signalType: 'expansion',
      contactId: 'k-bayan',
      toEmail: 'balkhalaf@al-akaria.com',
      emailMessageId: 'ledger-1',
    })
  })

  it('uses the company name from the card, not the one derived from the domain', async () => {
    // "Alakaria" is what companyNameFromDomain produces for al-akaria.com —
    // deliberately dull, and fine inside the CRM. The readout quotes this name
    // back to the customer, so it has to be the one on the card they clicked.
    await handler(req(BODY))
    expect(globalThis.__approaches[0].companyName).toBe('Al Akaria')
  })

  it('will not attach a lead belonging to someone else', async () => {
    // A request body cannot name a lead it does not own — the same rule
    // email-webhook.js applies to the account id. The lookup is scoped to the
    // caller, so a foreign id simply yields no signal.
    globalThis.__db = db({ signal: null })
    const resp = await handler(req({ ...BODY, signalId: 'someone-elses-signal' }))
    expect(resp.status).toBe(200)
    expect(globalThis.__approaches[0]).toMatchObject({ signalId: null, signalType: null })
  })

  it('sends fine with no lead at all', async () => {
    globalThis.__db = db({ signal: null })
    const resp = await handler(req({ ...BODY, signalId: undefined }))
    expect(resp.status).toBe(200)
    expect(globalThis.__approaches[0].signalId).toBeNull()
  })

  it('still reports success when the approach cannot be recorded', async () => {
    // The mail has already left the recruiter's mailbox by this point. A user
    // shown an error will send the message a second time, and a duplicate
    // approach to a C-suite prospect is a real harm; a missing row in a
    // readout is not.
    recordApproach.mockRejectedValueOnce(new Error('relation does not exist'))
    const resp = await handler(req(BODY))
    expect(resp.status).toBe(200)
    expect(await resp.json()).toMatchObject({ sent: true })
  })

  it('records nothing when the send itself failed', async () => {
    // An approach is a record of something that happened. Nothing happened.
    globalThis.__send = async () => ({ ok: false, error: 'smtp_rejected' })
    const resp = await handler(req(BODY))
    expect(resp.status).toBe(502)
    expect(globalThis.__approaches).toHaveLength(0)
  })
})

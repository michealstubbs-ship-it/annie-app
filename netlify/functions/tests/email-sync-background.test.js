import { describe, it, expect, vi, beforeEach } from 'vitest'

// Only the network and the error reporter are faked. The sweep, the promotion
// rule, the contact matching and the interaction store are all the real
// modules, running against a fake Supabase — because what this file is
// asserting is how those pieces fit together across an interrupted run, and a
// mock of the thing under test would prove nothing about that.
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => globalThis.__db.supabase) }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: vi.fn(async () => {}) }))
vi.mock('../lib/unipile.js', () => ({
  unipileConfig: vi.fn(() => ({ configured: true, base: 'https://api.unipile.test', key: 'k' })),
  listEmails: vi.fn(async (_cfg, args) => {
    globalThis.__listCalls.push(args)
    const queue = globalThis.__pages[args.role] || []
    const index = globalThis.__cursorIndex(args.role, args.cursor)
    return queue[index] || { ok: true, data: { items: [], cursor: null } }
  }),
}))

// The cost guarantee, watched from the outside. If the backfill ever reached
// the note writer or reserved an AI token, these spies would see it.
const writeNote = vi.fn(async () => ({ note: 'should never happen', model: 'claude' }))
vi.mock('../lib/emailNote.js', () => ({
  writeNote: (...args) => writeNote(...args),
  autoReplyNote: () => 'Out of office',
}))
const reserveAnthropicTokens = vi.fn(async () => ({ ok: true }))
vi.mock('../lib/aiUsage.js', () => ({
  reserveAnthropicTokens: (...a) => reserveAnthropicTokens(...a),
  reconcileAnthropicTokens: vi.fn(async () => ({})),
  anthropicBilledTokens: vi.fn(() => 0),
}))

const { listEmails } = await import('../lib/unipile.js')
const handler = (await import('../email-sync-background.js')).default

const ME = 'mstubbs@vantagesearchgroup.me'

function makeDb({ accounts = [], contacts = [], companies = [], enrichment = [], interactions = [] } = {}) {
  const db = {
    email_accounts: accounts.map(a => ({ ...a })),
    contacts: contacts.map(c => ({ ...c })),
    companies: companies.map(c => ({ ...c })),
    company_enrichment: enrichment.map(c => ({ ...c })),
    email_interactions: interactions.map(c => ({ ...c })),
    email_messages: [],
    outreach_approaches: [],
    team_members: [],
  }
  const accountPatches = []
  let seq = 0

  function from(table) {
    const q = { rows: db[table] ? db[table].slice() : [] }
    q.select = () => q
    q.eq = (col, val) => { q.rows = q.rows.filter(r => r[col] === val); return q }
    q.is = (col, val) => {
      q.rows = q.rows.filter(r => (val === null ? r[col] == null : r[col] === val))
      return q
    }
    q.gt = (col, val) => { q.rows = q.rows.filter(r => Number(r[col] || 0) > val); return q }
    q.in = (col, vals) => { q.rows = q.rows.filter(r => vals.includes(r[col])); return q }
    q.ilike = (col, val) => {
      const n = String(val).toLowerCase()
      q.rows = q.rows.filter(r => String(r[col] ?? '').toLowerCase() === n)
      return q
    }
    q.limit = (n) => { q.rows = q.rows.slice(0, n); return q }
    q.range = (a, b) => { q.rows = q.rows.slice(a, b + 1); return q }
    q.maybeSingle = () => Promise.resolve({ data: q.rows[0] || null, error: null })
    q.single = () => Promise.resolve({ data: q.rows[0] || null, error: null })
    q.then = (res) => Promise.resolve({ data: q.rows, error: null }).then(res)

    q.insert = (row) => {
      const made = { id: `${table}-${++seq}`, ...row }
      db[table].push(made)
      return { select: () => ({ single: () => Promise.resolve({ data: made, error: null }) }) }
    }
    q.upsert = (rows) => {
      for (const row of Array.isArray(rows) ? rows : [rows]) {
        const hit = db[table].find(r =>
          r.account_id === row.account_id && r.counterparty_email === row.counterparty_email)
        if (hit) Object.assign(hit, row)
        else db[table].push({ id: `${table}-${++seq}`, ...row })
      }
      return Promise.resolve({ error: null })
    }
    q.update = (patch) => ({
      eq: (col, val) => {
        if (table === 'email_accounts') accountPatches.push(patch)
        for (const r of db[table]) if (r[col] === val) Object.assign(r, patch)
        return Promise.resolve({ error: null })
      },
    })
    return q
  }

  return { supabase: { from }, db, accountPatches }
}

const ACCOUNT = {
  id: 'acct-1',
  user_id: 'u1',
  email_address: ME,
  unipile_account_id: 'uni-1',
  status: 'connected',
  backfill_done: false,
  backfill_cursor: null,
  sweep_role: null,
  sweep_after: null,
  sweep_pages: 0,
  sweep_messages: 0,
}

function sent(to, name, at = '2026-01-10T09:00:00.000Z') {
  return {
    id: `s-${to}-${at}`, date: at, subject: 'Re: Recruitment',
    from_attendee: { identifier: ME, display_name: 'Michael Stubbs' },
    to_attendees: [{ identifier: to, display_name: name }],
  }
}
function received(from, name, at = '2026-01-12T09:00:00.000Z', extra = {}) {
  return {
    id: `r-${from}-${at}`, date: at, subject: 'Re: Recruitment',
    from_attendee: { identifier: from, display_name: name },
    to_attendees: [{ identifier: ME }],
    ...extra,
  }
}

const page = (items, cursor = null) => ({ ok: true, data: { items, cursor } })

const post = (body = {}) => new Request('https://app.meetannie.ai/api/email-sync-background', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = 'https://x.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-be-used-by-the-backfill'
  writeNote.mockClear()
  reserveAnthropicTokens.mockClear()
  listEmails.mockClear()
  globalThis.__listCalls = []
  globalThis.__pages = { sent: [], inbox: [] }
  // Pages are served in order; a cursor of "p<n>" means "give me page n".
  globalThis.__cursorIndex = (role, cursor) => (cursor ? Number(String(cursor).replace('p', '')) : 0)
  globalThis.__fetches = []
  globalThis.fetch = vi.fn(async (url, init) => {
    globalThis.__fetches.push({ url: String(url), init })
    return new Response('{}', { status: 200 })
  })
  globalThis.__db = makeDb({ accounts: [ACCOUNT] })
})

describe('email-sync-background — the 18-month backfill', () => {
  it('asks for metadata only, at the largest page size, bounded to 18 months', async () => {
    // Three numbers, and each one is load-bearing.
    //
    // meta_only    no bodies come back, so there is literally nothing for the
    //              note writer to summarise. This is the cost guarantee at the
    //              wire level rather than the code level.
    // limit 250    a 12,000-sent / 40,000-received mailbox is 52,000 messages,
    //              which is ~208 requests at 250 a page and 1,040 at the old
    //              page size of 50.
    // after        18 months, so what a customer gets is a period rather than
    //              whatever 600 messages happened to cover.
    globalThis.__pages.sent = [page([sent('malmakheeti@limad.com', 'Muna Almakheeti')])]
    await handler(post({ accountId: 'acct-1' }))

    const first = globalThis.__listCalls[0]
    expect(first).toMatchObject({ metaOnly: true, limit: 250, role: 'sent', accountId: 'uni-1' })

    const after = new Date(first.after)
    const monthsBack = (Date.now() - after.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
    expect(monthsBack).toBeGreaterThan(17.5)
    expect(monthsBack).toBeLessThan(18.5)
  })

  it('spends nothing on AI — no note, no token reservation, no request to Anthropic', async () => {
    // THE core cost guarantee, and the entire reason this design replaced the
    // obvious one. The rejected version read bodies and called writeNote() on
    // every matched message; extended to 18 months that is on the order of ten
    // thousand model calls on the day somebody signs up. Asserted here rather
    // than trusted, because it is the kind of promise a single convenient
    // import would quietly break.
    globalThis.__pages.sent = [page([
      sent('malmakheeti@limad.com', 'Muna Almakheeti'),
      sent('balkhalaf@al-akaria.com', 'Bayan AlKhalaf'),
    ])]
    globalThis.__pages.inbox = [page([
      received('balkhalaf@al-akaria.com', 'Bayan AlKhalaf'),
    ])]

    await handler(post({ accountId: 'acct-1' }))

    expect(writeNote).not.toHaveBeenCalled()
    expect(reserveAnthropicTokens).not.toHaveBeenCalled()
    expect(globalThis.__fetches.some(f => f.url.includes('anthropic'))).toBe(false)
    // And nothing wrote a note onto a contact by another route either.
    for (const contact of globalThis.__db.db.contacts) expect(contact.notes).toBeFalsy()
  })

  it('promotes only the person who wrote back', async () => {
    // The rule, end to end through the real handler. Bayan replied. Muna never
    // did — one-way outbound is a pitch nobody answered. The newsletter is
    // one-way inbound. Only Bayan is a contact; the other two stay as
    // background interaction data and are never written into contacts.
    globalThis.__pages.sent = [page([
      sent('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2025-06-01T09:00:00.000Z'),
      sent('malmakheeti@limad.com', 'Muna Almakheeti', '2025-07-01T09:00:00.000Z'),
    ])]
    globalThis.__pages.inbox = [page([
      received('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2026-02-11T09:00:00.000Z'),
      received('editor@thebriefing.io', 'The Briefing', '2026-03-01T09:00:00.000Z'),
    ])]

    await handler(post({ accountId: 'acct-1' }))
    const { contacts, email_interactions: interactions } = globalThis.__db.db

    expect(contacts.map(c => c.email)).toEqual(['balkhalaf@al-akaria.com'])
    expect(contacts[0]).toMatchObject({
      relationship_tier: 'client',
      messages_sent: 1,
      messages_received: 1,
      first_exchange_at: '2025-06-01T09:00:00.000Z',
      last_exchange_at: '2026-02-11T09:00:00.000Z',
    })
    // All three are on record. Nothing is thrown away — a one-way address that
    // replies next month becomes two-way and gets promoted then.
    expect(interactions.map(r => r.counterparty_email).sort()).toEqual([
      'balkhalaf@al-akaria.com', 'editor@thebriefing.io', 'malmakheeti@limad.com',
    ])
  })

  it('files a free-mail correspondent with no company, and counts them', async () => {
    // Michael's candidates live on gmail. They pass the two-way test, so they
    // are contacts — "anyone you and they both sent to each other", his words.
    // What they do not get is an employer: gmail.com is not where anybody
    // works, and a company invented from it would enter the watchlist and be
    // searched for leadership changes. The count says how much of the filed
    // network sits in that state and therefore produces no company signals.
    globalThis.__pages.sent = [page([
      sent('shuaa.ms@gmail.com', 'Shuaa Al Harbi'),
      sent('a.candidate@hotmail.co.uk', 'A Candidate'),
    ])]
    globalThis.__pages.inbox = [page([
      received('shuaa.ms@gmail.com', 'Shuaa Al Harbi'),
      received('a.candidate@hotmail.co.uk', 'A Candidate'),
    ])]

    await handler(post({ accountId: 'acct-1' }))
    const account = globalThis.__db.db.email_accounts[0]

    expect(globalThis.__db.db.contacts).toHaveLength(2)
    expect(globalThis.__db.db.contacts.every(c => !c.company)).toBe(true)
    expect(globalThis.__db.db.companies || []).toHaveLength(0)
    expect(account.sweep_stats).toMatchObject({ freeMailTwoWay: 2, promotable: 2, people: 2 })
  })

  it('does not let an out-of-office make a one-way blast look two-way', async () => {
    // Hannah Wild's auto-responder arrived 40 seconds after Michael's mail. The
    // whole promotion rule rests on a reply meaning a human chose to answer, so
    // this is the case that decides whether the rule means anything.
    globalThis.__pages.sent = [page([sent('hwild@adcouncil.ae', 'Hannah Wild', '2026-09-03T05:24:00.000Z')])]
    globalThis.__pages.inbox = [page([
      received('hwild@adcouncil.ae', 'Hannah Wild', '2026-09-03T05:24:40.000Z', {
        subject: 'Automatic reply: Follow up to call',
      }),
    ])]

    await handler(post({ accountId: 'acct-1' }))
    expect(globalThis.__db.db.contacts).toHaveLength(0)
    expect(globalThis.__db.db.email_interactions[0]).toMatchObject({
      messages_sent: 1, messages_received: 0, auto_replies: 1,
    })
  })

  it('decides promotion only after BOTH passes, not as it goes', async () => {
    // During the sent pass every counterparty looks one-way by construction —
    // their replies are in the inbox pass that has not run yet. A design that
    // decided per page would promote nobody, ever, and never reconsider.
    globalThis.__pages.sent = [page([sent('balkhalaf@al-akaria.com', 'Bayan AlKhalaf')])]
    globalThis.__pages.inbox = [page([received('balkhalaf@al-akaria.com', 'Bayan AlKhalaf')])]

    await handler(post({ accountId: 'acct-1' }))
    const roles = globalThis.__listCalls.map(c => c.role)
    expect(roles.slice(0, 2)).toEqual(['sent', 'inbox'])
    expect(globalThis.__db.db.contacts).toHaveLength(1)
  })

  it('pages on the cursor and stops when the provider stops handing one back', async () => {
    globalThis.__pages.sent = [
      page([sent('a@corp.com', 'A One')], 'p1'),
      page([sent('b@corp.com', 'B Two')], 'p2'),
      page([sent('c@corp.com', 'C Three')], null),
    ]
    await handler(post({ accountId: 'acct-1' }))
    const sentCalls = globalThis.__listCalls.filter(c => c.role === 'sent')
    expect(sentCalls.map(c => c.cursor)).toEqual([null, 'p1', 'p2'])
    expect(globalThis.__db.db.email_interactions).toHaveLength(3)
  })

  it('stops instead of looping when a cursor repeats itself', async () => {
    // Nobody has ever connected a real mailbox to this product, so the paging
    // contract is documented rather than observed. A cursor that never advances
    // would otherwise burn the whole 15-minute budget on the same 250 messages.
    globalThis.__pages.sent = [
      page([sent('a@corp.com', 'A One')], 'p0'),
      page([sent('b@corp.com', 'B Two')], 'p0'),
    ]
    await handler(post({ accountId: 'acct-1' }))
    // Two calls: the first page, then the one that hands back a cursor already
    // seen. Without the guard this fixture pages over the same 250 messages
    // until the function is killed.
    expect(globalThis.__listCalls.filter(c => c.role === 'sent')).toHaveLength(2)
  })

  it('survives a page whose shape is nothing like the fixture', async () => {
    globalThis.__pages.sent = [
      { ok: true, data: { items: 'not an array', cursor: { token: 'weird' } } },
    ]
    const resp = await handler(post({ accountId: 'acct-1' }))
    expect(resp.status).toBe(200)
    expect(globalThis.__db.db.email_accounts[0].backfill_done).toBe(true)
  })
})

describe('email-sync-background — resuming', () => {
  it('records the phase and cursor after every page, so a killed run loses one page at most', async () => {
    globalThis.__pages.sent = [page([sent('a@corp.com', 'A One')], 'p1'), page([sent('b@corp.com', 'B Two')], null)]
    await handler(post({ accountId: 'acct-1' }))

    const cursorWrites = globalThis.__db.accountPatches.filter(p => 'backfill_cursor' in p && 'sweep_role' in p)
    expect(cursorWrites.length).toBeGreaterThanOrEqual(2)
    expect(cursorWrites[0]).toMatchObject({ sweep_role: 'sent', backfill_cursor: 'p1' })
  })

  it('picks up mid-mailbox instead of starting the 208 requests again', async () => {
    // The reason this exists: a 15-minute background function will not finish a
    // 52,000-message mailbox in one go, and the old sweep's answer was to stop
    // after 12 pages and mark itself done. Resuming is what lets a big mailbox
    // COMPLETE across runs rather than silently truncate.
    globalThis.__db = makeDb({
      accounts: [{
        ...ACCOUNT,
        sweep_role: 'inbox',
        backfill_cursor: 'p1',
        sweep_after: '2025-03-05T10:00:00.000Z',
        sweep_pages: 40,
        sweep_messages: 10000,
      }],
      interactions: [{
        id: 'int-1', user_id: 'u1', account_id: 'acct-1',
        counterparty_email: 'balkhalaf@al-akaria.com',
        counterparty_domain: 'al-akaria.com', counterparty_name: 'Bayan AlKhalaf',
        kind: 'person', messages_sent: 3, messages_received: 0, auto_replies: 0,
        first_exchange_at: '2025-06-01T09:00:00.000Z', last_exchange_at: '2025-06-01T09:00:00.000Z',
        decided_at: null,
      }],
    })
    globalThis.__pages.inbox = [
      page([], 'p1'),
      page([received('balkhalaf@al-akaria.com', 'Bayan AlKhalaf', '2026-02-11T09:00:00.000Z')], null),
    ]

    await handler(post({ accountId: 'acct-1' }))

    // The sent pass is not re-read, and the inbox pass starts from the stored
    // cursor rather than the top.
    expect(globalThis.__listCalls.map(c => c.role)).toEqual(['inbox'])
    expect(globalThis.__listCalls[0]).toMatchObject({ cursor: 'p1', after: '2025-03-05T10:00:00.000Z' })
    // The reply from this run plus the three sends from the last one is a
    // two-way exchange, and the whole point of merging rather than replacing.
    expect(globalThis.__db.db.contacts[0]).toMatchObject({
      email: 'balkhalaf@al-akaria.com', messages_sent: 3, messages_received: 1, relationship_tier: 'client',
    })
    expect(globalThis.__db.db.email_accounts[0].sweep_pages).toBe(41)
  })

  it('reuses the pinned window rather than recomputing it per run', async () => {
    // Recomputing "18 months ago" on every invocation would slide the window
    // forward between runs and leave a gap at the far end that nobody would
    // ever notice.
    globalThis.__db = makeDb({
      accounts: [{ ...ACCOUNT, sweep_after: '2024-01-01T00:00:00.000Z' }],
    })
    await handler(post({ accountId: 'acct-1' }))
    expect(globalThis.__listCalls.every(c => c.after === '2024-01-01T00:00:00.000Z')).toBe(true)
  })

  it('leaves the sweep unfinished and re-invokes itself when the provider fails mid-run', async () => {
    globalThis.__pages.sent = [
      page([sent('a@corp.com', 'A One')], 'p1'),
      { ok: false, status: 500, error: 'upstream_unavailable', data: null },
    ]
    const body = await (await handler(post({ accountId: 'acct-1' }))).json()

    expect(globalThis.__db.db.email_accounts[0].backfill_done).toBe(false)
    expect(globalThis.__db.db.email_accounts[0].last_error).toBe('upstream_unavailable')
    expect(body.resuming).toBe(1)
    expect(globalThis.__fetches[0].url).toContain('/api/email-sync-background')
    expect(JSON.parse(globalThis.__fetches[0].init.body)).toMatchObject({ accountId: 'acct-1', resume: true })
  })

  it('does NOT re-invoke itself when the run made no progress at all', async () => {
    // A persistent failure must stop, not re-trigger itself forever. The first
    // page failing means nothing was read, so there is nothing to resume from
    // and a retry would just be the same call again.
    globalThis.__pages.sent = [{ ok: false, status: 500, error: 'upstream_unavailable', data: null }]
    const body = await (await handler(post({ accountId: 'acct-1' }))).json()
    expect(body.resuming).toBe(0)
    expect(globalThis.__fetches).toHaveLength(0)
  })

  it('marks the mailbox disconnected on a 401 rather than retrying forever', async () => {
    globalThis.__pages.sent = [{ ok: false, status: 401, error: 'unauthorized', data: null }]
    await handler(post({ accountId: 'acct-1' }))
    expect(globalThis.__db.db.email_accounts[0].status).toBe('disconnected')
  })

  it('publishes the finished tally and stops calling itself the moment it is done', async () => {
    globalThis.__pages.sent = [page([sent('balkhalaf@al-akaria.com', 'Bayan AlKhalaf')])]
    globalThis.__pages.inbox = [page([received('balkhalaf@al-akaria.com', 'Bayan AlKhalaf')])]

    const body = await (await handler(post({ accountId: 'acct-1' }))).json()
    const account = globalThis.__db.db.email_accounts[0]

    expect(account.backfill_done).toBe(true)
    expect(account.sweep_role).toBeNull()
    expect(account.backfill_cursor).toBeNull()
    expect(account.sweep_completed_at).toBeTruthy()
    expect(account.sweep_stats).toMatchObject({ people: 1, promotable: 1, promoted: 1, window_months: 18 })
    expect(body.resuming).toBe(0)
  })
})

describe('email-sync-background — the forward path is untouched', () => {
  it('still reads bodies and still writes notes once the backfill is done', async () => {
    // Notes stay forward-only. The backfill writes none, ever; mail arriving
    // from now on gets its note exactly as before. This is the catch-up branch,
    // deliberately left byte-identical to what was here before the sweep was
    // rewritten, and it only ever runs for an account whose 18-month backfill
    // has already finished.
    globalThis.__db = makeDb({ accounts: [{ ...ACCOUNT, backfill_done: true }] })
    globalThis.__pages.sent = [page([sent('malmakheeti@limad.com', 'Muna Almakheeti')])]

    await handler(post({ accountId: 'acct-1' }))

    expect(globalThis.__listCalls[0]).toMatchObject({ limit: 50 })
    expect(globalThis.__listCalls[0].metaOnly).toBeUndefined()
    expect(reserveAnthropicTokens).toHaveBeenCalled()
    expect(writeNote).toHaveBeenCalled()
  })
})

describe('email-sync-background — configuration guards', () => {
  it('does nothing without Supabase credentials', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect((await handler(post({}))).status).toBe(503)
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  })
})

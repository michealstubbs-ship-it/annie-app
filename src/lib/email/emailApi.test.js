import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => globalThis.__session) } },
}))

const { getEmailStatus, startEmailConnect, disconnectEmail, sendFromAnnie } =
  await import('./emailApi.js')

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

beforeEach(() => {
  globalThis.__session = { data: { session: { access_token: 'tok' } } }
  global.fetch = vi.fn()
})

describe('the URL every call uses', () => {
  it('is /api/..., not the default functions path', async () => {
    // These functions declare a custom Netlify config.path, which REPLACES the
    // default alias — calling /.netlify/functions/... returns the SPA's HTML
    // and fails as a JSON parse error. Already shipped three times in this
    // codebase; this test is the guard.
    global.fetch.mockResolvedValue(reply(200, { available: true }))
    await getEmailStatus()
    expect(global.fetch.mock.calls[0][0]).toBe('/api/email-connect')

    global.fetch.mockResolvedValue(reply(200, { sent: true }))
    await sendFromAnnie({ to: 'a@b.com', subject: 's', body: 'b' })
    expect(global.fetch.mock.calls[1][0]).toBe('/api/email-send')
  })

  it('carries the caller own token, never a user id from the page', async () => {
    global.fetch.mockResolvedValue(reply(200, {}))
    await getEmailStatus()
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')
  })

  it('fails cleanly when the session has gone', async () => {
    globalThis.__session = { data: { session: null } }
    const got = await getEmailStatus()
    expect(got.available).toBe(false)
    expect(got.error).toMatch(/session/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('startEmailConnect', () => {
  it('returns the hosted URL', async () => {
    global.fetch.mockResolvedValue(reply(200, { url: 'https://account.unipile.com/x' }))
    expect(await startEmailConnect()).toEqual({ url: 'https://account.unipile.com/x', error: null })
  })

  it('flags an upgrade rather than looking like a failure', async () => {
    global.fetch.mockResolvedValue(reply(402, { error: 'Email sync is on Growth and Team' }))
    const got = await startEmailConnect()
    expect(got).toMatchObject({ url: null, upgrade: true })
  })

  it('survives a response that is not JSON at all', async () => {
    // What a 404 into the SPA fallback actually looks like.
    global.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => { throw new Error('bad json') } })
    const got = await startEmailConnect()
    expect(got.url).toBeNull()
    expect(got.error).toBeTruthy()
  })
})

describe('sendFromAnnie', () => {
  it('reports success with the logged contact', async () => {
    global.fetch.mockResolvedValue(reply(200, { sent: true, contactId: 'k1', note: true }))
    expect(await sendFromAnnie({ to: 'a@b.com', subject: 's', body: 'b' }))
      .toEqual({ sent: true, contactId: 'k1', note: true, error: null })
  })

  it('says when no mailbox is connected', async () => {
    global.fetch.mockResolvedValue(reply(409, {}))
    expect(await sendFromAnnie({ to: 'a@b.com', subject: 's', body: 'b' }))
      .toMatchObject({ sent: false, connect: true })
  })

  it('never reports a failed send as sent', async () => {
    // A user unsure whether their message went will send it twice.
    global.fetch.mockResolvedValue(reply(502, { error: 'The message could not be sent' }))
    expect((await sendFromAnnie({ to: 'a@b.com', subject: 's', body: 'b' })).sent).toBe(false)

    global.fetch.mockRejectedValue(new Error('offline'))
    expect((await sendFromAnnie({ to: 'a@b.com', subject: 's', body: 'b' })).sent).toBe(false)
  })
})

describe('disconnectEmail', () => {
  it('uses DELETE', async () => {
    global.fetch.mockResolvedValue(reply(200, { disconnected: true }))
    await disconnectEmail()
    expect(global.fetch.mock.calls[0][1].method).toBe('DELETE')
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: getSessionMock } } }))

import { parseCvViaAnnie, triggerBulkCvImport, fetchCvBulkStatus } from './cvParseClient.js'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseCvViaAnnie', () => {
  it('throws without calling fetch when there is no signed-in session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(parseCvViaAnnie('user_1/cv.pdf')).rejects.toThrow('You need to be signed in for that.')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts the path with a bearer token and returns the parsed JSON', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, parsed: { name: 'Jane Doe' } }) })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await parseCvViaAnnie('user_1/cv.pdf')

    expect(fetchSpy).toHaveBeenCalledWith('/.netlify/functions/parse-cv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_abc' },
      body: JSON.stringify({ path: 'user_1/cv.pdf' }),
    })
    expect(result).toEqual({ ok: true, parsed: { name: 'Jane Doe' } })
  })

  it('returns a friendly ok:false rather than throwing when the response body is malformed', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => { throw new Error('not json') } }))
    const result = await parseCvViaAnnie('user_1/cv.pdf')
    expect(result.ok).toBe(false)
  })
})

describe('triggerBulkCvImport', () => {
  it('throws without calling fetch when there is no signed-in session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(triggerBulkCvImport(['user_1/a.pdf'])).rejects.toThrow('You need to be signed in for that.')
  })

  it('posts the paths with a bearer token and returns whether the trigger succeeded', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await triggerBulkCvImport(['user_1/a.pdf', 'user_1/b.pdf'])

    expect(fetchSpy).toHaveBeenCalledWith('/.netlify/functions/parse-cvs-bulk-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_abc' },
      body: JSON.stringify({ paths: ['user_1/a.pdf', 'user_1/b.pdf'] }),
    })
    expect(result).toBe(true)
  })

  it('returns false when the trigger response is not ok', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    expect(await triggerBulkCvImport(['user_1/a.pdf'])).toBe(false)
  })
})

describe('fetchCvBulkStatus', () => {
  it('returns status "unknown" rather than throwing when there is no signed-in session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await fetchCvBulkStatus()).toEqual({ status: 'unknown' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches with a bearer token and returns the parsed status', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const status = { status: 'running', total: 3, completed: 1, results: [] }
    const fetchSpy = vi.fn().mockResolvedValue({ json: async () => status })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await fetchCvBulkStatus()

    expect(fetchSpy).toHaveBeenCalledWith('/.netlify/functions/cv-bulk-status', { headers: { Authorization: 'Bearer tok_abc' } })
    expect(result).toEqual(status)
  })

  it('returns status "unknown" rather than throwing when the fetch itself fails', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(await fetchCvBulkStatus()).toEqual({ status: 'unknown' })
  })
})

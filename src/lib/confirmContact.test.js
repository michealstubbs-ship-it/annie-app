import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: getSessionMock } } }))

import { confirmContact } from './confirmContact.js'

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('confirmContact', () => {
  it('posts to confirm-contact with the caller\'s bearer token, company, and titleKeywords', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    await confirmContact({ contact_name: 'Jane Doe', company_name: 'Acme Ltd', title_keywords: ['CFO'] })

    expect(fetchSpy).toHaveBeenCalledWith('/.netlify/functions/confirm-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok_abc' },
      body: JSON.stringify({ company: 'Acme Ltd', titleKeywords: ['CFO'] }),
    })
  })

  it('defaults titleKeywords to an empty array when the signal carries none', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    await confirmContact({ contact_name: 'Jane Doe', company_name: 'Acme Ltd' })

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.titleKeywords).toEqual([])
  })

  it('is a no-op (never calls supabase or fetch) when contact_name is missing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await confirmContact({ company_name: 'Acme Ltd' })
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is a no-op when company_name is missing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await confirmContact({ contact_name: 'Jane Doe' })
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is a no-op when signal itself is missing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await confirmContact(null)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never calls fetch when there is no active session/token', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await confirmContact({ contact_name: 'Jane Doe', company_name: 'Acme Ltd' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never throws when getSession itself rejects — best-effort only', async () => {
    getSessionMock.mockRejectedValue(new Error('network down'))
    await expect(confirmContact({ contact_name: 'Jane Doe', company_name: 'Acme Ltd' })).resolves.toBeUndefined()
  })

  it('never throws when fetch itself rejects — best-effort only, never blocks the real addToCrm action', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'tok_abc' } } })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(confirmContact({ contact_name: 'Jane Doe', company_name: 'Acme Ltd' })).resolves.toBeUndefined()
  })
})

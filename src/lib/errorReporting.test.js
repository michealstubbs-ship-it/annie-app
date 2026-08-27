// ./supabase throws at import time if VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY
// aren't set (see supabase.js), which they never are in this test process —
// same as every other real env var here. Mocking the module (rather than
// setting env vars) is what makes this importable at all under vitest, and
// it's also just the right tool: these tests are about what
// errorReporting.js does with the client, not about the real client.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertMock = vi.fn()
vi.mock('./supabase', () => ({
  supabase: { from: vi.fn(() => ({ insert: insertMock })) },
}))

import { reportClientError, installGlobalErrorReporting } from './errorReporting.js'
import { supabase } from './supabase'

beforeEach(() => {
  vi.clearAllMocks()
  insertMock.mockReturnValue({ then: (resolve) => resolve({ data: null, error: null }) })
})

describe('reportClientError', () => {
  it('inserts a row with the expected shape', () => {
    reportClientError('render failed', new Error('boom'), { kind: 'react-render' })
    expect(supabase.from).toHaveBeenCalledWith('error_logs')
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'client',
      message: 'render failed',
      context: { kind: 'react-render' },
    }))
  })

  it('never throws even if the insert call itself throws synchronously', () => {
    supabase.from.mockImplementationOnce(() => { throw new Error('client not ready') })
    expect(() => reportClientError('anything')).not.toThrow()
  })

  it('falls back to a generic message when given neither a message nor an error', () => {
    reportClientError()
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'Unknown error' }))
  })

  it('strips the URL hash before logging, so a Supabase recovery/invite token in the hash never lands in error_logs', () => {
    // This test environment runs under Node (see vitest.config's
    // `environment: 'node'`, matching every other test in this repo — no
    // jsdom dependency to add just for this one check), so `window` isn't
    // a real global here either; stub it the same way the source's own
    // `typeof window !== 'undefined'` guard anticipates a caller might not
    // have one.
    vi.stubGlobal('window', {
      location: { href: 'https://app.meetannie.ai/reset-password#access_token=secret-recovery-token&type=recovery' },
    })
    try {
      reportClientError('boom')
      expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://app.meetannie.ai/reset-password' }))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a plain URL with no hash unchanged', () => {
    vi.stubGlobal('window', { location: { href: 'https://app.meetannie.ai/dashboard/pipeline' } })
    try {
      reportClientError('boom')
      expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://app.meetannie.ai/dashboard/pipeline' }))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('installGlobalErrorReporting', () => {
  it('registers window error and unhandledrejection listeners without throwing', () => {
    expect(() => installGlobalErrorReporting()).not.toThrow()
  })
})

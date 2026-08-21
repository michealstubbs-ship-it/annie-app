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
})

describe('installGlobalErrorReporting', () => {
  it('registers window error and unhandledrejection listeners without throwing', () => {
    expect(() => installGlobalErrorReporting()).not.toThrow()
  })
})

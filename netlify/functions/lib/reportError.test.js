// Same fail-open philosophy as scanShared.test.js's reserveApolloCredits
// tests: this helper must never be the thing that breaks a request, whether
// the DB write itself fails or config is simply missing.
import { describe, it, expect, vi } from 'vitest'
import { reportServerError } from './reportError.js'

function mockClient(insertImpl) {
  return { from: vi.fn(() => ({ insert: insertImpl })) }
}

describe('reportServerError', () => {
  it('writes a row with the expected shape when given a working client', async () => {
    const insert = vi.fn().mockResolvedValue({ data: null, error: null })
    const client = mockClient(insert)
    await reportServerError('chat', new Error('boom'), { userId: 'u1' }, client)
    expect(client.from).toHaveBeenCalledWith('error_logs')
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'function',
      fn_name: 'chat',
      message: 'boom',
      context: { userId: 'u1' },
    }))
  })

  it('never throws when the insert itself errors', async () => {
    const client = mockClient(vi.fn().mockRejectedValue(new Error('db down')))
    await expect(reportServerError('chat', new Error('boom'), {}, client)).resolves.toBeUndefined()
  })

  it('never throws when passed a non-Error value', async () => {
    const insert = vi.fn().mockResolvedValue({ data: null, error: null })
    const client = mockClient(insert)
    await expect(reportServerError('chat', 'a plain string error', {}, client)).resolves.toBeUndefined()
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ message: 'a plain string error' }))
  })

  it('is a silent no-op with no injected client and no env vars configured', async () => {
    // The real call sites never pass a client — this is what actually runs
    // in a local/test process where VITE_SUPABASE_URL etc. aren't set.
    await expect(reportServerError('chat', new Error('boom'))).resolves.toBeUndefined()
  })
})

// Same fail-open philosophy as scanShared.test.js's reserveApolloCredits
// tests: this helper must never be the thing that breaks a request, whether
// the DB write itself fails or config is simply missing.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSentryInit, mockCaptureException, mockFlush } = vi.hoisted(() => ({
  mockSentryInit: vi.fn(),
  mockCaptureException: vi.fn(),
  mockFlush: vi.fn().mockResolvedValue(true),
}))
vi.mock('@sentry/node', () => ({
  init: mockSentryInit,
  captureException: mockCaptureException,
  flush: mockFlush,
}))

function mockClient(insertImpl) {
  return { from: vi.fn(() => ({ insert: insertImpl })) }
}

let reportServerError

beforeEach(async () => {
  vi.clearAllMocks()
  delete process.env.SENTRY_DSN
  delete process.env.CONTEXT
  // reportError.js tracks "already initialized Sentry" at module scope
  // (deliberately — see the file's own comment on why), so each test needs
  // a fresh module instance to observe init() being called again.
  vi.resetModules()
  ;({ reportServerError } = await import('./reportError.js'))
})

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

describe('Sentry integration', () => {
  it('does nothing with Sentry when SENTRY_DSN is unset', async () => {
    await reportServerError('chat', new Error('boom'))
    expect(mockSentryInit).not.toHaveBeenCalled()
    expect(mockCaptureException).not.toHaveBeenCalled()
  })

  it('initializes once and captures the exception with fn_name and context when SENTRY_DSN is set', async () => {
    process.env.SENTRY_DSN = 'https://key@o0.ingest.sentry.io/1'
    process.env.CONTEXT = 'production'
    const err = new Error('boom')

    await reportServerError('chat', err, { userId: 'u1' })
    expect(mockSentryInit).toHaveBeenCalledTimes(1)
    expect(mockSentryInit).toHaveBeenCalledWith(expect.objectContaining({
      dsn: 'https://key@o0.ingest.sentry.io/1',
      environment: 'production',
      tracesSampleRate: 0,
    }))
    expect(mockCaptureException).toHaveBeenCalledWith(err, { tags: { fn_name: 'chat' }, extra: { userId: 'u1' } })
    expect(mockFlush).toHaveBeenCalledWith(2000)

    // A second call in the same module instance must not re-init.
    await reportServerError('chat', new Error('again'))
    expect(mockSentryInit).toHaveBeenCalledTimes(1)
  })

  it('never throws when Sentry itself throws', async () => {
    process.env.SENTRY_DSN = 'https://key@o0.ingest.sentry.io/1'
    mockCaptureException.mockImplementation(() => { throw new Error('sentry down') })
    await expect(reportServerError('chat', new Error('boom'))).resolves.toBeUndefined()
  })
})

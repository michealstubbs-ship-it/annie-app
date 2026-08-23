// Same fail-open philosophy as scanShared.test.js's reserveApolloCredits
// tests: this helper must never be the thing that breaks a request, whether
// the DB write itself fails or config is simply missing.
//
// 2026-08-23: found (via production error_logs itself, ironically) that the
// tests below which deliberately omit the injectedClient param — to exercise
// the real "no client passed" path every actual call site uses — were
// relying on VITE_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY simply not being
// set in whatever process runs them. That's true on a laptop, but Netlify's
// CI build (per netlify.toml: `npm test && npm run build`) runs with the
// site's real production env vars already in scope, since other functions'
// tests and the build itself need them — so every CI run was constructing a
// REAL Supabase client with the real service-role key and inserting literal
// "boom"/"again" rows straight into production error_logs. Fixed two ways,
// deliberately redundant: the module mock below means createClient can never
// return a real client no matter what env vars are set (this is the actual
// fix), and clearing the two env vars in beforeEach keeps the "no env vars
// configured" test's own stated premise true rather than accidentally true.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSentryInit, mockCaptureException, mockFlush, mockCreateClient } = vi.hoisted(() => ({
  mockSentryInit: vi.fn(),
  mockCaptureException: vi.fn(),
  mockFlush: vi.fn().mockResolvedValue(true),
  // A real client must never be constructible from this file, however env
  // vars happen to be set in whatever process runs these tests — see the
  // 2026-08-23 comment above. Every test that wants real DB-write behavior
  // passes its own injectedClient explicitly instead of relying on this one.
  mockCreateClient: vi.fn(() => ({ from: vi.fn(() => ({ insert: vi.fn().mockResolvedValue({ data: null, error: null }) })) })),
}))
vi.mock('@sentry/node', () => ({
  init: mockSentryInit,
  captureException: mockCaptureException,
  flush: mockFlush,
}))
vi.mock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient,
}))

function mockClient(insertImpl) {
  return { from: vi.fn(() => ({ insert: insertImpl })) }
}

let reportServerError

beforeEach(async () => {
  vi.clearAllMocks()
  delete process.env.SENTRY_DSN
  delete process.env.CONTEXT
  delete process.env.VITE_SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  // reportError.js tracks "already initialized Sentry" at module scope
  // (deliberately — see the file's own comment on why), so each test needs
  // a fresh module instance to observe init() being called again.
  vi.resetModules()
  ;({ reportServerError } = await import('./reportError.js'))
})

describe('createClient is never real, regardless of ambient env vars', () => {
  it('never touches the mocked createClient when a client is injected', async () => {
    const insert = vi.fn().mockResolvedValue({ data: null, error: null })
    await reportServerError('chat', new Error('boom'), {}, mockClient(insert))
    expect(mockCreateClient).not.toHaveBeenCalled()
  })

  it('only ever produces the mocked client, even with real-looking env vars set', async () => {
    process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'not-a-real-key'
    await reportServerError('chat', new Error('boom'))
    expect(mockCreateClient).toHaveBeenCalledTimes(1)
    // The real module is never imported by this test file at all, so the
    // only way this could be a genuine network client is if the mock above
    // failed to intercept it — asserting the mock's own return shape here
    // is what proves that didn't happen.
    expect(mockCreateClient).toHaveReturnedWith(expect.objectContaining({ from: expect.any(Function) }))
  })
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

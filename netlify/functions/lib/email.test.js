// Same fail-open philosophy as reportError.test.js: these prove the module
// never throws, whether it's unconfigured, Resend itself errors, or the
// import fails outright — a broken email send must never be the reason a
// real feature (onboarding, a webhook handler) fails.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

const originalKey = process.env.RESEND_API_KEY

describe('sendEmail', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.RESEND_API_KEY
  })

  it('returns false and never throws when RESEND_API_KEY is unset', async () => {
    const { sendEmail } = await import('./email.js')
    await expect(sendEmail({ to: 'a@b.com', subject: 'hi', html: '<p>hi</p>' })).resolves.toBe(false)
  })

  it('returns true when Resend reports success', async () => {
    process.env.RESEND_API_KEY = 're_test'
    vi.doMock('resend', () => ({
      // vitest's mockImplementation can't use an arrow function here — `new
      // Resend(key)` needs a real constructor, and arrow functions aren't
      // constructible (that's exactly the failure mode this test exists to
      // catch: sendEmail's own try/catch would otherwise swallow the
      // resulting TypeError and silently report false for the wrong reason).
      Resend: vi.fn().mockImplementation(function () {
        return { emails: { send: vi.fn().mockResolvedValue({ data: { id: 'x' }, error: null }) } }
      }),
    }))
    const { sendEmail } = await import('./email.js')
    await expect(sendEmail({ to: 'a@b.com', subject: 'hi', html: '<p>hi</p>' })).resolves.toBe(true)
  })

  it('returns false, never throws, when Resend reports an error', async () => {
    process.env.RESEND_API_KEY = 're_test'
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(function () {
        return { emails: { send: vi.fn().mockResolvedValue({ data: null, error: { message: 'invalid domain' } }) } }
      }),
    }))
    const { sendEmail } = await import('./email.js')
    await expect(sendEmail({ to: 'a@b.com', subject: 'hi', html: '<p>hi</p>' })).resolves.toBe(false)
  })

  it('returns false, never throws, when the SDK itself throws', async () => {
    process.env.RESEND_API_KEY = 're_test'
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(function () {
        return { emails: { send: vi.fn().mockRejectedValue(new Error('network down')) } }
      }),
    }))
    const { sendEmail } = await import('./email.js')
    await expect(sendEmail({ to: 'a@b.com', subject: 'hi', html: '<p>hi</p>' })).resolves.toBe(false)
  })
})

describe('sendWelcomeEmail / sendPaymentFailedEmail', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.RESEND_API_KEY
  })

  it('sendWelcomeEmail is a no-op-safe call when unconfigured', async () => {
    const { sendWelcomeEmail } = await import('./email.js')
    await expect(sendWelcomeEmail('a@b.com', 'Acme Recruiting')).resolves.toBe(false)
  })

  it('sendPaymentFailedEmail is a no-op-safe call when unconfigured', async () => {
    const { sendPaymentFailedEmail } = await import('./email.js')
    await expect(sendPaymentFailedEmail('a@b.com')).resolves.toBe(false)
  })
})

afterAll(() => {
  if (originalKey === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = originalKey
})

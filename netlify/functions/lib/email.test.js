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

  // 2026-08-26 audit fix: a real send failure (a revoked key, a lapsed
  // domain, Resend rate-limiting) used to be completely invisible — no
  // log, no alert, nothing. Every other fail-open helper in this codebase
  // at least console.errors on failure; this closes that gap.
  it('returns false, never throws, when Resend reports an error — and now logs it', async () => {
    process.env.RESEND_API_KEY = 're_test'
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(function () {
        return { emails: { send: vi.fn().mockResolvedValue({ data: null, error: { message: 'invalid domain' } }) } }
      }),
    }))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sendEmail } = await import('./email.js')
    await expect(sendEmail({ to: 'a@b.com', subject: 'hi', html: '<p>hi</p>' })).resolves.toBe(false)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[email]'), 'a@b.com', ':', 'invalid domain')
    consoleSpy.mockRestore()
  })

  it('returns false, never throws, when the SDK itself throws — and now logs it', async () => {
    process.env.RESEND_API_KEY = 're_test'
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(function () {
        return { emails: { send: vi.fn().mockRejectedValue(new Error('network down')) } }
      }),
    }))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sendEmail } = await import('./email.js')
    await expect(sendEmail({ to: 'a@b.com', subject: 'hi', html: '<p>hi</p>' })).resolves.toBe(false)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[email]'), 'a@b.com', ':', 'network down')
    consoleSpy.mockRestore()
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

  it('sendSupportEscalationEmail is a no-op-safe call when unconfigured', async () => {
    const { sendSupportEscalationEmail } = await import('./email.js')
    await expect(sendSupportEscalationEmail('mstubbs@meetannie.ai', {
      customerEmail: 'a@b.com', firmName: 'Acme Recruiting', category: 'refund_billing', excerpt: 'user: I want a refund',
    })).resolves.toBe(false)
  })
})

describe('sendSupportEscalationEmail', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env.RESEND_API_KEY
  })

  it('sends with a subject naming the escalation category and firm', async () => {
    process.env.RESEND_API_KEY = 're_test'
    const sendMock = vi.fn().mockResolvedValue({ data: { id: 'x' }, error: null })
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(function () { return { emails: { send: sendMock } } }),
    }))
    const { sendSupportEscalationEmail } = await import('./email.js')
    await sendSupportEscalationEmail('mstubbs@meetannie.ai', {
      customerEmail: 'client@acme.com', firmName: 'Acme Recruiting', category: 'refund_billing', excerpt: 'user: I want a refund',
    })
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'mstubbs@meetannie.ai',
      subject: expect.stringContaining('Refund / billing dispute'),
    }))
    expect(sendMock.mock.calls[0][0].subject).toContain('Acme Recruiting')
    expect(sendMock.mock.calls[0][0].html).toContain('client@acme.com')
    expect(sendMock.mock.calls[0][0].html).toContain('I want a refund')
  })

  it('falls back to a generic label for an unrecognized category rather than throwing', async () => {
    process.env.RESEND_API_KEY = 're_test'
    const sendMock = vi.fn().mockResolvedValue({ data: { id: 'x' }, error: null })
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(function () { return { emails: { send: sendMock } } }),
    }))
    const { sendSupportEscalationEmail } = await import('./email.js')
    await sendSupportEscalationEmail('mstubbs@meetannie.ai', { category: 'not_a_real_category', excerpt: 'hi' })
    expect(sendMock.mock.calls[0][0].subject).toContain('Unresolved after repeated attempts')
  })
})

afterAll(() => {
  if (originalKey === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = originalKey
})

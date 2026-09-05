import { describe, it, expect, vi } from 'vitest'
import {
  stripQuotedHistory, fallbackNote, buildNotePrompt, writeNote, autoReplyNote, NOTE_MODEL,
} from './emailNote.js'

describe('stripQuotedHistory', () => {
  // Michael's real reply to Bayan, 1 Sep 2026 — Outlook's quoting style.
  const outlookReply = `Tomorrow may be short notice, but I will see. If it is not possible?

Michael Stubbs

Managing Director

Vantage Search Group

________________________________
From: Bayan AlKhalaf <balkhalaf@al-akaria.com>
Sent: Monday, September 1, 2026 2:04 PM
To: Michael Stubbs
Subject: RE: Senior Marketing Manager profile

Hi Michael, would tomorrow at 1pm work?`

  it('keeps only what was newly written', () => {
    const got = stripQuotedHistory(outlookReply)
    expect(got).toContain('Tomorrow may be short notice')
    expect(got).not.toContain('would tomorrow at 1pm work')
    expect(got).not.toContain('Bayan AlKhalaf <balkhalaf@al-akaria.com>')
  })

  it('handles the Gmail quoting style too', () => {
    // Abdulaziz Jalab's real follow-up, 2 Sep 2026.
    const gmail = `Dear Michael,

Hope you have had a chance to review my previous email.

On Mon, Aug 31, 2026 at 6:18 PM Abdulaziz Jalab <azjalab@gmail.com> wrote:

> Dear Michael,
> Trust this email finds you well.`
    const got = stripQuotedHistory(gmail)
    expect(got).toContain('Hope you have had a chance')
    expect(got).not.toContain('Trust this email finds you well')
  })

  it('survives an empty or absent body', () => {
    expect(stripQuotedHistory('')).toBe('')
    expect(stripQuotedHistory(null)).toBe('')
  })

  it('caps very long mail so one message cannot run up a bill', () => {
    expect(stripQuotedHistory('x'.repeat(50000)).length).toBeLessThanOrEqual(4000)
  })
})

describe('fallbackNote', () => {
  it('reads like a note, not an error', () => {
    expect(fallbackNote({ direction: 'out', subject: 'Re: Senior Marketing Manager profile' }))
      .toBe('Emailed about Senior Marketing Manager profile')
    expect(fallbackNote({ direction: 'in', subject: 'FW: Agreement Execution' }))
      .toBe('Replied about Agreement Execution')
  })
  it('still says something when there is no subject', () => {
    expect(fallbackNote({ direction: 'out', subject: '' })).toBe('Sent an email')
  })
})

describe('buildNotePrompt', () => {
  const prompt = buildNotePrompt({
    direction: 'in', counterpartyName: 'Bayan AlKhalaf', companyName: 'Al Akaria',
    subject: 'FW: Senior Marketing Manager profile', body: 'Sunday 1 pm is suitable',
  })

  it('says who wrote to whom, so the note is not written backwards', () => {
    expect(prompt).toContain('Bayan AlKhalaf at Al Akaria sent this to the recruiter.')
  })
  it('tells the model to keep figures', () => {
    // Michael chose "record everything" on 2026-09-05. A note that drops the
    // salary is not the note he asked for.
    expect(prompt).toMatch(/salary figures/i)
  })
  it('tells the model not to speculate', () => {
    expect(prompt).toMatch(/never guess intent/i)
  })
})

function fakeAnthropic(text, { ok = true, usage = null } = {}) {
  return vi.fn(async () => ({
    ok,
    json: async () => ({ content: [{ type: 'text', text }], usage }),
  }))
}

describe('writeNote', () => {
  const message = {
    direction: 'in', subject: 'FW: Senior Marketing Manager profile',
    bodyPlain: 'Hi Michael\n\nSunday 1 pm is suitable\n\nThank you',
    counterpartyName: 'Bayan AlKhalaf', companyName: 'Al Akaria',
  }

  it('returns the model line', async () => {
    const got = await writeNote('key', message, { fetchImpl: fakeAnthropic('Confirmed Sunday 1pm for the interview') })
    expect(got).toEqual({ note: 'Confirmed Sunday 1pm for the interview', model: NOTE_MODEL, source: 'model' })
  })

  it('strips quote marks and a "Note:" preamble the model sometimes adds', async () => {
    const got = await writeNote('key', message, { fetchImpl: fakeAnthropic('Note: "Confirmed Sunday 1pm"') })
    expect(got.note).toBe('Confirmed Sunday 1pm')
  })

  it('takes only the first line if the model rambles', async () => {
    const got = await writeNote('key', message, { fetchImpl: fakeAnthropic('Confirmed Sunday 1pm\n\nShe also asked about fees.') })
    expect(got.note).toBe('Confirmed Sunday 1pm')
  })

  it('reports usage so the tokens get billed', async () => {
    const onUsage = vi.fn()
    await writeNote('key', message, {
      fetchImpl: fakeAnthropic('Confirmed Sunday 1pm', { usage: { input_tokens: 300, output_tokens: 12 } }),
      onUsage,
    })
    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 300, output_tokens: 12 })
  })

  it('falls back rather than fail when there is no key', async () => {
    const got = await writeNote('', message)
    expect(got.source).toBe('fallback_no_key')
    expect(got.note).toBe('Replied about Senior Marketing Manager profile')
  })

  it('falls back when Anthropic returns an error', async () => {
    const got = await writeNote('key', message, { fetchImpl: vi.fn(async () => ({ ok: false })) })
    expect(got.source).toBe('fallback_http')
    expect(got.note).toBe('Replied about Senior Marketing Manager profile')
  })

  it('falls back when the call throws — a sync never dies on the note writer', async () => {
    const got = await writeNote('key', message, { fetchImpl: vi.fn(async () => { throw new Error('socket hang up') }) })
    expect(got.source).toBe('fallback_error')
    expect(got.note).toBeTruthy()
  })

  it('never returns an empty note', async () => {
    const got = await writeNote('key', message, { fetchImpl: fakeAnthropic('   ') })
    expect(got.note).toBeTruthy()
    expect(got.source).toBe('fallback_empty_reply')
  })
})

describe('autoReplyNote', () => {
  it('records the return date so the chase resumes at the right time', () => {
    expect(autoReplyNote({ awayUntil: '2026-09-21' })).toBe('Out of office until 21 Sep')
  })
  it('still says what it was when no date could be read', () => {
    expect(autoReplyNote({ awayUntil: null })).toBe('Out of office auto-reply')
  })
})

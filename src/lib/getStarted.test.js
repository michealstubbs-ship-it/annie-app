import { describe, it, expect } from 'vitest'
import { getStartedCopy } from './getStarted'
import { MAILBOX_NONE, MAILBOX_CONNECTING, MAILBOX_CONNECTED } from './networkGate'

describe('getStartedCopy — the first screen after onboarding', () => {
  // THE STEP ORDER, which is the release. The mailbox connection existed
  // before this and sat AFTER the CSV import, on its completion screen — so
  // only people who had already finished a CSV import ever saw it, and most
  // people never got there because LinkedIn takes up to 24 hours to email the
  // export.
  it('puts the mailbox first and the contacts export second', () => {
    const copy = getStartedCopy({ mailbox: MAILBOX_NONE })
    expect(copy.mailbox.title).toBe('Connect your mailbox')
    expect(copy.upload.title).toBe('Or upload a contacts export')
  })

  // Michael's point about which source is worth more, and it is measured: of
  // 753 LinkedIn-imported contacts on the production account, zero had a note
  // or a logged call against them.
  it('says why the mailbox is the better source rather than only that it is faster', () => {
    const copy = getStartedCopy({ mailbox: MAILBOX_NONE })
    expect(copy.mailbox.body).toContain('what you have actually said to someone')
  })

  // The refuser's path, and the copy fix that goes with it: the parser has
  // always read .csv/.xlsx/.xls/.ods from any source, while every string in
  // the product said "LinkedIn".
  it('offers the contacts export from anywhere, not only LinkedIn', () => {
    const { upload } = getStartedCopy({ mailbox: MAILBOX_NONE })
    expect(upload.body).toContain('Outlook')
    expect(upload.body).toContain('a CRM you used before')
    expect(upload.body).toContain('.ods')
  })

  it('warns that the LinkedIn export is the slow one, where that is still relevant', () => {
    expect(getStartedCopy({}).upload.note).toContain('up to 24 hours')
  })

  it('tracks the three mailbox states', () => {
    expect(getStartedCopy({ mailbox: MAILBOX_NONE }).mailbox.state).toBe('offer')
    expect(getStartedCopy({ mailbox: MAILBOX_CONNECTING }).mailbox.state).toBe('waiting')
    expect(getStartedCopy({ mailbox: MAILBOX_CONNECTED }).mailbox.state).toBe('connected')
  })

  it('offers a retry rather than a repeat of the pitch after an abandoned consent screen', () => {
    const copy = getStartedCopy({ mailbox: MAILBOX_CONNECTING })
    expect(copy.mailbox.cta).toBe('Try again')
    expect(copy.mailbox.body).toContain('has not confirmed it yet')
  })

  it('states the trust boundary on the screen that asks for the mailbox', () => {
    const { mailbox } = getStartedCopy({ mailbox: MAILBOX_NONE })
    expect(mailbox.keeps).toContain('never stores your emails')
    expect(mailbox.keeps).toContain('never')
    expect(mailbox.note).toContain('your password never reaches Annie')
  })

  // The rule EmailConnectStep already worked to: a dead end in the middle of
  // setup is a worse first impression than never mentioning the feature.
  it('drops the mailbox step entirely where email sync is not configured', () => {
    const copy = getStartedCopy({ mailbox: MAILBOX_NONE, mailboxOffered: false })
    expect(copy.mailbox).toBeNull()
    expect(copy.upload.title).toBe('Upload a contacts export')
    expect(`${copy.intro} ${copy.footnote}`).not.toMatch(/mailbox/i)
  })

  // There is no third option any more. "Skip for now" wrote the flag the
  // dashboard gate read, so skipping admitted someone with no network to a
  // product that only works with one.
  it('says plainly that there is nothing to skip to', () => {
    for (const offered of [true, false]) {
      const copy = getStartedCopy({ mailbox: MAILBOX_NONE, mailboxOffered: offered })
      expect(copy.footnote).toContain('an empty address book is an empty feed')
    }
  })

  it('uses none of the language Michael has already rejected', () => {
    const copies = [
      getStartedCopy({ mailbox: MAILBOX_NONE }),
      getStartedCopy({ mailbox: MAILBOX_CONNECTING }),
      getStartedCopy({ mailbox: MAILBOX_CONNECTED }),
      getStartedCopy({ mailbox: MAILBOX_NONE, mailboxOffered: false }),
    ]
    const lines = copies.flatMap(c => [
      c.heading, c.intro, c.footnote,
      c.upload.title, c.upload.body, c.upload.note, c.upload.cta,
      ...(c.mailbox ? [c.mailbox.title, c.mailbox.body, c.mailbox.keeps, c.mailbox.cta, c.mailbox.note, ...c.mailbox.points] : []),
    ])

    const banned = /\b(bench|new seat|something to prove|warmest call|streak|well done|great job|congratulat|nice work|keep it up|crush|smash)\b/i
    for (const line of lines) {
      expect(line, line).not.toMatch(banned)
      expect(line, line).not.toContain('!')
    }
  })
})

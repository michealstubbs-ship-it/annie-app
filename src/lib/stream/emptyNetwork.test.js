import { describe, it, expect } from 'vitest'
import { emptyNetworkPanel, ACTION_CONNECT_MAILBOX, ACTION_UPLOAD_CONTACTS } from './emptyNetwork'
import { MAILBOX_NONE, MAILBOX_CONNECTING, MAILBOX_CONNECTED } from '../networkGate'

describe('emptyNetworkPanel — what the feed says with no network', () => {
  it('renders nothing once there are contacts, because then there is a list to show', () => {
    expect(emptyNetworkPanel({ mailbox: MAILBOX_NONE, contactCount: 1 })).toBeNull()
  })

  // The state this whole release exists to produce. Before it, a brand-new
  // account's first screen was the open market — 35 of 38 feed items at
  // companies the recruiter had never heard of.
  it('says what is missing when there is nothing at all', () => {
    const panel = emptyNetworkPanel({ mailbox: MAILBOX_NONE, contactCount: 0 })
    expect(panel.heading).toBe('Annie has nothing to watch yet')
    expect(panel.detail).toContain('only shows you companies where you already know someone')
    expect(panel.actions.map(a => a.key)).toEqual([ACTION_CONNECT_MAILBOX, ACTION_UPLOAD_CONTACTS])
  })

  // The waiting state has to answer both questions: what is happening now, and
  // what the recruiter will have when it finishes.
  it('describes the sweep as work in progress with an end to it', () => {
    const panel = emptyNetworkPanel({ mailbox: MAILBOX_CONNECTED, sweeping: true, contactCount: 0 })
    expect(panel.waiting).toBe(true)
    expect(panel.heading).toBe('Annie is reading your sent mail')
    expect(panel.detail).toContain('takes a few minutes')
    expect(panel.detail).toContain('it updates itself')
    // Nothing to click: the work is already running.
    expect(panel.actions).toEqual([])
  })

  // Rare, and the temptation is to say nothing. Someone staring at an empty
  // feed after handing over their mailbox has to be told why it is empty.
  it('admits it when the sweep finished and produced nobody', () => {
    const panel = emptyNetworkPanel({ mailbox: MAILBOX_CONNECTED, sweeping: false, contactCount: 0 })
    expect(panel.heading).toBe('Annie has read your sent mail and found nobody to file')
    expect(panel.waiting).toBe(false)
    expect(panel.detail).toContain('The first pass is finished')
    expect(panel.actions.map(a => a.key)).toEqual([ACTION_UPLOAD_CONTACTS])
  })

  it('names the abandoned consent screen rather than leaving it as silence', () => {
    const panel = emptyNetworkPanel({ mailbox: MAILBOX_CONNECTING, contactCount: 0 })
    expect(panel.heading).toBe('Your mailbox has not finished connecting')
    expect(panel.detail).toContain('If you closed that window before the end')
  })

  // The rule EmailConnectStep already worked to: an offer that dead-ends is a
  // worse first impression than never making the offer.
  it('never mentions the mailbox on an install where email sync is not configured', () => {
    const panels = [
      emptyNetworkPanel({ mailbox: MAILBOX_NONE, contactCount: 0, mailboxOffered: false }),
      emptyNetworkPanel({ mailbox: MAILBOX_CONNECTING, contactCount: 0, mailboxOffered: false }),
    ]
    for (const panel of panels) {
      expect(panel.actions.map(a => a.key)).toEqual([ACTION_UPLOAD_CONTACTS])
      expect(`${panel.heading} ${panel.detail}`).not.toMatch(/connect your mailbox|connect a mailbox/i)
    }
  })

  // Michael has rejected drafts for this. Same list dailySet.test.js holds its
  // own copy to, plus the exclamation mark that gives away a product
  // congratulating someone for using it.
  it('uses none of the language Michael has already rejected', () => {
    const all = [
      emptyNetworkPanel({ mailbox: MAILBOX_NONE, contactCount: 0 }),
      emptyNetworkPanel({ mailbox: MAILBOX_NONE, contactCount: 0, mailboxOffered: false }),
      emptyNetworkPanel({ mailbox: MAILBOX_CONNECTING, contactCount: 0 }),
      emptyNetworkPanel({ mailbox: MAILBOX_CONNECTED, sweeping: true, contactCount: 0 }),
      emptyNetworkPanel({ mailbox: MAILBOX_CONNECTED, sweeping: false, contactCount: 0 }),
    ].flatMap(p => [p.heading, p.detail])

    const banned = /\b(bench|new seat|something to prove|warmest call|streak|well done|great job|congratulat|nice work|keep it up|crush|smash)\b/i
    for (const line of all) {
      expect(line, line).not.toMatch(banned)
      expect(line, line).not.toContain('!')
    }
  })
})

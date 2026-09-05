import { describe, it, expect } from 'vitest'
import {
  readNetwork, admitsToDashboard, routeForUser, mailboxState,
  MAILBOX_NONE, MAILBOX_CONNECTING, MAILBOX_CONNECTED,
  NETWORK_UNKNOWN, NETWORK_EMPTY, NETWORK_SWEEPING, NETWORK_PRESENT,
  GET_STARTED_PATH,
} from './networkGate'

const user = { id: 'u1' }
const onboarded = { onboarding_completed: true }

describe('mailboxState', () => {
  it('reads a connected mailbox', () => {
    expect(mailboxState({ status: 'connected' })).toBe(MAILBOX_CONNECTED)
  })

  // email-connect.js writes 'connecting' BEFORE the recruiter reaches the
  // Google/Microsoft consent screen. Someone who closes that window sits in it
  // forever, so if 'connecting' counted as a mailbox, clicking the button
  // would simply be the new "Skip for now".
  it('does not treat "clicked connect" as a connected mailbox', () => {
    expect(mailboxState({ status: 'connecting' })).toBe(MAILBOX_CONNECTING)
  })

  it('reads no row, an unknown status and a null as no mailbox', () => {
    expect(mailboxState(null)).toBe(MAILBOX_NONE)
    expect(mailboxState({})).toBe(MAILBOX_NONE)
    expect(mailboxState({ status: 'credentials_expired' })).toBe(MAILBOX_NONE)
  })
})

describe('readNetwork — the two facts', () => {
  it('counts contacts as a network however they got there', () => {
    const n = readNetwork({ account: null, contactCount: 753 })
    expect(n.state).toBe(NETWORK_PRESENT)
    expect(n.hasNetwork).toBe(true)
  })

  // The whole reason the mailbox moved to step one: it admits instantly, so
  // the recruiter is not held on a signup screen for the minutes the first
  // pass over their sent folder takes.
  it('admits a connected mailbox before the sweep has produced a single contact', () => {
    const n = readNetwork({ account: { status: 'connected', backfill_done: false }, contactCount: 0 })
    expect(n.state).toBe(NETWORK_SWEEPING)
    expect(n.sweeping).toBe(true)
    expect(n.hasNetwork).toBe(true)
  })

  it('stops calling it a sweep once the first pass is finished', () => {
    const n = readNetwork({ account: { status: 'connected', backfill_done: true }, contactCount: 0 })
    expect(n.sweeping).toBe(false)
    expect(n.state).toBe(NETWORK_PRESENT)
    expect(n.hasNetwork).toBe(true)
  })

  // A mailbox can still be on its first pass while already having filed
  // people — that is a populated feed that is also still filling.
  it('keeps sweeping as a separate fact from having contacts', () => {
    const n = readNetwork({ account: { status: 'connected', backfill_done: false }, contactCount: 12 })
    expect(n.state).toBe(NETWORK_PRESENT)
    expect(n.sweeping).toBe(true)
  })

  it('calls an account with no mailbox and no contacts empty, which is the case this release exists for', () => {
    const n = readNetwork({ account: null, contactCount: 0 })
    expect(n.state).toBe(NETWORK_EMPTY)
    expect(n.hasNetwork).toBe(false)
  })

  it('does not let an abandoned consent screen count as a network', () => {
    const n = readNetwork({ account: { status: 'connecting' }, contactCount: 0 })
    expect(n.state).toBe(NETWORK_EMPTY)
    expect(n.hasNetwork).toBe(false)
  })

  // A failed read is not evidence of an empty network. Both facts travel over
  // the network and either can fail.
  it('reports unknown when the contact count could not be read', () => {
    expect(readNetwork({ account: null, contactCount: null }).state).toBe(NETWORK_UNKNOWN)
  })

  it('reports unknown when the mailbox status could not be read', () => {
    expect(readNetwork({ account: null, contactCount: 0, mailboxKnown: false }).state).toBe(NETWORK_UNKNOWN)
  })

  it('is not unknown when one fact alone settles it', () => {
    // The contact count came back positive; the mailbox call failing changes
    // nothing, they demonstrably have a network.
    expect(readNetwork({ contactCount: 40, mailboxKnown: false }).state).toBe(NETWORK_PRESENT)
    // And a connected mailbox settles it even if the count could not be read.
    expect(readNetwork({ account: { status: 'connected' }, contactCount: null }).state).toBe(NETWORK_SWEEPING)
  })

  it('treats a missing backfill_done column as still running rather than finished and empty', () => {
    expect(readNetwork({ account: { status: 'connected' }, contactCount: 0 }).sweeping).toBe(true)
  })
})

describe('admitsToDashboard — the gate', () => {
  // THE BUG. "Skip for now" set linkedin_import_completed = true, and that
  // flag was the gate. It recorded that a dialog had been shown; everything
  // downstream read it as "this person has a network".
  it('does not admit someone who was merely asked', () => {
    const skipped = { onboarding_completed: true, linkedin_import_completed: true }
    expect(admitsToDashboard(readNetwork({ account: null, contactCount: 0 }), skipped)).toBe(false)
  })

  it('admits a customer with contacts even though the flag was never set', () => {
    const noFlag = { onboarding_completed: true, linkedin_import_completed: false }
    expect(admitsToDashboard(readNetwork({ contactCount: 1 }), noFlag)).toBe(true)
  })

  // The safety valve, and the reason the flag is still read at all: a blocked
  // request must never eject a paying customer with 753 contacts back into
  // signup. Unknown reproduces exactly today's behaviour for exactly the
  // accounts that already passed the old gate.
  it('falls back to the old flag only when neither fact could be read', () => {
    const unknown = readNetwork({ contactCount: null, mailboxKnown: false })
    expect(admitsToDashboard(unknown, { linkedin_import_completed: true })).toBe(true)
    expect(admitsToDashboard(unknown, { linkedin_import_completed: false })).toBe(false)
  })

  it('treats a missing network reading the same as unknown', () => {
    expect(admitsToDashboard(null, { linkedin_import_completed: true })).toBe(true)
    expect(admitsToDashboard(undefined, {})).toBe(false)
  })
})

describe('routeForUser', () => {
  it('sends a signed-out visitor to login', () => {
    expect(routeForUser(null, null, null)).toBe('/login')
  })

  it('sends an unonboarded user to onboarding before asking about their network', () => {
    expect(routeForUser(user, { onboarding_completed: false }, readNetwork({ contactCount: 500 })))
      .toBe('/onboarding')
  })

  it('sends a new user with no network to the getting-started screen', () => {
    expect(routeForUser(user, onboarded, readNetwork({ contactCount: 0 }))).toBe(GET_STARTED_PATH)
  })

  // The nine accounts already past onboarding. Every one of them has contacts,
  // so every one of them lands exactly where it lands today.
  it('lands an existing customer with contacts on the dashboard', () => {
    expect(routeForUser(user, onboarded, readNetwork({ contactCount: 753 }))).toBe('/dashboard')
  })

  it('lands someone who has just connected a mailbox on the dashboard, mid-sweep', () => {
    const n = readNetwork({ account: { status: 'connected', backfill_done: false }, contactCount: 0 })
    expect(routeForUser(user, onboarded, n)).toBe('/dashboard')
  })
})

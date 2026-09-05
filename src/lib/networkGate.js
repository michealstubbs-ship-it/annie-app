// Does this customer have a network yet. Measured, not remembered.
//
// THE BUG THIS REPLACES. Admission to the dashboard was gated on
// profiles.linkedin_import_completed, and "Skip for now" set that flag to
// true. The flag recorded that a dialog had been shown; every read of it
// downstream treated it as "this person has a network to watch". Most people
// skipped, because LinkedIn can take up to 24 hours to email the connections
// export — so the common path through signup was: skip, land on a dashboard
// with an empty CRM, and be shown the open market, which is the exact thing
// two releases were spent removing. The first screen contradicted the pitch.
//
// So nothing here is a flag. "Does this customer have a network" is answered
// from two facts that are true or not true regardless of what any screen once
// asked them:
//
//   a connected mailbox   instant OAuth rather than a 24-hour wait, and the
//                         only source in the product that yields real
//                         interaction history. Measured on the production
//                         account: of 753 LinkedIn-imported contacts, zero had
//                         a note or a logged call — which is why the "you have
//                         actually spoken to this person" rung of the way-in
//                         ladder (wayIn.js's RUNG_SPOKEN) has never fired for
//                         anyone, on any account.
//
//   contacts in the CRM   however they got there: the LinkedIn CSV, an Outlook
//                         or previous-CRM export, the mailbox sweep, or typed
//                         in by hand. The gate does not care which.
//
// UNKNOWN IS A REAL ANSWER, and it is why this returns a state rather than a
// boolean. The two facts are read over the network and either read can fail —
// a blocked request, a cold function, a dropped connection. A failed read is
// not evidence of an empty network, and treating it as one would eject a
// paying customer with 753 contacts back into signup. When neither fact can be
// established, admission falls back to the old flag, which reproduces exactly
// today's behaviour for exactly the accounts that already passed it. That is a
// degraded path, not the gate: nothing writes the flag on a skip any more, and
// the feed's own network rule (buildStream.isWithinNetwork) still fails closed
// underneath it, so a fallback admission can never turn into a page of
// strangers.

export const MAILBOX_NONE = 'none'
export const MAILBOX_CONNECTING = 'connecting'
export const MAILBOX_CONNECTED = 'connected'

export const NETWORK_UNKNOWN = 'unknown'
export const NETWORK_EMPTY = 'empty'
export const NETWORK_SWEEPING = 'sweeping'
export const NETWORK_PRESENT = 'present'

// Where a customer with no network is sent.
export const GET_STARTED_PATH = '/get-started'

/**
 * An email_accounts row, reduced to the three states the product distinguishes.
 *
 * 'connecting' is written by email-connect.js BEFORE the recruiter reaches the
 * Google/Microsoft consent screen, so it means "they clicked", not "they
 * connected" — someone who abandons consent sits in it indefinitely. It must
 * never count as a network, or clicking the button would be the new skip.
 */
export function mailboxState(account) {
  const status = String(account?.status || '').toLowerCase()
  if (status === MAILBOX_CONNECTED) return MAILBOX_CONNECTED
  if (status === MAILBOX_CONNECTING) return MAILBOX_CONNECTING
  return MAILBOX_NONE
}

/**
 * The two facts, read together.
 *
 * account        the email_accounts row from /api/email-connect, or null
 * contactCount   how many contacts the customer's team has, or null if the
 *                count could not be read
 * mailboxKnown   false when the mailbox status could not be read at all —
 *                distinct from "read successfully, no mailbox"
 *
 * Returns { mailbox, sweeping, contacts, state, hasNetwork, known }.
 *
 * `sweeping` is its own boolean rather than only a state, because a mailbox
 * that is still on its first pass through the sent folder can perfectly well
 * have produced contacts already — that is a populated feed that is also still
 * filling, and the feed says so.
 */
export function readNetwork({ account = null, contactCount = null, mailboxKnown = true } = {}) {
  const mailbox = mailboxState(account)
  const connected = mailbox === MAILBOX_CONNECTED
  // backfill_done is set by email-sync-background.js when the first pass over
  // the sent folder finishes. Anything other than an explicit true is treated
  // as still running, so a missing column reads as "still working" rather than
  // as "finished and found nothing".
  const sweeping = connected && account?.backfill_done !== true
  const contacts = Number.isFinite(contactCount) && contactCount >= 0 ? contactCount : null

  let state
  if (contacts > 0) state = NETWORK_PRESENT
  else if (connected) state = sweeping ? NETWORK_SWEEPING : NETWORK_PRESENT
  else if (contacts === null || !mailboxKnown) state = NETWORK_UNKNOWN
  else state = NETWORK_EMPTY

  return {
    mailbox,
    sweeping,
    contacts,
    state,
    hasNetwork: state === NETWORK_PRESENT || state === NETWORK_SWEEPING,
    known: state !== NETWORK_UNKNOWN,
  }
}

/**
 * The gate.
 *
 * A connected mailbox admits immediately, before the sweep has produced a
 * single contact — they have done the thing that was asked, the work is
 * running, and the feed's waiting state is a better place to be than a signup
 * screen that no longer has anything to ask for.
 *
 * The profile flag is consulted in exactly one case: when neither fact could
 * be read. See this file's header for why that is a safety valve rather than
 * the gate.
 */
export function admitsToDashboard(network, profile) {
  if (!network || network.state === NETWORK_UNKNOWN) return Boolean(profile?.linkedin_import_completed)
  return Boolean(network.hasNetwork)
}

/**
 * Where a signed-in user belongs right now. Ordered: identity, then what they
 * told Annie, then whether Annie has anything to work with.
 */
export function routeForUser(user, profile, network) {
  if (!user) return '/login'
  if (!profile?.onboarding_completed) return '/onboarding'
  if (!admitsToDashboard(network, profile)) return GET_STARTED_PATH
  return '/dashboard'
}

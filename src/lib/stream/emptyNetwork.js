// What the feed says when there is no network to read from.
//
// Until now this state did not really exist: isWithinNetwork returned true for
// everything when the customer had no contacts, on the reasoning that hiding
// everything would make the product look broken on day one. What it actually
// produced was a brand-new customer's FIRST screen being a list of leads at
// companies they had never heard of — the open market, which is the one thing
// the network-first release was spent removing. A blank page would have been
// more honest than that, and this is more honest than a blank page.
//
// Every branch below has to answer two questions and stop:
//
//   what is Annie waiting for
//   what happens when it arrives
//
// COPY RULE, Michael 2026-09-05: no recruiter-marketing language — he named
// "bench", "new seat", "budget and something to prove" and "the warmest call
// in recruitment" as things nobody says. Nothing motivational or gamified, no
// congratulation for having connected something. Plain sentences, or nothing;
// a generic line is worse than none. Say what is true, including what is
// missing. See whyNow.js and dailySet.js, which are held to the same rule.
import { MAILBOX_CONNECTED, MAILBOX_CONNECTING } from '../networkGate'

export const ACTION_CONNECT_MAILBOX = 'connect-mailbox'
export const ACTION_UPLOAD_CONTACTS = 'upload-contacts'

/**
 * The panel that stands in for the list when the customer has no contacts.
 *
 * mailbox           one of networkGate's MAILBOX_* states
 * sweeping          the first pass over the sent folder is still running
 * contactCount      contacts the feed loaded — anything above zero means this
 *                   panel is not the right thing to show
 * mailboxOffered    email sync is available and configured for this install;
 *                   false means the mailbox route does not exist here and must
 *                   not be mentioned, because an offer that dead-ends is worse
 *                   than never making it
 *
 * Returns { heading, detail, waiting, actions } or null when there is a
 * network and the caller should render the list instead.
 */
export function emptyNetworkPanel({
  mailbox = 'none',
  sweeping = false,
  contactCount = 0,
  mailboxOffered = true,
} = {}) {
  if (contactCount > 0) return null

  const upload = { key: ACTION_UPLOAD_CONTACTS, label: 'Upload a contacts export' }
  const connect = { key: ACTION_CONNECT_MAILBOX, label: 'Connect my mailbox' }

  // Connected, first pass running. The one genuinely patient state: the work
  // is happening, it takes minutes, and the page will change on its own.
  if (mailbox === MAILBOX_CONNECTED && sweeping) {
    return {
      heading: 'Annie is reading your sent mail',
      detail:
        'This takes a few minutes. Everyone you have written to becomes a contact here, with a note '
        + 'saying what was discussed and their job title from their signature. Once the first ones land, '
        + 'this page fills with what has happened at the companies they work for. You do not have to wait '
        + 'on this screen — it updates itself.',
      waiting: true,
      actions: [],
    }
  }

  // Connected, first pass finished, still nothing. Rare, and the temptation is
  // to say nothing rather than admit it; a recruiter staring at an empty feed
  // after connecting their mailbox needs to be told why.
  if (mailbox === MAILBOX_CONNECTED) {
    return {
      heading: 'Annie has read your sent mail and found nobody to file',
      detail:
        'The first pass is finished and it produced no contacts. That usually means the mailbox is new, '
        + 'or everything sent from it went to colleagues. Upload a contacts export and Annie has something '
        + 'to watch instead — she reads an export from LinkedIn, Outlook, or a CRM you used before.',
      waiting: false,
      actions: [upload],
    }
  }

  // Clicked connect, never came back. email-connect.js writes 'connecting'
  // before the consent screen, so this is the state someone sits in after
  // closing the Google or Microsoft window.
  if (mailbox === MAILBOX_CONNECTING) {
    return {
      heading: 'Your mailbox has not finished connecting',
      detail:
        'You started connecting a mailbox and Google or Microsoft has not confirmed it. If you closed that '
        + 'window before the end, start it again. Nothing appears here until a mailbox is connected or you '
        + 'upload a contacts export.',
      waiting: false,
      actions: mailboxOffered ? [connect, upload] : [upload],
    }
  }

  // Nothing at all. This is what a brand-new account used to be shown the open
  // market instead of.
  return {
    heading: 'Annie has nothing to watch yet',
    detail: mailboxOffered
      ? 'She only shows you companies where you already know someone, so with nothing in your contacts '
        + 'there is nothing she can honestly put here. Connect your mailbox and she reads your sent mail, '
        + 'which takes about a minute to set up. Upload a contacts export and she reads that. Either one, '
        + 'and this page fills in.'
      : 'She only shows you companies where you already know someone, so with nothing in your contacts '
        + 'there is nothing she can honestly put here. Upload a contacts export — from LinkedIn, Outlook, '
        + 'or a CRM you used before — and this page fills in.',
    waiting: false,
    actions: mailboxOffered ? [connect, upload] : [upload],
  }
}

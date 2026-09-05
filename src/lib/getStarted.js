// The first screen after onboarding: give Annie something to watch.
//
// STEP ORDER, AND WHY IT CHANGED. The mailbox connection already existed
// (EmailConnectStep) but sat AFTER the LinkedIn CSV import, on the completion
// screen — so the only people who ever saw it were the people who had already
// finished a CSV import, and everybody else skipped straight past it. Most
// people skipped, because LinkedIn can take up to 24 hours to email the
// connections export.
//
// That is backwards twice over. The mailbox is instant OAuth rather than a
// 24-hour wait, and it is the only source in the product that yields real
// interaction history: on the production account, zero of 753
// LinkedIn-imported contacts had a note or a logged call against them, which
// is why the "you have actually spoken to this person" rung of the way-in
// ladder has never fired for anyone. A CSV gives Annie names. A mailbox gives
// her what was said and when.
//
// So the mailbox is step one and the contacts export is step two — the source
// you can add tomorrow when LinkedIn's email finally arrives.
//
// THERE IS NO THIRD OPTION, and that is the point of the release. "Skip for
// now" used to write profiles.linkedin_import_completed = true, which is the
// flag the dashboard gate read, so skipping admitted someone with no network
// to a product that only works with one. The person who will not connect a
// mailbox still has a way in — the contacts export, from anywhere, not only
// LinkedIn — but there is no longer a way past both.
//
// COPY RULE, Michael 2026-09-05: no recruiter-marketing language, nothing
// motivational, no congratulation. Plain sentences, or nothing. See
// whyNow.js's header.
import { MAILBOX_CONNECTED, MAILBOX_CONNECTING } from './networkGate'

/**
 * Everything the page renders, as data.
 *
 * mailbox         one of networkGate's MAILBOX_* states
 * mailboxOffered  email sync is available on this account AND configured on
 *                 this install. When it is not, step one does not exist here
 *                 and is not mentioned — a dead end in the middle of setup is
 *                 a worse first impression than never mentioning the feature
 *                 (the rule EmailConnectStep already worked to).
 *
 * `mailbox.state` is one of 'offer' | 'waiting' | 'connected'.
 */
export function getStartedCopy({ mailbox = 'none', mailboxOffered = true } = {}) {
  const connected = mailbox === MAILBOX_CONNECTED
  const waiting = mailbox === MAILBOX_CONNECTING

  const upload = {
    // Numbered only while there is a step above it to be second to.
    title: mailboxOffered ? 'Or upload a contacts export' : 'Upload a contacts export',
    body:
      'Annie reads an export of your contacts from LinkedIn, from Outlook, or from a CRM you used before. '
      + 'A .csv, .xlsx, .xls or .ods file — however it ended up saved.',
    note:
      'LinkedIn is the slow one: it can take up to 24 hours to email you the export after you request it. '
      + 'If yours has already arrived, upload it now.',
    cta: 'Upload a contacts export',
  }

  if (!mailboxOffered) {
    return {
      heading: 'Give Annie something to watch',
      intro:
        'Annie only shows you companies where you already know someone, so she needs to know who that is '
        + 'before there is anything to show.',
      mailbox: null,
      upload,
      footnote:
        'Nothing appears in the feed until this is done. There is no version of Annie that works without a '
        + 'network — an empty address book is an empty feed.',
    }
  }

  return {
    heading: 'Give Annie something to watch',
    intro:
      'Annie only shows you companies where you already know someone, so she needs to know who that is '
      + 'before there is anything to show. Two ways to tell her. The first is quicker and tells her more.',
    mailbox: {
      state: connected ? 'connected' : waiting ? 'waiting' : 'offer',
      title: 'Connect your mailbox',
      body: connected
        ? 'Annie is reading your sent mail now. The first contacts appear over the next few minutes.'
        : waiting
          ? 'You started this and Google or Microsoft has not confirmed it yet. If you closed that window '
            + 'before the end, start it again.'
          : 'Sign in with Google or Microsoft and Annie reads the mail you have sent. About a minute to set '
            + 'up, a few minutes to run, and it is the only source that tells her what you have actually '
            + 'said to someone rather than only that you are connected to them.',
      points: [
        'Files the people you actually deal with, and the companies they work for',
        'Writes what was discussed against each contact, so the record stays current without you typing it',
        'Fills in job titles and direct dials from email signatures',
        'Lets you send Annie’s drafted approaches from your own mailbox',
      ],
      keeps:
        'Annie never stores your emails — she reads a message, writes the note, and drops it. She never '
        + 'marks anything as read, so nothing in your inbox changes, and she only opens threads you started.',
      cta: waiting ? 'Try again' : 'Connect my mailbox',
      note: 'You sign in with Google or Microsoft — your password never reaches Annie. Disconnect any time.',
    },
    upload,
    footnote:
      'Nothing appears in the feed until one of these is done. There is no version of Annie that works '
      + 'without a network — an empty address book is an empty feed.',
  }
}

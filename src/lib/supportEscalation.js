// Annie support (SupportWidget.jsx) is a single-shot chat, not an agent with
// tools — so rather than a real tool-call loop, Annie is instructed to end
// her reply with a hidden marker when a conversation needs a human, and the
// widget strips it before ever showing the customer raw marker syntax. Kept
// as its own small, pure, tested module (rather than inline in the
// component) because parsing/stripping text correctly is exactly the kind
// of logic that's easy to get subtly wrong (leading/trailing whitespace,
// a stray blank line left behind, an unrecognized category) and this
// repo's own convention is: pure logic gets a real test file, JSX doesn't
// (see src/lib/actionsCopy.js, signalTypes.js, etc. — no *.jsx has a test).
//
// Marker format, written by Annie herself per the system prompt:
//   <<ESCALATE: refund_billing>>
// on its own line at the very end of the reply. Never shown to the customer.

// Kept in sync with the categories named in SupportWidget.jsx's system
// prompt — not load-bearing (an unrecognized category still escalates,
// see below), just what the escalation email's subject line names.
export const ESCALATION_CATEGORIES = [
  'refund_billing',
  'gdpr_data_request',
  'bug_report',
  'human_requested',
  'unresolved',
]

const MARKER_RE = /\n{0,2}<<\s*ESCALATE\s*:\s*([a-z_]+)\s*>>\s*$/i

// Splits Annie's raw reply into what the customer should actually see and
// (if present) the escalation category she flagged. A malformed or
// unrecognized category label still triggers an escalation — the marker
// existing at all means the model judged this worth a human, and a typo in
// the label shouldn't silently swallow that judgment — it's just normalized
// to 'unresolved' for the email subject rather than trusted verbatim.
export function parseEscalation(rawText) {
  if (typeof rawText !== 'string') return { displayText: rawText, category: null }

  const match = rawText.match(MARKER_RE)
  if (!match) return { displayText: rawText, category: null }

  const displayText = rawText.slice(0, match.index).trimEnd()
  const rawCategory = match[1].toLowerCase()
  const category = ESCALATION_CATEGORIES.includes(rawCategory) ? rawCategory : 'unresolved'
  return { displayText, category }
}

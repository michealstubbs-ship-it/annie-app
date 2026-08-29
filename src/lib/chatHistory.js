// 2026-08-29 audit fix: Ask Annie (Chat.jsx) and the support widget
// (SupportWidget.jsx) both used to send the ENTIRE in-memory conversation
// — every message since the tab was opened — to the model on every single
// turn, with no cap anywhere in the pipeline (chat.js forwards `messages`
// straight to Anthropic unmodified). Same failure shape as Today's
// Actions' enrichment batching bug: the prompt's size scales with usage
// (here, how long the conversation runs) rather than with anything fixed,
// so the customers actually engaging most with Ask Annie — long, active
// sessions — are exactly the ones most likely to eventually push a prompt
// large enough to trip chat.js's own streaming execution cap, and pay more
// in tokens for context that mostly isn't relevant to the current message
// any more. The support widget already knew to cap history somewhere —
// its own escalation excerpt slices to the last 10 messages a few lines
// below its (uncapped) model call — this just applies the same idea to the
// call that actually matters.
//
// Full history still lives in component state (what's rendered) and the
// DB (chat_messages/support_messages, loaded in full up to their own
// separate load caps) — this only bounds what's sent to the model.
export const RECENT_HISTORY_LIMIT = 20

// 2026-08-29 follow-up, flagged directly: a flat slice() means anything
// said more than RECENT_HISTORY_LIMIT messages ago is gone from the
// model's view entirely, not just de-prioritized — a real cost for a long,
// active session ("make it more like the one you wrote earlier for Acme"
// stops working once "earlier" falls outside the window). Rather than just
// raise the limit (which only delays the same cliff), messages just
// outside the verbatim window are condensed into one compact digest and
// kept — real content survives longer, just at lower fidelity — instead of
// being dropped outright. Anything older than BOTH tiers is genuinely gone;
// at that point the conversation is long enough that this is a deliberate,
// bounded trade-off, not an accident.
const DIGEST_TIER_LIMIT = 20
const DIGEST_SNIPPET_CHARS = 100

function snippetOf(content) {
  const text = String(content || '').trim().replace(/\s+/g, ' ')
  return text.length > DIGEST_SNIPPET_CHARS ? `${text.slice(0, DIGEST_SNIPPET_CHARS)}…` : text
}

// Trims (and, for anything just outside the window, condenses) a
// conversation for sending to the model. Returns a NEW array — never
// mutates `messages` — and full-fidelity `messages` is what the component
// keeps rendering and saving regardless of what this returns.
export function recentHistory(messages) {
  if (messages.length <= RECENT_HISTORY_LIMIT) return messages

  let recent = messages.slice(-RECENT_HISTORY_LIMIT)
  // Claude's Messages API requires the array to start with a 'user'
  // message and strictly alternate roles after that. A conversation always
  // strictly alternates from its own start, but a plain slice can still
  // land on an 'assistant' message as the new first element once the
  // conversation is longer than the window — which would make the request
  // to Anthropic itself invalid, a strictly worse outcome than the bug this
  // is fixing. Dropping exactly one leading 'assistant' message always
  // restores a valid, still-alternating, user-first array.
  if (recent[0]?.role !== 'user') recent = recent.slice(1)
  if (!recent.length) return recent

  const older = messages.slice(0, messages.length - recent.length)
  const digestSource = older.slice(-DIGEST_TIER_LIMIT)
  if (!digestSource.length) return recent

  // The digest is folded into the CONTENT of the first retained message
  // rather than inserted as its own array entry — that would add another
  // role to keep validly alternating against `recent`, and this way there's
  // nothing to get wrong: the role sequence of `recent` is untouched, only
  // one message's text gains a prefix.
  const digestText = digestSource.map(m => `${m.role}: ${snippetOf(m.content)}`).join('\n')
  const [first, ...rest] = recent
  const augmentedFirst = {
    ...first,
    content: `[Earlier in this conversation, condensed so it isn't lost entirely, oldest first:\n${digestText}\n(End of earlier context — everything below is the recent conversation, verbatim.)]\n\n${first.content}`,
  }
  return [augmentedFirst, ...rest]
}

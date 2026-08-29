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
// separate load caps) — this only bounds what's sent to the model, so a
// long conversation's cost and latency stay flat instead of growing
// without limit.
export const RECENT_HISTORY_LIMIT = 20

export function recentHistory(messages) {
  return messages.slice(-RECENT_HISTORY_LIMIT)
}

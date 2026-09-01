// 27 Aug 2026, following the pre-launch QA exercise: chat.js has supported a
// `webSearch` flag end-to-end since the scan pipeline's own web-search work
// (same Anthropic web_search_20250305 tool, no new integration), but Ask
// Annie's chat screen never set it — every "what's happening in my market"
// question was answered purely from the model's training data, with nothing
// telling the recruiter it wasn't current. Live-tested against a real
// account on 27 Aug 2026: asked "what's happening in the UK legal market
// right now", Annie answered from what reads as roughly 18-month-stale
// priors (referencing "early 2025... new administration"), while the real
// scan pipeline, asked the same day, was correctly querying for e.g.
// "Technology funding rounds United States August 2026" — so the scans are
// current and the chat isn't.
//
// 2026-09-01, Michael, real report: asked Ask Annie about "Al-Akaria in
// Saudi" — a real company, just not one in his tracked list — and got "isn't
// in my tracked companies" instead of Annie actually looking it up. Root
// cause: this was an ALLOW-list of recency-flavoured phrasing ("latest",
// "current", "this week"), so a bare "tell me about this company" question
// with no recency word never triggered a search at all, and the model
// answered from whatever it already had in context (tracked companies,
// CRM snapshot) rather than researching. Michael's explicit direction: Ask
// Annie should be answerable about ANY company in the market, not just ones
// already in this recruiter's own CRM/watchlist — so search needs to be the
// default, not the exception.
//
// Flipped from an allow-list to a deny-list: search fires for everything
// EXCEPT a message that's clearly a drafting/coaching request (no real-world
// fact to look up — "draft this email", "how should I handle this
// objection") or a bare pleasantry ("thanks", "ok"). Those two categories are
// the only ones actually worth the extra cost/latency of skipping — see
// reserveAnthropicTokens' cap in chat.js for why this still isn't
// unconditional. Kept as its own pure, tested function rather than inlined
// in Chat.jsx so the pattern lists have one place to grow as real usage
// surfaces something this misses, same reasoning as supportEscalation.js's
// own header.
const COACHING_REQUEST_PATTERN = /^\s*(draft|write|prepare|help me (prepare|draft|write)|prep me|role-?play|mock interview|give me talking points|how (should|do|can) (i|we)|what should i say)\b/i

const TRIVIAL_MESSAGE_PATTERN = /^\s*(hi|hello|hey|thanks|thank you|thanks!|ok|okay|great|cool|got it|sounds good|perfect|nice one|nice|yes|no|yep|nope|sure|cheers)[.!]?\s*$/i

export function shouldSearchWeb(message) {
  if (!message || typeof message !== 'string') return false
  const trimmed = message.trim()
  if (!trimmed) return false
  if (COACHING_REQUEST_PATTERN.test(trimmed)) return false
  if (TRIVIAL_MESSAGE_PATTERN.test(trimmed)) return false
  return true
}

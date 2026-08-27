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
// Not turning webSearch on for every message: search adds real per-message
// Anthropic cost and latency (see reserveAnthropicTokens' cap in chat.js),
// and most Ask Annie questions (draft this email, handle this objection,
// prep me for this call) don't need live information at all — only ones
// asking about the actual current state of a market, company, or person do.
// Kept as its own pure, tested function rather than inlined in Chat.jsx so
// the keyword list has one place to grow as real usage surfaces questions
// this misses, same reasoning as supportEscalation.js's own header.
const WEB_SEARCH_TRIGGERS = [
  /\bwhat'?s happening\b/i,
  /\bwhat'?s going on\b/i,
  /\b(latest|current|currently|recent|recently)\b/i,
  /\b(today|this week|this month|right now)\b/i,
  /\bnews\b/i,
  /\bmarket update\b/i,
  /\btrend(s|ing)?\b/i,
  /\bhas .* (announced|launched|raised|acquired|hired)\b/i,
]

export function shouldSearchWeb(message) {
  if (!message || typeof message !== 'string') return false
  return WEB_SEARCH_TRIGGERS.some(re => re.test(message))
}

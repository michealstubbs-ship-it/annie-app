// Server-side twin of src/lib/chatWebSearch.js — duplicated by design, same
// pattern already used for verifyLeadershipChange across both scan files in
// this codebase, rather than importing across the frontend/backend bundler
// boundary (scanShared.js's own header comment explicitly avoids pulling
// src/lib/sectorTaxonomy.js into a Netlify function for exactly this
// untested-bundler-risk reason). Keep this file's WEB_SEARCH_TRIGGERS list
// in sync with src/lib/chatWebSearch.js's if either one changes.
//
// Security fix, 2026-08-27 audit: chat.js used to trust the client's
// `webSearch` boolean verbatim, with the keyword gate only ever applied on
// the frontend (Chat.jsx). Any authenticated caller hitting the endpoint
// directly (not through the UI) could set webSearch:true on every single
// message regardless of content, forcing Annie to pay Anthropic's real
// per-search cost on every call with zero gating — the frontend heuristic
// was cosmetic, not a security boundary. chat.js now re-derives this from
// the actual last user message server-side and only honors the client's
// flag when the message content itself genuinely warrants it.
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

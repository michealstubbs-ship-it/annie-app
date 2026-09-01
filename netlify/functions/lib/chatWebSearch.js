// Server-side twin of src/lib/chatWebSearch.js — duplicated by design, same
// pattern already used for verifyLeadershipChange across both scan files in
// this codebase, rather than importing across the frontend/backend bundler
// boundary (scanShared.js's own header comment explicitly avoids pulling
// src/lib/sectorTaxonomy.js into a Netlify function for exactly this
// untested-bundler-risk reason). Keep this file's logic in sync with
// src/lib/chatWebSearch.js's if either one changes — see that file's own
// header for the full 2026-09-01 reasoning (allow-list -> deny-list, why).
//
// Security fix, 2026-08-27 audit: chat.js used to trust the client's
// `webSearch` boolean verbatim, with the keyword gate only ever applied on
// the frontend (Chat.jsx). Any authenticated caller hitting the endpoint
// directly (not through the UI) could set webSearch:true on every single
// message regardless of content, forcing Annie to pay Anthropic's real
// per-search cost on every call with zero gating — the frontend heuristic
// was cosmetic, not a security boundary. chat.js now re-derives this from
// the actual last user message server-side and only honors the client's
// flag when the message content itself genuinely warrants it. That
// reasoning is unchanged by the 2026-09-01 deny-list flip below — this is
// still a real server-side re-check, just a more permissive one, and the
// per-message search count is still hard-capped by maxSearchUses in chat.js
// and by the daily Anthropic token reservation in aiUsage.js either way.
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

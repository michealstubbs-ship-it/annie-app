// Turns a callChat()/callChatStream() failure into what Chat.jsx should show
// the recruiter — pulled out of Chat.jsx's own catch block so this decision
// is unit-testable without a component-rendering setup (this codebase's
// tests are all plain vitest against lib functions, no React Testing
// Library), matching the pattern already used for shouldSearchWeb in
// chatWebSearch.js.
//
// 2026-08-27: a real report from Michael turned out to be this exact class
// of failure — his Ask Annie tab was open when a deploy went out, and the
// next message he sent failed at the network layer (the tab was still
// running the previous deploy's JS). ErrorBoundary.jsx already auto-recovers
// from this same "stale tab" situation for page-level chunk-load errors, but
// that boundary only catches React render-time errors — a fetch() failure
// inside send()'s own try/catch never reaches it, so Ask Annie was showing
// the bare "something went wrong, try again" apology with no hint that a
// reload (not a resend) is what actually fixes it. Retrying the same message
// without reloading just fails again the same way if the tab is genuinely
// stale.
const NETWORK_ERROR_RE = /fetch|network/i
const GENERIC_APOLOGY = 'Sorry, something went wrong.'

// A server-sent error message (chat.js's own { error } bodies — the monthly
// cap notice, the rate-limit notice, "Not authenticated", etc.) is written
// to be shown to the user verbatim, so it's passed through unchanged and
// never paired with a reload suggestion, which wouldn't fix any of those.
// Everything else — no message at all, the generic 'Request failed' used
// when the server didn't send a JSON body, or a raw browser fetch/network
// error string — is the class of failure a stale tab (or a genuine blip)
// produces, and reloading is the one thing actually worth suggesting for it.
export function describeChatFailure(err) {
  const serverMessage = err?.message
  const hasSpecificMessage = Boolean(serverMessage) && serverMessage !== 'Request failed' && !NETWORK_ERROR_RE.test(serverMessage)

  if (hasSpecificMessage) {
    return { text: serverMessage, reloadSuggested: false }
  }

  return {
    text: `${GENERIC_APOLOGY} If this just started happening, it's usually because we've shipped an update while this tab was open — reloading the page should fix it.`,
    reloadSuggested: true,
  }
}

// 2026-08-27: the confirmed case, not the suspected one. Chat.jsx's
// pre-flight staleBuild.isTabStale() check already knows, before ever
// attempting a request, that this tab's own JS is gone from the server —
// so this message says so plainly instead of hedging with "if this just
// started happening" the way describeChatFailure's generic fallback has
// to when it's only guessing from an ambiguous network error.
export function describeStaleTab() {
  return {
    text: "This tab is running a previous version of Annie — we've shipped an update since you opened it. Reload to get the latest and keep chatting.",
    reloadSuggested: true,
  }
}

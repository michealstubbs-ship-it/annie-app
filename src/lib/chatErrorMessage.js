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

// Shared with Chat.jsx's non-streaming fallback (see its own comment) so
// the two places that need this exact same distinction — "is this message
// something the server deliberately wrote for a human to read, or a raw
// network-shaped failure" — read it from one definition instead of two
// copies quietly drifting apart.
export function isGenericNetworkFailure(err) {
  const serverMessage = err?.message
  return !(Boolean(serverMessage) && serverMessage !== 'Request failed' && !NETWORK_ERROR_RE.test(serverMessage))
}

// A server-sent error message (chat.js's own { error } bodies — the monthly
// cap notice, the rate-limit notice, "Not authenticated", etc.) is written
// to be shown to the user verbatim, so it's passed through unchanged and
// never paired with a reload suggestion, which wouldn't fix any of those.
// Everything else — no message at all, the generic 'Request failed' used
// when the server didn't send a JSON body, or a raw browser fetch/network
// error string — used to be treated as one single class ("a stale tab, or a
// genuine blip") and told to reload.
//
// 2026-08-29 audit fix: that was often just confidently wrong, not merely
// vague — the specific, repeatable failure Michael found (a web-search-
// triggering question, streamed, dying with no content after ~30s) isn't a
// stale tab at all. Root cause: Netlify hard-caps a STREAMING function
// response at 10 seconds of execution ("10 second execution limit. If the
// limit is reached, the response stops streaming." — Netlify's own docs;
// their staff gives the same figure recommending Edge Functions instead,
// since only CPU time counts there, not time spent waiting on a network
// response). callChat()'s non-streaming path instead hits the much more
// generous ~30s limit for a regular synchronous function, so the exact same
// question reliably finishes there. Ask Annie's streaming path retries
// through callChat() first now (see Chat.jsx) specifically to route around
// this — so by the time this function is even reached, that safety net
// already failed too, and a message hedging "if this JUST started
// happening" or flatly blaming a deploy is guessing at a cause it has no
// actual evidence for. Says only what's true either way: it didn't work,
// and reloading is worth trying, without inventing a reason.
export function describeChatFailure(err) {
  if (!isGenericNetworkFailure(err)) {
    return { text: err.message, reloadSuggested: false }
  }

  return {
    text: `${GENERIC_APOLOGY} That's usually a slow connection or a busy moment for Annie — try again, or reload the page if it keeps happening.`,
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

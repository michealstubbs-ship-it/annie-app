import { supabase } from './supabase'
import { withTimeout } from './withTimeout'

// 2026-08-29: getSession() has no timeout of its own — it's a promise that
// can simply never settle (auth still starting up, a browser
// extension/corporate proxy interfering) rather than reject cleanly. With
// no timeout racing it, nothing catches that and every caller of callChat()/
// callChatStream() (Ask Annie, the support widget, Today's Actions, the
// writing-style analyser) just hangs forever with no error surfaced — this
// was the root cause of Today's Actions' reported hang. Same withTimeout()
// helper AuthContext.jsx already uses for its own initial getSession() call,
// same reasoning: turn "never settles" into a real, catchable error instead
// of leaving the caller waiting with nothing to show.
const SESSION_TIMEOUT_MS = 8000

// 2026-08-27: one real report from Michael traced to a request landing in
// the split-second Netlify swaps one deploy's serverless functions for the
// next — a genuine, narrow, self-resolving blip, not a stale tab
// (staleBuild.js's isTabStale() is the fix for that separate cause; this is
// for the moment even a perfectly current tab can still hit). fetch()
// itself throwing (a network-level failure, never even reaching a server
// that could send back a real error body) is exactly the class of thing one
// short retry absorbs — same reasoning, and same shape, as chat.js's own
// retry on Anthropic's transient 429/529, just one layer further out. Only
// a THROWN fetch is retried here — a resolved-but-not-ok response (a real
// 402 monthly cap, 401 auth, 429 rate limit) is a legitimate answer from a
// server that's very much up, and retrying that blindly would just waste a
// second attempt against a cap that isn't going anywhere.
//
// 2026-08-29 audit fix, flagged directly: a THROWN fetch isn't automatically
// the fast, narrow blip described above. If the underlying call ran for most
// of chat.js's own execution ceiling before the connection was finally torn
// down (an idle-connection intermediary killing a slow-but-still-processing
// request, rather than a deploy-swap failing instantly), that's a request
// that was never going to finish in time — retrying it doesn't improve the
// odds, it just makes the caller sit through the same doomed wait a second
// time. Only a throw that happened FAST is retried now; a throw that took a
// while first is treated as a real result and surfaced immediately.
const FAST_FAILURE_MS = 3000

async function fetchWithNetworkRetry(url, options, attempts = 2, delayMs = 400) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    const startedAt = Date.now()
    try {
      return await fetch(url, options)
    } catch (err) {
      lastErr = err
      if (Date.now() - startedAt > FAST_FAILURE_MS) throw err
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

// Every call to the chat function must carry the caller's own Supabase
// session token — chat.js verifies it server-side before spending any
// Anthropic budget. Centralised here so every call site (Ask Annie, the
// support widget, Today's Actions, the writing-style analyser) gets this
// automatically instead of each one needing to remember it.
// Reads the used/limit pair chat.js attaches to every successful reply.
// Returns null on an unlimited plan (the headers are deliberately omitted
// there, so a Growth user never sees a countdown implying a limit exists)
// and on any response where the values aren't two real numbers.
function readChatUsage(resp) {
  // Defensive on purpose: this must never be the thing that breaks a reply.
  // A usage counter is a nicety; the answer is the product. Anything that
  // isn't a well-formed pair of numbers — headers absent entirely, a proxy
  // that stripped them, an older deploy that doesn't send them yet — simply
  // means "no counter to show".
  const headers = resp?.headers
  if (typeof headers?.get !== 'function') return null
  const used = Number(headers.get('X-Annie-Chat-Used'))
  const limit = Number(headers.get('X-Annie-Chat-Limit'))
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null
  return { used, limit, remaining: Math.max(0, limit - used) }
}

export async function callChat({ messages, systemOverride, maxTokens, model, webSearch, maxSearchUses } = {}) {
  const { data: { session } } = await withTimeout(supabase.auth.getSession(), SESSION_TIMEOUT_MS, 'callChat-session')
  const token = session?.access_token
  if (!token) throw new Error('You need to be signed in for that.')

  // chat.js declares a custom Netlify Functions path (config.path =
  // '/api/chat'), which per Netlify's own routing rules means the default
  // '/.netlify/functions/chat' alias no longer resolves at all once a
  // custom path is set — only '/api/chat' does. This was calling the
  // default path, so every caller of callChat() (Ask Annie, the support
  // widget, the writing-style analyser, and Today's Actions' candidate
  // pitch batch) was hitting a real Netlify 404 in production. Same class
  // of bug fixed in Billing.jsx and LinkedInImport.jsx alongside this.
  const resp = await fetchWithNetworkRetry('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages, systemOverride, maxTokens, model, webSearch, maxSearchUses }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error || 'Request failed')
  }

  // 2026-09-01: chat.js now returns the caller's monthly Ask Annie usage in
  // response headers so Chat.jsx can warn a Starter recruiter BEFORE they hit
  // the ceiling. Additive on purpose — `usage` is undefined on an unlimited
  // plan and every existing caller that only destructures { text, citations }
  // is unaffected.
  const body = await resp.json() // { text, citations }
  const usage = readChatUsage(resp)
  // Spread only when there is something to report, so the returned shape is
  // byte-for-byte what it was before on an unlimited plan — no existing
  // caller (or its tests) sees a new key appear out of nowhere.
  return usage ? { ...body, usage } : body
}

// chat.js now streams its reply as NDJSON (one {"type":"delta",...} line per
// chunk of text, a final {"type":"done",...} line with citations) instead of
// buffering the whole reply — see chat.js for why. This reads that stream
// and calls onDelta as each chunk arrives, so Chat.jsx can render
// progressively like a real chat bot rather than showing nothing until the
// whole answer is ready. Kept separate from callChat() above rather than
// changing its return shape, since every other caller (Ask Annie's other
// call sites, the support widget, the writing-style analyser, Today's
// Actions' candidate pitch batch) wants the simple all-at-once { text,
// citations } shape and has no UI built to consume partial chunks.
export async function callChatStream({ messages, systemOverride, maxTokens, model, webSearch, maxSearchUses, onDelta } = {}) {
  const { data: { session } } = await withTimeout(supabase.auth.getSession(), SESSION_TIMEOUT_MS, 'callChatStream-session')
  const token = session?.access_token
  if (!token) throw new Error('You need to be signed in for that.')

  const resp = await fetchWithNetworkRetry('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    // stream:true is what tells chat.js to send back NDJSON instead of its
    // normal { text, citations } JSON body — see chat.js's 2026-08-26 fix
    // comment. Every other caller of callChat() above omits this and keeps
    // getting plain JSON.
    body: JSON.stringify({ messages, systemOverride, maxTokens, model, webSearch, maxSearchUses, stream: true }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error || 'Request failed')
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let citations = []

  function handleLine(line) {
    if (!line.trim()) return
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return // a malformed/partial NDJSON line isn't worth failing the whole reply over
    }
    if (event.type === 'delta') {
      text += event.text
      onDelta?.(event.text, text)
    } else if (event.type === 'done') {
      citations = event.citations || []
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep the last, possibly-incomplete line for the next read()
    for (const line of lines) handleLine(line)
  }
  if (buffer) handleLine(buffer) // stream can end without a trailing newline

  const usage = readChatUsage(resp)
  return usage ? { text, citations, usage } : { text, citations }
}

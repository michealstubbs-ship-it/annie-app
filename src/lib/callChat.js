import { supabase } from './supabase'

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
async function fetchWithNetworkRetry(url, options, attempts = 2, delayMs = 400) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, options)
    } catch (err) {
      lastErr = err
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
export async function callChat({ messages, systemOverride, maxTokens, model, webSearch, maxSearchUses } = {}) {
  const { data: { session } } = await supabase.auth.getSession()
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

  return resp.json() // { text, citations }
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
  const { data: { session } } = await supabase.auth.getSession()
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

  return { text, citations }
}

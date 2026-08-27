import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { reserveAnthropicTokens, reserveChatCall } from './lib/aiUsage.js'
import { getEntitlements, resolveResourceCaps } from './lib/entitlements.js'
import { createTimeoutFetch, fetchWithTimeout } from './lib/scanShared.js'
import { parseIntEnv } from './lib/env.js'
import { shouldSearchWeb } from './lib/chatWebSearch.js'

// Pulls the plain text out of the most recent user turn, whatever shape its
// `content` is in (a plain string for every real caller today, but Anthropic's
// own message format also allows an array of content blocks) — used below to
// re-derive server-side whether this message actually warrants a web search,
// rather than trusting the client's webSearch flag on its own.
function lastUserMessageText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
    }
    return ''
  }
  return ''
}

const DEFAULT_CHAT_PER_MINUTE_CAP = 20

// Turns Anthropic's own SSE stream (data: {...}\n\n lines) into a minimal
// newline-delimited JSON stream Chat.jsx can render token-by-token as it
// arrives, instead of buffering the whole reply before responding — see the
// 2026-08-25 "needs to be functioning like a top AI chat bot" request. NDJSON
// rather than re-emitting raw SSE because the only two things the frontend
// ever needs are "here's some more text" and "you're done, here are the
// citations" — no reason to make it re-implement SSE framing plus
// Anthropic's full event-type vocabulary for that.
function streamAnthropicReplyAsNdjson(anthropicBody) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const reader = anthropicBody.getReader()
  let buffer = ''
  const citations = []

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'done', citations }) + '\n'))
        controller.close()
        return
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() // keep the last, possibly-incomplete line for the next pull()

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (!jsonStr || jsonStr === '[DONE]') continue

        let event
        try {
          event = JSON.parse(jsonStr)
        } catch {
          continue // a malformed/partial event isn't worth failing the whole reply over
        }

        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            controller.enqueue(encoder.encode(JSON.stringify({ type: 'delta', text: event.delta.text }) + '\n'))
          } else if (event.delta?.type === 'citations_delta' && event.delta.citation?.url) {
            citations.push({ url: event.delta.citation.url, title: event.delta.citation.title || event.delta.citation.url })
          }
        } else if (event.type === 'error') {
          // Anthropic can send an error event mid-stream — after streaming has
          // already started, past the point the retry-on-transient-status
          // logic below can help — so surface it as visible text rather than
          // a reply that silently stops mid-sentence with no explanation.
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'delta', text: `\n\n[${event.error?.message || 'Annie lost connection — please try again.'}]` }) + '\n'))
        }
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
    },
  })
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  // 2026-08-26: serviceKey used to be missing from this guard. Every rate/
  // spend cap below (reserveChatCall, getEntitlements, reserveAnthropicTokens)
  // silently no-ops or falls back to an unlimited default when usageClient is
  // null (see below) — so a missing/rotated-wrong SUPABASE_SERVICE_ROLE_KEY
  // used to mean this endpoint kept returning normal 200s with every cap this
  // comment block claims is "checked before the request body is even parsed"
  // silently turned off, rather than the 500 a genuine misconfiguration
  // should produce.
  if (!apiKey || !supabaseUrl || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  // Every caller must be a real, logged-in Annie customer, verified from
  // their OWN Supabase session token, never trusted from the request body.
  // Without this check, this function is a free, unmetered door into the
  // Anthropic API on Annie's own key for anyone who finds the URL — see
  // scan-now-background.js for the same pattern.
  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  // Service-role client only for the usage/rate-limit RPCs below and the
  // tier lookup — not for anything customer-data-related, chat.js never
  // reads or writes any customer's own CRM tables.
  const usageClient = serviceKey ? createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } }) : null

  // A scale-readiness audit (2026-08-22) found this endpoint had no cap on
  // call frequency, and Anthropic spend had no cap anywhere in the
  // codebase at all (unlike Apollo, which does). Both checked before the
  // request body is even parsed, so a rate-limited or over-cap caller never
  // reaches the Anthropic call.
  const perMinuteCap = parseIntEnv(process.env.CHAT_PER_MINUTE_CAP, DEFAULT_CHAT_PER_MINUTE_CAP)
  if (!(await reserveChatCall(usageClient, user.id, perMinuteCap))) {
    return new Response(JSON.stringify({ error: 'Too many requests — please slow down and try again in a minute.' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
  }

  // Plan-tier soft gate (2026-08-24): Starter caps Ask Annie at 100
  // messages/month, Growth and Team are unlimited. Counting real,
  // already-stored user messages in chat_messages rather than adding a new
  // usage-counter table — this endpoint doesn't write chat_messages itself
  // (the frontend does, right after a successful reply — see Chat.jsx), so
  // this counts what's actually been sent, not a separate guess at it.
  // Soft gate means this only ever narrows a perk, never blocks the rest of
  // the product — see entitlements.js's header comment.
  const entitlements = usageClient ? await getEntitlements(usageClient, user.id) : { tier: 'starter', limits: { chatMessagesPerMonth: Infinity } }
  if (Number.isFinite(entitlements.limits.chatMessagesPerMonth)) {
    const startOfMonth = new Date()
    startOfMonth.setUTCDate(1)
    startOfMonth.setUTCHours(0, 0, 0, 0)
    const { count } = await usageClient
      .from('chat_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('role', 'user')
      .gte('created_at', startOfMonth.toISOString())
    if ((count || 0) >= entitlements.limits.chatMessagesPerMonth) {
      return new Response(
        JSON.stringify({ error: `You've used all ${entitlements.limits.chatMessagesPerMonth} Ask Annie messages included this month. Upgrade to Growth for unlimited messages.` }),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      )
    }
  }

  // Parsing the request body is a separate try/catch from the Anthropic
  // call below — a malformed body is a client mistake, not a server fault,
  // and shouldn't be reported the same way a real Anthropic/DB failure
  // would be (this used to be one shared catch-all, which meant a stray
  // non-JSON POST or a client bug got written into error_logs and alerted
  // on exactly like a genuine outage).
  let body
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const { messages, systemOverride, webSearch = false } = body

  // Security fix, 2026-08-27 audit: this used to trust the client's webSearch
  // boolean verbatim — the actual keyword gate (shouldSearchWeb) only lived
  // in Chat.jsx, so any caller hitting this endpoint directly could set
  // webSearch:true on every message regardless of content, forcing real
  // per-search Anthropic cost with no gating at all. Re-derive it here from
  // the real last user message so the client's flag can only ever narrow
  // this (a caller that never asks for search still never gets it), never
  // force a search the message content doesn't actually warrant. See
  // netlify/functions/lib/chatWebSearch.js's own header for why this is a
  // deliberate server-side duplicate of Chat.jsx's client-side copy.
  const effectiveWebSearch = webSearch && shouldSearchWeb(lastUserMessageText(messages))

  // 2026-08-26 fix: chat.js used to ALWAYS request stream:true from
  // Anthropic and ALWAYS respond with NDJSON, regardless of who was
  // calling. That broke every caller still using the plain callChat()
  // client helper (the support widget, Today's Actions' candidate-pitch
  // batch, the writing-style analyser) — they do resp.json() on what is
  // now an NDJSON body, which throws a parse error and lands in their own
  // catch block, which is exactly why the support widget started replying
  // "That didn't go through on my end" on every message the day this
  // shipped. Streaming is now opt-in per request: only callChatStream()
  // (used by Chat.jsx/"Ask Annie") sends stream:true in the body. Every
  // other caller gets back exactly the { text, citations } JSON shape it
  // always has.
  const wantsStream = body.stream === true

  // Server-enforced ceilings. A real, logged-in customer can still send a
  // very large or search-heavy request, this just bounds what any single
  // authenticated call can cost, regardless of what the client sends.
  const maxTokens = Math.min(Number(body.maxTokens) || 1024, 4000)
  const maxSearchUses = Math.min(Number(body.maxSearchUses) || 4, 6)
  const model = body.model === 'claude-sonnet-4-5-20250929' ? body.model : 'claude-haiku-4-5-20251001'

  // 2026-08-26: per-customer-plus-platform-backstop now, same fix as the
  // scan pipeline's Apollo/TheirStack caps — see resolveResourceCaps's own
  // header in entitlements.js. Uses this caller's own tier (already
  // resolved above for the chatMessagesPerMonth gate), so a chat-heavy
  // Growth/Team customer gets real headroom over Starter rather than
  // sharing one platform-wide total with every other customer's chat AND
  // scan calls combined.
  const anthropicCaps = resolveResourceCaps(entitlements.tier).anthropicTokens
  if (!(await reserveAnthropicTokens(usageClient, user.id, maxTokens, anthropicCaps))) {
    return new Response(JSON.stringify({ error: 'Annie has hit her research budget for today — please try again tomorrow.' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const payload = {
      model,
      max_tokens: maxTokens,
      messages,
      stream: wantsStream,
      ...(systemOverride && { system: systemOverride }),
      ...(effectiveWebSearch && {
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearchUses }],
      }),
    }

    // Anthropic occasionally answers a well-formed, well-authenticated
    // request with a transient 429 (rate limited) or 529 (overloaded) —
    // this is the actual mechanism behind the 2026-08-23 "worked once, then
    // failed on the very next message" report: two real messages sent
    // seconds apart, no client bug, just an ordinary upstream blip. One
    // short retry absorbs that class of failure instead of surfacing it to
    // the customer as a dead end.
    const TRANSIENT_ANTHROPIC_STATUSES = [429, 529]
    let resp, errText
    for (let attempt = 0; attempt < 2; attempt++) {
      // 4th-pass audit fix: this was the one Anthropic call site in the
      // codebase using a bare fetch() with no AbortController-backed
      // timeout — every other Anthropic call (the scan pipeline's
      // callAnthropic) already goes through fetchWithTimeout/fetchWithRetry
      // specifically to guard against a hung connection sitting forever
      // (see that helper's own header comment in scanShared.js). A thrown
      // network error here was already caught by the outer try/catch and
      // turned into a proper error response, but a true hang — a
      // connection that neither resolves nor rejects — had nothing forcing
      // it closed, so an Ask Annie / support-widget / writing-style message
      // sent during a stalled network path could hang indefinitely with no
      // error ever surfaced to the customer.
      resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      }, 60000)
      if (resp.ok) break
      errText = await resp.text()
      if (attempt === 0 && TRANSIENT_ANTHROPIC_STATUSES.includes(resp.status)) {
        await new Promise(r => setTimeout(r, 500))
        continue
      }
      break
    }

    if (!resp.ok) {
      // This branch used to return the failure straight to the caller
      // without ever calling reportServerError — every Anthropic-side
      // failure (rate limit, overload, malformed request) was completely
      // invisible in error_logs, which is exactly how the 2026-08-23
      // intermittent chat failures went unexplained: real, repeated
      // production failures, zero trace of any of them anywhere I could
      // check. Logged here now (status + body, truncated) so a repeat is
      // diagnosable instead of invisible, and so error-rate-monitor.js's
      // hourly spike check actually sees it too.
      await reportServerError('chat', new Error(`Anthropic ${resp.status}: ${(errText || 'no body').slice(0, 500)}`), { status: resp.status })
      // Normalized to the same { error } JSON shape as every other response
      // in this file — this used to forward Anthropic's raw error text
      // verbatim with no Content-Type, a different shape from every other
      // branch here.
      return new Response(JSON.stringify({ error: errText || 'Anthropic request failed' }), { status: resp.status, headers: { 'Content-Type': 'application/json' } })
    }

    if (wantsStream) {
      // Anthropic's own SSE body streams straight through to the caller as
      // NDJSON — see streamAnthropicReplyAsNdjson above. Nothing here waits
      // for the reply to finish before responding.
      return new Response(streamAnthropicReplyAsNdjson(resp.body), {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
      })
    }

    // Non-streaming path — unchanged shape every existing caller besides
    // Chat.jsx still expects.
    const data = await resp.json()

    // Collect every text block (web search runs interleave tool_use / tool_result / text blocks)
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text)
    const text = textBlocks.join('\n')

    // Collect citations if the model cited web search results, so the frontend can show real sources
    const citations = []
    for (const block of data.content || []) {
      if (block.type === 'text' && Array.isArray(block.citations)) {
        for (const c of block.citations) {
          if (c.url) citations.push({ url: c.url, title: c.title || c.url })
        }
      }
    }

    return new Response(JSON.stringify({ text, citations }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    await reportServerError('chat', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/chat' }

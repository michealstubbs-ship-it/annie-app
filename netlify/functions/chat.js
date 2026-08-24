import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { reserveAnthropicTokens, reserveChatCall } from './lib/aiUsage.js'

const DEFAULT_ANTHROPIC_DAILY_TOKEN_CAP = 2_000_000
const DEFAULT_CHAT_PER_MINUTE_CAP = 20

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!apiKey || !supabaseUrl || !anonKey) {
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

  // Service-role client only for the usage/rate-limit RPCs below — not for
  // anything customer-data-related, chat.js never reads or writes any
  // customer's own tables.
  const usageClient = serviceKey ? createClient(supabaseUrl, serviceKey) : null

  // A scale-readiness audit (2026-08-22) found this endpoint had no cap on
  // call frequency, and Anthropic spend had no cap anywhere in the
  // codebase at all (unlike Apollo, which does). Both checked before the
  // request body is even parsed, so a rate-limited or over-cap caller never
  // reaches the Anthropic call.
  const perMinuteCap = parseInt(process.env.CHAT_PER_MINUTE_CAP, 10) || DEFAULT_CHAT_PER_MINUTE_CAP
  if (!(await reserveChatCall(usageClient, user.id, perMinuteCap))) {
    return new Response(JSON.stringify({ error: 'Too many requests — please slow down and try again in a minute.' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
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

  // Server-enforced ceilings. A real, logged-in customer can still send a
  // very large or search-heavy request, this just bounds what any single
  // authenticated call can cost, regardless of what the client sends.
  const maxTokens = Math.min(Number(body.maxTokens) || 1024, 4000)
  const maxSearchUses = Math.min(Number(body.maxSearchUses) || 4, 6)
  const model = body.model === 'claude-sonnet-4-5-20250929' ? body.model : 'claude-haiku-4-5-20251001'

  const dailyTokenCap = parseInt(process.env.ANTHROPIC_DAILY_TOKEN_CAP, 10) || DEFAULT_ANTHROPIC_DAILY_TOKEN_CAP
  if (!(await reserveAnthropicTokens(usageClient, maxTokens, dailyTokenCap))) {
    return new Response(JSON.stringify({ error: 'Annie has hit her research budget for today — please try again tomorrow.' }), { status: 429, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const payload = {
      model,
      max_tokens: maxTokens,
      messages,
      ...(systemOverride && { system: systemOverride }),
      ...(webSearch && {
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
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      })
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

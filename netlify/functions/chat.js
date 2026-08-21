import { createClient } from '@supabase/supabase-js'

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!apiKey || !supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'Not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  // Every caller must be a real, logged-in Annie customer, verified from
  // their OWN Supabase session token, never trusted from the request body.
  // Without this check, this function is a free, unmetered door into the
  // Anthropic API on Annie's own key for anyone who finds the URL — see
  // scan-now-background.js for the same pattern.
  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await authClient.auth.getUser(token)
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const body = await req.json()
    const { messages, systemOverride, webSearch = false } = body

    // Server-enforced ceilings. A real, logged-in customer can still send a
    // very large or search-heavy request, this just bounds what any single
    // authenticated call can cost, regardless of what the client sends.
    const maxTokens = Math.min(Number(body.maxTokens) || 1024, 4000)
    const maxSearchUses = Math.min(Number(body.maxSearchUses) || 4, 6)
    const model = body.model === 'claude-sonnet-4-5-20250929' ? body.model : 'claude-haiku-4-5-20251001'

    const payload = {
      model,
      max_tokens: maxTokens,
      messages,
      ...(systemOverride && { system: systemOverride }),
      ...(webSearch && {
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearchUses }],
      }),
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    })

    if (!resp.ok) {
      const err = await resp.text()
      return new Response(err, { status: resp.status })
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
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/chat' }

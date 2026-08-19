export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const body = await req.json()
    const { messages, systemOverride, maxTokens = 1024, model = 'claude-haiku-4-5-20251001' } = body

    const payload = {
      model,
      max_tokens: maxTokens,
      messages,
      ...(systemOverride && { system: systemOverride }),
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
    const text = data.content?.[0]?.text || ''

    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/chat' }

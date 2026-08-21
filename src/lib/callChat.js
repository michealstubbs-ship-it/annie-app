import { supabase } from './supabase'

// Every call to the chat function must carry the caller's own Supabase
// session token — chat.js verifies it server-side before spending any
// Anthropic budget. Centralised here so every call site (Ask Annie, the
// support widget, Today's Actions, the writing-style analyser) gets this
// automatically instead of each one needing to remember it.
export async function callChat({ messages, systemOverride, maxTokens, model, webSearch, maxSearchUses } = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('You need to be signed in for that.')

  const resp = await fetch('/.netlify/functions/chat', {
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

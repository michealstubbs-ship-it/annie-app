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

  // chat.js declares a custom Netlify Functions path (config.path =
  // '/api/chat'), which per Netlify's own routing rules means the default
  // '/.netlify/functions/chat' alias no longer resolves at all once a
  // custom path is set — only '/api/chat' does. This was calling the
  // default path, so every caller of callChat() (Ask Annie, the support
  // widget, the writing-style analyser, and Today's Actions' candidate
  // pitch batch) was hitting a real Netlify 404 in production. Same class
  // of bug fixed in Billing.jsx and LinkedInImport.jsx alongside this.
  const resp = await fetch('/api/chat', {
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

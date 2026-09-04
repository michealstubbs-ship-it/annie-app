// Buying more contact credits.
//
// Packs are fetched rather than hardcoded so the UI can never show a price the
// server does not agree with, and so a pack with no Stripe price configured
// yet is hidden rather than offered as a dead button.
import { supabase } from '../supabase'
import { withTimeout } from '../withTimeout'

async function token() {
  const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000, 'topup-session')
  return session?.access_token || null
}

export async function fetchTopupPacks() {
  try {
    const t = await token()
    if (!t) return []
    const res = await fetch('/api/topup-checkout', { headers: { Authorization: `Bearer ${t}` } })
    if (!res.ok) return []
    const body = await res.json()
    return (body.packs || []).filter(p => p.configured)
  } catch {
    return []
  }
}

// Returns a Stripe Checkout URL for the browser to go to. Nothing here ever
// touches a card number — Stripe's own hosted page handles all of that.
export async function startTopupCheckout(packKey) {
  const t = await token()
  if (!t) throw new Error('You need to be signed in for that.')
  const res = await fetch('/api/topup-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ pack: packKey }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.url) throw new Error(body.error || 'Could not start that purchase.')
  return body.url
}

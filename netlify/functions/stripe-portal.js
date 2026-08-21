// Creates a Stripe Billing Portal session — Stripe's own hosted page where
// a customer updates their card, switches plans, downloads invoices, or
// cancels, entirely on Stripe's side. Annie never builds or maintains any
// of that UI itself, and never touches a card number or handles a
// cancellation directly; this function only ever returns a URL to redirect
// to. Same auth pattern as stripe-checkout.js and chat.js.
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { reportServerError } from './lib/reportError.js'

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = process.env.APP_URL || 'https://app.meetannie.ai'

  if (!stripeKey || !supabaseUrl || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Billing is not configured yet' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
  }

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
  const user = userData.user

  const stripe = new Stripe(stripeKey)
  const supabase = createClient(supabaseUrl, serviceKey)

  try {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!sub?.stripe_customer_id) {
      return new Response(JSON.stringify({ error: 'No billing account yet — choose a plan first' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${appUrl}/dashboard/billing`,
    })

    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('stripe-portal', err, { userId: user.id })
    return new Response(JSON.stringify({ error: 'Could not open billing portal' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/stripe-portal' }

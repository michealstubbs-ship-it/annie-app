// Starts a one-off Stripe Checkout session for a contact-credit top-up.
//
// mode: 'payment', not 'subscription' — a top-up is a single purchase of a
// balance that does not expire, not a recurring charge. Same self-serve
// principle as stripe-checkout.js: nothing here ever touches a card number,
// only a Stripe-generated session URL the browser is redirected to.
//
// Same auth pattern as every other spending endpoint: the caller is identified
// from their OWN Supabase session token, never from anything in the request
// body, so a purchase can never be attributed to a different account.
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { createTimeoutFetch } from './lib/scanShared.js'
import { getEntitlements } from './lib/entitlements.js'
import { packByKey, topupPriceId, packsForDisplay } from './lib/topups.js'
import { jsonError } from './lib/httpError.js'

export default async (req) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = process.env.APP_URL || 'https://app.meetannie.ai'

  if (!supabaseUrl || !anonKey || !serviceKey) return jsonError(503, 'Billing is not configured yet')

  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) return jsonError(401, 'Not authenticated')

  // GET lists the packs, so the UI never hardcodes prices and can tell when a
  // pack has no Stripe price configured yet rather than offering a dead button.
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ packs: packsForDisplay() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed')
  if (!stripeKey) return jsonError(503, 'Billing is not configured yet')

  let body
  try {
    body = await req.json()
  } catch {
    return jsonError(400, 'Invalid request body')
  }

  const pack = packByKey(body.pack)
  if (!pack) return jsonError(400, `Unknown top-up pack: ${body.pack}`)
  const priceId = topupPriceId(pack.key)
  if (!priceId) return jsonError(503, `The ${pack.credits}-credit pack is not available for purchase yet.`)

  const stripe = new Stripe(stripeKey)
  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  try {
    // Credits belong to the TEAM, not the buyer — Team's allowance is shared,
    // and a top-up has to land in the same pool the allowance does or the
    // meter would disagree with itself.
    const { teamId } = await getEntitlements(supabase, user.id)
    if (!teamId) return jsonError(400, 'No active team found for this account')

    // Reuse the Stripe customer already on file so a top-up shows on the same
    // customer record as the subscription, rather than creating a duplicate.
    const { data: existingSub } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    let customerId = existingSub?.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      })
      customerId = customer.id
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/dashboard/intelligence-feed?topup=success`,
      cancel_url: `${appUrl}/dashboard/intelligence-feed?topup=cancelled`,
      // The webhook grants off the PRICE ID it sees on the completed session,
      // not off this metadata — see packFromPriceId's note. These are carried
      // for the audit trail and for support questions, not as the source of
      // truth for what to grant.
      metadata: {
        supabase_user_id: user.id,
        team_id: teamId,
        topup_pack: pack.key,
        topup_credits: String(pack.credits),
      },
    })

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    await reportServerError('topup-checkout', err, { pack: body?.pack })
    return jsonError(500, 'Could not start that purchase. Please try again.')
  }
}

export const config = { path: '/api/topup-checkout' }

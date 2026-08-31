// Entry point for meetannie.ai's marketing-site "Start free trial" buttons.
// Unlike stripe-checkout.js (which requires an already-logged-in Annie
// user), this runs BEFORE any Annie account exists — a visitor picks a
// plan on the public pricing page and lands here with just a tier+interval,
// no session. Stripe Checkout collects their email and card itself; the
// Annie account is created afterward, in stripe-webhook.js's
// checkout.session.completed handler, once payment is confirmed. This is a
// plain GET+redirect (not a fetch) so a bare marketing-site <a href> works
// with zero JS.
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { priceIdFor } from './lib/stripeShared.js'
import { alertIfConfigured, createTimeoutFetch } from './lib/scanShared.js'
import { parseIntEnv } from './lib/env.js'

const TEAM_MIN_SEATS = 3
const VALID_TIERS = ['starter', 'growth', 'team']

// 2026-08-25, per Michael — simplified deliberately, replacing an earlier
// version that depended on a live Stripe promotion code/coupon existing
// (which broke silently the day that coupon didn't actually exist in live
// Stripe — see the incident this replaced). ANNIE100 is now just a literal
// code checked in this file, no Stripe object required to keep it working:
//   - a normal signup gets a real card collected up front, standard 7-day
//     trial.
//   - `?code=annie100` (case-insensitive — Michael types it in caps) skips
//     the card entirely, same 7-day trial as everyone else — the only
//     difference is no card required to start.
// The only way anyone gets this is a link Michael hands out directly —
// there's no self-serve box for it anywhere, so that act of sending the
// link out IS the approval step, deliberately, rather than building an
// actual approval workflow Stripe has no native way to support.
// 2026-08-31, per Michael: this used to give 30 days instead of 7 — cut
// back to the same 7-day length as a normal signup, no-card is the only
// thing this code still buys. When the trial ends with no card on file,
// Stripe itself creates an invoice, that invoice fails to charge (no
// payment method), and stripe-webhook.js's invoice.payment_failed /
// trial_will_end handlers send the customer an email pointed at the
// billing portal — same account, same data, they're just adding a card,
// never a new signup.
const FREE_MONTH_CODE = 'annie100'
const DEFAULT_TRIAL_DAYS = 7

// 2026-08-26: the free-month link had no limit on it at all -- no expiry,
// no per-use cap, no rate limiting, and (by design, so a bare marketing-
// site <a href> works with zero JS) no Turnstile check either. It's a
// plain GET link with the code visible in the URL text itself -- the
// moment it's shared anywhere public (a screenshot, a forum post, a
// forwarded email), anyone can mint unlimited free trials with no card on
// file. Trialing accounts aren't a lesser tier internally (LIVE_STATUSES
// in adminDashboard.js treats them the same as active), so each one spends
// real Apollo/Anthropic/TheirStack credit against zero revenue.
//
// This caps total redemptions rather than picking an arbitrary expiry
// date or per-email check (Stripe Checkout hasn't collected an email yet
// at this point in the flow, so a per-email dedup would have to live in
// stripe-webhook.js instead -- a reasonable future addition if this cap
// alone isn't enough). Configurable via FREE_MONTH_MAX_REDEMPTIONS so
// Michael can raise it, lower it, or effectively retire the code without a
// deploy. Hitting the cap never breaks the link or shows an error --
// same "soft gate, nobody hits a dead end" philosophy as entitlements.js
// -- it just quietly falls back to the standard 7-day-trial-with-card
// flow, and alerts so Michael knows the cap was reached and can decide
// whether to raise it.
const DEFAULT_FREE_MONTH_MAX_REDEMPTIONS = 50

// Counts real redemptions (subscriptions.free_month_code, persisted by
// stripe-webhook.js once a checkout actually completes — see its own
// header) against the cap. Deliberately FAILS CLOSED (denies the free
// month, falls back to the standard flow) if Supabase isn't configured or
// the query errors — the opposite of this codebase's usual fail-open
// reservation pattern (reserveApolloCredits etc.), because the risk here
// is asymmetric: fail-open on a credit reservation costs a few extra
// dollars of Apollo spend at worst, but fail-open here would silently
// remove the one cap standing between this link and unlimited free-trial
// abuse. The cost of failing closed is small and recoverable (one visitor
// gets the standard 7-day-with-card flow instead of the free month, on a
// day Supabase happens to be having trouble) — never a broken checkout.
async function freeMonthRedemptionAllowed() {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return false

  const maxRedemptions = parseIntEnv(process.env.FREE_MONTH_MAX_REDEMPTIONS, DEFAULT_FREE_MONTH_MAX_REDEMPTIONS)
  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })
  const { count, error } = await supabase
    .from('subscriptions')
    .select('user_id', { count: 'exact', head: true })
    .eq('free_month_code', FREE_MONTH_CODE)

  if (error) {
    console.error('[start-trial-checkout] free-month redemption count failed, denying the free month for this request:', error.message)
    return false
  }
  if (count >= maxRedemptions) {
    await alertIfConfigured(`:warning: start-trial-checkout: free-month code "${FREE_MONTH_CODE}" has hit its redemption cap (${maxRedemptions}) — new requests are quietly falling back to the standard 7-day/card-required signup. Raise FREE_MONTH_MAX_REDEMPTIONS in Netlify to allow more, or leave it as-is to retire the code.`)
    return false
  }
  return true
}

export default async (req) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY
  const appUrl = process.env.APP_URL || 'https://app.meetannie.ai'
  const marketingUrl = process.env.MARKETING_URL || 'https://meetannie.ai'

  if (!stripeKey) {
    return new Response('Billing is not configured yet', { status: 503 })
  }

  const url = new URL(req.url)
  const tier = url.searchParams.get('tier')
  const interval = url.searchParams.get('interval') === 'year' ? 'year' : 'month'
  let isFreeMonth = (url.searchParams.get('code') || '').trim().toLowerCase() === FREE_MONTH_CODE

  if (isFreeMonth) {
    isFreeMonth = await freeMonthRedemptionAllowed()
  }

  if (!VALID_TIERS.includes(tier)) {
    return new Response(`Unknown plan: ${tier}`, { status: 400 })
  }

  const priceId = priceIdFor(tier, interval)
  if (!priceId) {
    return new Response(`Unconfigured plan: ${tier}/${interval}`, { status: 400 })
  }

  const stripe = new Stripe(stripeKey)

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{
        price: priceId,
        quantity: tier === 'team' ? TEAM_MIN_SEATS : 1,
        ...(tier === 'team' ? { adjustable_quantity: { enabled: true, minimum: TEAM_MIN_SEATS, maximum: 100 } } : {}),
      }],
      allow_promotion_codes: true,
      // 'if_required' only skips the card because a trial alone already
      // makes today's total $0 — true for every signup, not just the free-
      // month one. Only the free-month link is allowed to skip it; a
      // normal signup always collects a card up front on purpose (the
      // actual "trial, then auto-charge unless cancelled" pattern).
      payment_method_collection: isFreeMonth ? 'if_required' : 'always',
      success_url: `${appUrl}/welcome?checkout=success`,
      cancel_url: `${marketingUrl}/#pricing`,
      subscription_data: {
        metadata: { tier, source: 'marketing_site_signup', ...(isFreeMonth ? { free_month_code: FREE_MONTH_CODE } : {}) },
        // 2026-08-31: both paths use the same trial length now — no-card
        // is the only thing the free-month code still changes, see the
        // header comment.
        trial_period_days: DEFAULT_TRIAL_DAYS,
      },
    })

    return new Response(null, { status: 302, headers: { Location: session.url } })
  } catch (err) {
    console.error('[start-trial-checkout] failed:', err.message)
    return new Response('Could not start checkout', { status: 500 })
  }
}

export const config = { path: '/api/start-trial-checkout' }

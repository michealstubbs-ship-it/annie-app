# Stripe setup

The code is built and deployed; nothing charges anyone until these steps are done. Until `STRIPE_SECRET_KEY` is set, `stripe-checkout` and `stripe-portal` return a graceful "Billing is not configured yet" error instead of breaking.

## 1. Create the products and prices

In the Stripe Dashboard (or via the Stripe MCP connector, if you connect it), create 3 products, each with a monthly and an annual price — 6 prices total. These are a proposal from `Annie-Pricing-Strategy.md`, not locked in; change the numbers before creating them if you want different figures.

| Product | Monthly price | Annual price (billed yearly) |
|---|---|---|
| Annie Starter | $79.00 | $69.00 × 12 = $828.00/year |
| Annie Growth | $149.00 | $129.00 × 12 = $1,548.00/year |
| Annie Team (per seat) | $129.00 | $109.00 × 12 = $1,308.00/year |

For Team, the code sets a 3-seat minimum at checkout — the price itself is just a normal per-unit recurring price, no special Stripe configuration needed for the minimum, that's enforced in `stripe-checkout.js`.

## 2. Set Netlify environment variables

Copy each price's ID (`price_...`) from the Stripe Dashboard into these Netlify env vars:

```
STRIPE_SECRET_KEY=sk_live_... (or sk_test_... while testing)
STRIPE_WEBHOOK_SECRET=whsec_...   (from step 3 below)
STRIPE_PRICE_STARTER_MONTHLY=price_...
STRIPE_PRICE_STARTER_YEARLY=price_...
STRIPE_PRICE_GROWTH_MONTHLY=price_...
STRIPE_PRICE_GROWTH_YEARLY=price_...
STRIPE_PRICE_TEAM_MONTHLY=price_...
STRIPE_PRICE_TEAM_YEARLY=price_...
APP_URL=https://app.meetannie.ai
```

Strongly recommend setting the `sk_test_...` key and testing the full flow (real test-mode checkout, a test webhook event, cancelling via the portal) before ever switching to `sk_live_...`.

## 3. Register the webhook

In Stripe Dashboard → Developers → Webhooks → Add endpoint:

- URL: `https://app.meetannie.ai/.netlify/functions/stripe-webhook`
- Events to send: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

Stripe shows the signing secret (`whsec_...`) once the endpoint is created — that's `STRIPE_WEBHOOK_SECRET` above.

## 4. Enable the Customer Portal

Stripe Dashboard → Settings → Billing → Customer portal. Turn it on, and decide there whether customers can switch plans themselves (the portal supports this, and `stripe-webhook.js` already handles a plan-change event correctly since it reads the live price ID off the subscription rather than stale checkout metadata) or only cancel/update payment method.

## 5. Free trial (already built in)

Every first-time subscriber gets 7 days free — `stripe-checkout.js` sets `trial_period_days: 7` automatically. Nothing to configure in Stripe for this part. A card is required upfront (standard for Stripe Checkout + trials); if nobody cancels, the first real charge fires automatically on day 8.

Trial eligibility is gated in code, not in Stripe: a customer only gets the 7 days if they've never had a `subscriptions` row before (see `stripe-checkout.js` — `trialEligible = !existingSub`). Someone who cancels during or after their trial and starts a new checkout later is billed from day one on the new subscription, same as most SaaS "one trial per customer" policies. If you'd rather allow repeat trials (e.g. for testing), that's the one line to remove.

## 6. A 100%-off code to comp people

This needs no code change — Checkout already has `allow_promotion_codes: true`, which puts a promo-code entry field on Stripe's own hosted checkout page. You just need to create the coupon and a code for it:

1. Stripe Dashboard → Product catalog → Coupons → **Create coupon**.
   - Type: **Percentage discount**, 100%.
   - Duration: **Forever** if you want the person to genuinely never be charged, for as long as they stay subscribed. Pick **Once** instead if you only want their first invoice free (they'd be charged from month/year 2 onward), or **Repeating** for a fixed number of months.
2. Stripe Dashboard → Product catalog → Coupons → open the coupon you just made → **Create promotion code**.
   - Set the code text to whatever you want to hand out (e.g. `FOUNDERSCIRCLE`) — this is what the person actually types at checkout, separate from the internal coupon.
   - Optionally cap how many times it can be redeemed, or set an expiry date, right there.
3. Give that code to whoever you want comped. At checkout they click "Add promotion code," type it in, and their total drops to $0 — Stripe still asks for a card on file (needed to resume billing later if the coupon has an end date), but never charges it while the 100% discount applies.

Because the free trial (step 5) and a 100%-off code both result in $0 due today, they stack without conflict — someone using a comp code just never reaches a real charge at the end of the trial either.

## What's deliberately NOT built yet

- **No paywall.** The Billing page exists, but nothing in the app currently checks `subscriptions.status` to gate access. Every onboarded account has full access regardless of billing state. Whether/how to enforce that (hard paywall vs. relying on the trial alone vs. something else) is a product decision, not something to bake into a billing-infrastructure pass — flag it explicitly when you're ready to decide.
- **No proration UI beyond what Stripe's own portal shows.** Plan switches go through Stripe's hosted portal, which handles proration on its own.

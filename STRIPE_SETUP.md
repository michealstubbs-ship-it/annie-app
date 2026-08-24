# Stripe setup

The code is built and deployed; nothing charges anyone until these steps are done. Until `STRIPE_SECRET_KEY` is set, `stripe-checkout` and `stripe-portal` return a graceful "Billing is not configured yet" error instead of breaking.

## 1. Create the products and prices

In the Stripe Dashboard (or via the Stripe MCP connector, if you connect it), create 3 products, each with a monthly and an annual price — 6 prices total. These are the numbers from the pricing page (2026-08-24) — `Billing.jsx`'s `TIERS` array already displays them, this step just needs the real Stripe objects to exist behind them.

| Product | Monthly price | Annual price (billed yearly) |
|---|---|---|
| Annie Starter | $79.00 | $69.00 × 12 = $828.00/year |
| Annie Growth | $129.00 | $109.00 × 12 = $1,308.00/year |
| Annie Team (per seat) | $99.00 | $84.00 × 12 = $1,008.00/year |

For Team, the code sets a 3-seat minimum at checkout — the price itself is just a normal per-unit recurring price ($99/seat, or $297/mo for the 3-seat minimum — same number, Stripe just multiplies it), no special "bundle" pricing object needed. No special Stripe configuration for the minimum either, that's enforced in `stripe-checkout.js`.

Stripe prices are immutable once created — if you're changing the numbers above from whatever's currently live (e.g. Growth was previously $149/$129), create new Price objects rather than trying to edit the old ones, and repoint the env vars below at the new IDs. `subscriptions` had zero live rows when this repricing was written (2026-08-24), so there was nothing to grandfather — if that's no longer true by the time you do this, decide first whether existing subscribers move to the new price or keep their old one (Stripe's Customer Portal and `stripe.subscriptions.update` both support either).

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

- URL: `https://app.meetannie.ai/api/stripe-webhook` — **not** `/.netlify/functions/stripe-webhook`. `stripe-webhook.js` declares a custom Netlify Functions path (`config.path = '/api/stripe-webhook'`), which means the old default alias no longer resolves at all once a custom path is set (same class of bug already found and fixed in `callChat.js`, `Billing.jsx`, and `LinkedInImport.jsx` — see `callChat.js`'s comment). **If your live Stripe webhook is currently registered at the old `.netlify/functions/` URL, it's been silently 404ing on every event** — checkout completions would never write a `subscriptions` row. Worth checking your Dashboard's webhook endpoint list before relying on this.
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

## 7. Teams and the soft-gate paywall (2026-08-24)

Confirmed with Michael: every account is a "team" from day one, even a solo Starter/Growth signup (a team of one) — see `supabase-migrations/2026-08-24-teams-and-shared-crm.sql`. Team-tier's "shared target-company list" is real: every active member of a team sees and edits the same contacts, deals, candidates, meetings, and signals — RLS is scoped by `team_id`, not `user_id`, across every operational table.

The paywall itself is a **soft gate**, not a lockout: nobody loses access to core product (CRM, Today's Actions, Intelligence Feed) for lacking an active subscription. Only tier-specific perks are gated — today that's Ask Annie's message cap (Starter: 100/month, Growth/Team: unlimited), enforced server-side in `chat.js` via `netlify/functions/lib/entitlements.js`. Onboarding's deeper research pass and LinkedIn re-import-on-demand are advertised as Growth+ perks on the pricing page but aren't wired to `entitlements.js` yet — flagging that gap explicitly rather than letting the pricing page overclaim silently.

**Team invites** go through `team-invite.js` (owner-only, seat-capped). A new person gets a real account-creation email via Supabase's `admin.inviteUserByEmail` — which means **this only works in production if Supabase Auth has a real SMTP provider configured** (Supabase's own default mailer is rate-limited and meant for testing, not real customer invites). Check Supabase Dashboard → Authentication → Emails → SMTP Settings before relying on this for real teammates.

## What's deliberately NOT built yet

- **Onboarding research depth and LinkedIn re-import-on-demand aren't tier-gated yet**, despite being advertised as Growth+ perks (see section 7 above) — `entitlements.js` supports it (`deepOnboardingResearch`, `linkedinReimportOnDemand` are already on the returned object), the call sites just don't check it yet.
- **No proration UI beyond what Stripe's own portal shows.** Plan switches go through Stripe's hosted portal, which handles proration on its own.
- **No "leave team" self-service** — a teammate can be removed by the owner (`team-remove-member.js`), but there's no button for a member to remove themselves. Same owner-only removal endpoint would need a self-targeting allowance to add this.
- **A removed teammate doesn't get a fresh personal team automatically** — they keep their login but have no team at all until re-invited or given a new account. Flagged as a real product decision in `team-remove-member.js`'s header comment, not resolved here.

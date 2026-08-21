Annie Pricing Strategy
======================

*Cost model and competitor analysis, prepared 21 Aug 2026, to ground the Stripe/billing decision.*

This is the analysis you asked for before we touch Stripe: what Annie actually costs to run per customer, and where that positions us against what recruiters already pay for the tools Annie replaces or bundles. The pricing tiers below are a starting proposal, not a final call — the real decision (and the "two-fold" question on how Stripe should implement it) is flagged at the end for you.

TL;DR
-----

Running one active customer through Annie's current scan cadence costs roughly **$11–16/month** in Anthropic and Apollo spend, plus a small, shrinking slice of fixed Supabase/Netlify hosting. Comparable tools — a recruitment CRM, a contact-enrichment API, and an AI drafting assistant, which is roughly what Annie replaces — separately cost recruiters anywhere from $150 to $400+/month today. That gap is the pricing room. A **$79 / $149 / $129-per-seat-team** three-tier structure (detailed below) would sit comfortably inside that gap and clear 80%+ gross margin at every tier.

One thing this research surfaced that isn't about pricing at all: **Adzuna's free API tier caps out around 8 active customers** at current scan volume. Worth fixing before this becomes a real constraint — flagged in Part 1.

---

Part 1 — What Annie actually costs to run
------------------------------------------

This is built from the live code (`scanShared.js`, `intelligence-scan.js`, `scan-now-background.js`, `chat.js`, `TodaysActions.jsx`), not guesswork about what a scan "should" cost. Token counts for web-search-grounded calls can't be known precisely without real telemetry (search results returned to the model vary run to run), so figures below are stated as ranges with the assumption behind each one — treat the totals as directionally right, not exact to the cent, until we're logging real `usage` data from the Anthropic responses (worth adding, see the note at the end of this section).

### Per-customer, ongoing (steady state, after onboarding)

| Cost driver | What it does | Model / rate | Estimated monthly cost per customer |
|---|---|---|---|
| Recurring scan | Runs every 12h (`intelligence-scan.js`), ~60 calls/mo | Claude Haiku 4.5 ($1/$5 per M tokens in/out) + web search ($10/1,000 searches), ~6 searches/call assumed | **$4.00–$4.60** |
| Apollo enrichment on new signals | Contact + company verification per new signal found by the recurring scan | ~1.5 Apollo credits/signal, ~4 new signals/day assumed, credit cost $0.037–$0.059 depending on Apollo plan tier | **$6.70–$10.60** |
| Today's Actions | AI-written copy for CRM-derived daily actions, cached 24h, runs ~1x/day for an active user | Claude Haiku 4.5, no web search | **$0.20–$0.30** |
| Ask Annie chat | On-demand BD assistant, no web search tool attached | Claude Haiku 4.5, ~10 messages/mo assumed for a typical active user | **$0.03–$0.15** |
| Support chat | Product support widget + topic tagging | Claude Haiku 4.5, light/occasional use | **$0.05–$0.15** |
| **Subtotal — variable cost per active customer** | | | **≈ $11.00–$15.80/month** |

### One-time, per new signup

| Cost driver | What it does | Estimated one-time cost |
|---|---|---|
| Onboarding scan | Up to 4 parallel sector-group calls + a conditional broaden pass, over-resourced deliberately for a good first impression | Claude Sonnet 4.5 ($3/$15 per M) + web search, ~$0.13/group call | **≈ $0.55–$0.70** |
| Apollo enrichment (onboarding) | `discoverHotCompanies` × up to 4 groups + contact/company verification on up to 12 signals | ~22 credits assumed | **≈ $1.00–$1.10** |
| **Subtotal — one-time per signup** | | | **≈ $1.60–$1.80** |

### Fixed infrastructure (shared across all customers, not per-seat)

| Service | Plan | Monthly cost | Notes |
|---|---|---|---|
| Supabase | Pro | $25/mo base (+ usage past 8GB db / 250GB egress / 100k MAU) | Amortizes fast — under $1/customer once past ~50 active customers |
| Netlify | Pro | From $20/mo, credit-based (functions compute 10 credits/GB-hour, deploys, bandwidth) | Background scan functions are the main draw here; worth watching as scan frequency or customer count grows |
| Companies House API | — | **Free** | UK gov open register, 600 req/5min limit — no scaling concern at Annie's volume |
| Adzuna API | Free tier | **Free, up to ~1,000 calls/month** | **Flagged below** |

### ⚠️ A real constraint this research surfaced, unrelated to pricing

Adzuna's free tier is ~1,000 API calls/month. Annie's recurring scan calls `discoverAdzunaJobs` twice a day per customer (up to 2 country calls each) — roughly **4 calls/day/customer**, before the one-time onboarding burst (up to 8 calls). At that rate, the free tier is exhausted at **around 8 active customers**. The call fails soft (`if (!resp.ok) continue`), so nothing breaks loudly — Adzuna-sourced `job_posting_unclaimed` signals just silently stop appearing once the cap is hit, which is worse than an error because nobody gets paged. Adzuna doesn't publish paid-tier pricing (contact-sales only). This is worth resolving — either budget for Adzuna's paid tier or add the same kind of alerting/degradation-visibility already built for Apollo — well before customer count 8 arrives. Separate task from Stripe; flagging it here because it surfaced directly from this cost audit.

### Bottom line

**All-in COGS per active customer, steady state: roughly $12–17/month**, trending toward the lower end as Supabase/Netlify fixed costs amortize across a larger base and as Apollo volume tiers improve the per-credit rate. Call it **~$13/month** as a working central estimate for pricing purposes, and plan to replace this with real measured numbers once there's a month of live usage — the single highest-leverage thing to add next is logging the `usage` object Anthropic returns on every call (input/output tokens, search count) into a table, so this whole section becomes measured rather than modeled.

---

Part 2 — What recruiters already pay for what Annie replaces
----------------------------------------------------------------

Annie sits across two categories recruiters currently buy separately: a **recruitment CRM/ATS** (contact and pipeline management) and a **sales/BD intelligence tool** (signal discovery, contact enrichment, verified data) — plus the AI drafting layer neither category does well on its own.

| Tool | Category | Price | What's included |
|---|---|---|---|
| Vincere | Recruitment CRM | £69/user/mo base, +£25–349/mo/agency for AI add-on tiers | CRM/ATS; AI packages (candidate scoring, enrichment) are a separate paid layer on top, 12-month minimum contract |
| JobAdder | Recruitment CRM | ~$95–160/user/mo (custom quote only) | CRM/ATS across 4 tiers; AI features gated to higher tiers |
| Loxo | Recruitment CRM + sourcing | $169/user/mo (Basic, no AI) → custom (Professional, AI sourcing + 250 contact credits/user/mo) | AI sourcing and outreach automation paywalled well above the Basic price point |
| Apollo.io | Contact data / sales intelligence | $59–149/user/mo | Contact search, enrichment, sequences — not recruitment-specific, no BD "signal" layer |
| Cognism | Sales intelligence (enterprise) | $1,500–2,500/user/year + $15k–25k platform fee | Compliant contact data at scale; enterprise-only pricing model, not SMB-friendly |
| Clay | AI enrichment/workflow | $149–800/mo (credit-based, team-wide not per-seat) | Flexible AI enrichment workflows; requires real setup effort to configure per use case, general-purpose not recruitment-specific |
| Warmly | Intent/signal platform | $10k–30k/year ($833–2,500/mo) | Website visitor deanonymization + intent signals; GTM-general, not recruitment-specific, priced for larger teams |

**Where Annie sits:** a recruiter assembling the equivalent stack today — a CRM ($69–169/user/mo) plus a contact-intelligence tool ($59–149/user/mo) plus their own time spent manually reading news for BD triggers and drafting outreach — is realistically at **$150–350+/month per seat**, before counting the time cost of doing the signal-hunting and drafting by hand, which is Annie's actual core product. Nothing in this list is recruitment-vertical AND does signal discovery AND verifies contacts AND drafts in the recruiter's own voice. That combination is the wedge.

---

Part 3 — Recommended tier structure (proposal, not final)
--------------------------------------------------------------

Built to clear ~80%+ gross margin at the ~$13/month COGS estimate from Part 1, and priced under the "buy Apollo + a CRM separately" alternative from Part 2.

| Tier | Price | Target customer | What's gated |
|---|---|---|---|
| **Starter** | $79/mo per seat ($69/mo billed annually) | Solo recruiter or small desk | Full product — CRM, Today's Actions, Intelligence Feed, Ask Annie (capped, e.g. 100 messages/mo), standard scan cadence |
| **Growth** | $149/mo per seat | Established biller wanting more AI usage / faster onboarding depth | Everything in Starter + higher Ask Annie cap, deeper onboarding scan, LinkedIn re-import on demand, priority support |
| **Team** | From $129/mo per seat, 3-seat minimum | Small-to-mid agency | Growth features + shared target-company list across the team, admin/insights visibility, volume discount mirroring how Apollo structures its own Organization tier |

At $79/mo and ~$13/mo COGS, gross margin is ~83%. At $149/mo it's ~91%. Even the discounted Team-tier floor of $129/mo clears ~90%. There's real room to move these numbers in either direction depending on how aggressively you want to price against Apollo's $59 floor versus Loxo/Cognism's much higher ceiling — this is a proposal to react to, not a recommendation to lock in blind.

Two structural choices worth deciding deliberately rather than defaulting into:

- **Per-seat flat pricing** (like Vincere, JobAdder, Apollo) is simpler to sell and bill, but doesn't flex if one recruiter runs Ask Annie hard and another barely touches it — everyone pays the same regardless of actual AI/Apollo spend they generate.
- **Metered/credit pricing on top of a base seat fee** (like Clay, Loxo's "250 contact credits/user/mo") protects margin more precisely against the real cost drivers in Part 1 (specifically Apollo enrichment, the single biggest variable cost), at the price of more billing complexity and a less predictable bill for the customer.

---

Part 4 — Before I build anything in Stripe
--------------------------------------------

You mentioned Stripe implementation is "two-fold" — I don't want to guess at what the two paths are and build the wrong one, so this needs your call before I start. Some genuine forks it could be:

- **Per-seat flat tiers vs. usage-metered billing** (the structural choice above) — these are architecturally different in Stripe (fixed subscription prices vs. metered billing/usage records).
- **Self-serve checkout vs. sales-assisted contracts** — a recruiter signing up and entering a card directly through Stripe Checkout, versus larger agency deals that need an invoice/contract flow outside self-serve.
- **Monthly vs. annual billing**, and whether annual gets a discount (common in this space — Vincere requires 12-month minimum, others discount ~15-20% for annual).

Let me know which split you meant, and whether the tier numbers above are in the right zone before I go further — happy to adjust the model if you want to price more aggressively against Apollo's floor, or push upmarket toward the Cognism/Loxo end instead.

---

Appendix — sources
------------------

- [Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing) — Claude Haiku 4.5 ($1/$5 per M tokens), Claude Sonnet 4.5 ($3/$15 per M tokens)
- [Anthropic web search tool pricing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) — $10 per 1,000 searches
- [Apollo API credit pricing](https://docs.apollo.io/docs/api-pricing) — ~1 credit per search/enrichment call
- [Apollo.io plan pricing](https://www.warmly.ai/p/blog/apollo-pricing) — $59–149/user/mo, 1,000–4,000 export credits/mo by tier
- [Supabase pricing](https://uibakery.io/blog/supabase-pricing) — Pro $25/mo base
- [Netlify credit-based pricing](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/) — Pro from $20/mo
- [Adzuna API free tier](https://jobspipe.dev/blog/adzuna-api) — ~1,000 calls/month free
- [Companies House API rate limiting](https://developer-specs.company-information.service.gov.uk/guides/rateLimiting) — free, 600 requests/5min
- [Vincere pricing](https://www.vincere.io/pricing/) — £69/user/mo CRM + £25–349/mo AI add-ons
- [Loxo pricing](https://www.pin.com/blog/loxo-pricing/) — $169/user/mo Basic, custom Professional
- [JobAdder pricing](https://avahr.com/jobadder-pricing/) — ~$95–160/user/mo
- [Cognism pricing](https://www.warmly.ai/p/blog/cognism-pricing) — $1,500–2,500/user/year + platform fee
- [Clay pricing](https://www.warmly.ai/p/blog/clay-pricing) — $149–800/mo, credit-based
- [Warmly pricing](https://www.warmly.ai/p/pricing) — $10k–30k/year

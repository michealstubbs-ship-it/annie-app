Annie Cost Analysis — 50 and 100 Clients
==========================================

*Refreshed 26 Aug 2026. Supersedes the earlier 26 Aug version of this file — that version still treated TheirStack as an unconfirmed, self-serve-priced open question. Both are now resolved: TheirStack is confirmed live in production (verified directly against Netlify's own environment variables), and its real bulk rate is now known from a live pricing-page check Michael did himself, not the published self-serve rate. Same methodology as before: figures are built from the live code's actual call patterns and confirmed API rates, not guesses — stated as ranges where the input genuinely varies run to run.*

**Mix assumed, per your numbers:** 70% Starter, 20% Growth, 10% "multiple seats." "Multiple seats" is mapped to the **Team** tier, which is the only per-seat plan in the live pricing (`src/lib/pricing.js`) — 3-seat minimum, $99/mo/seat. I've assumed each Team account carries exactly the 3-seat minimum; if your real Team accounts average more seats, revenue and Team COGS both scale up together (margin % is unaffected — see the seat-count note at the end).

---

### ✅ Resolved this session: TheirStack is live, and here's what it actually costs

The earlier version of this doc flagged TheirStack as an open question and asked you to confirm it was active. It is — confirmed directly from Netlify's own environment variables, not inferred. Two other things got pinned down at the same time:

- **Real cadence:** `discoverTheirStackJobs` is called once per scheduled scan, unconditionally, twice a day, at a fixed 10 credits per call — 20 credits/day, ≈600 credits/month, **per customer, on every tier** (the call isn't tier-gated the way Apollo's retry pass is). This matches your own "600 credits a month" number exactly. A once-a-day-only version of this was considered and built, then deliberately reverted: halving the calls would have doubled the worst-case detection delay to ~24h and risked zero GCC live-job coverage for a whole cycle on some runs, to save only ~$3.60/customer/month once the real bulk rate below was known — not a good trade.
- **Real rate:** you checked TheirStack's own pricing page directly and found the 20,000-credits/month tier costs $240/month flat — **$12/1,000 credits ($0.012/credit)**, well below the $32.67/1,000 published self-serve rate this doc originally used. That's the rate applied throughout below. One honest caveat: your actual expected volume at 50–100 clients (≈30,000–60,000 credits/month platform-wide) is past that one confirmed 20k data point — TheirStack's tier pricing may or may not stay linear above it. Treat the numbers below as the best current estimate, not a locked-in figure, until a higher tier is confirmed the same way.

---

Part 1 — Per-account monthly unit economics
--------------------------------------------

| | **Starter** ($79/mo) | **Growth** ($129/mo) | **Team** ($99/mo/seat) |
|---|---|---|---|
| Recurring scan (Haiku 4.5, ~60 calls/mo, web search) | $4.00–4.60 | $7.00–8.50 | $7.00–8.50 |
| Apollo enrichment (contacts + company verification on new signals) | $6.70–10.60 | $18.80–29.70 | $18.80–29.70 |
| Today's Actions + Ask Annie + support chat | $0.30–0.60 | $0.40–0.80 | $0.40–0.80 |
| TheirStack (confirmed live; 20 credits/day ≈ 600/mo, at the $12/1,000 bulk rate) | ≈ $7.20 | ≈ $7.20 | ≈ $7.20 |
| **Variable COGS/account** | **≈ $20.60** | **≈ $40.15** | **≈ $40.15/seat → $120.45 (3 seats)** |
| Revenue | $79.00 | $129.00 | $297.00 |
| **Gross profit** | **$58.40 (74%)** | **$88.85 (69%)** | **$176.55 (59%)** |

Growth/Team cost more per account than Starter because they genuinely do more work, not because anything is priced wrong: `SCAN_TIER_CONFIG` gives Growth/Team 2x the signal target, 3x the chained scan rounds, ~2.6x the token ceiling, and an extra Apollo contact-retry pass Starter never runs. TheirStack's cost is the one line that's flat across all three tiers — the recurring scan calling it isn't tier-gated. Team's percentage margin is the lowest of the three not because it costs more per seat than Growth (it's the same underlying scan cost per seat), but because it's priced at $99/seat against that cost, versus Growth's $129 flat.

*(For reference, if TheirStack were ever switched off: Starter COGS ≈ $13.40 (83% margin), Growth/Team ≈ $32.95/seat (74%/67%). The gap between that and the numbers above is entirely the ~$7.20/account TheirStack line.)*

---

Part 2 — 50 clients (35 Starter / 10 Growth / 5 Team accounts, 15 seats)
--------------------------------------------------------------------------

| | |
|---|---|
| Revenue | **$5,540/mo** |
| Variable COGS (Apollo/Anthropic/TheirStack) | $1,724.75/mo |
| Fixed infra (Supabase Pro + Netlify Pro, estimated at this scale) | ~$100/mo |
| **Total cost** | **$1,824.75/mo** |
| **Profit** | **$3,715.25/mo** |
| **Margin** | **67%** |

Revenue breakdown: 35 × $79 = $2,765 · 10 × $129 = $1,290 · 5 × $297 = $1,485.
COGS breakdown: 35 × $20.60 (Starter) + 10 × $40.15 (Growth) + 15 × $40.15 (Team, per seat) = $721.00 + $401.50 + $602.25.

---

Part 3 — 100 clients (70 Starter / 20 Growth / 10 Team accounts, 30 seats)
------------------------------------------------------------------------------

| | |
|---|---|
| Revenue | **$11,080/mo** |
| Variable COGS | $3,449.50/mo |
| Fixed infra (likely into Supabase/Netlify overage tiers at this volume) | ~$225/mo |
| **Total cost** | **$3,674.50/mo** |
| **Profit** | **$7,405.50/mo** |
| **Margin** | **67%** |

Revenue breakdown: 70 × $79 = $5,530 · 20 × $129 = $2,580 · 10 × $297 = $2,970.
COGS breakdown: 70 × $20.60 + 20 × $40.15 + 30 × $40.15 = $1,442.00 + $803.00 + $1,204.50.

Margin percentage barely moves between 50 and 100 clients (67% → 67%) — expected, since almost all of this cost is variable/per-customer, not fixed. Scale doesn't buy much margin improvement here; it buys the same margin on a bigger number, until a real infra step-change (see below). This 67% supersedes the ~71% figure mentioned in chat earlier the same day — that was a rough verbal estimate before this file was fully reworked tier-by-tier with the confirmed 600-credit/customer figure and $12/1,000 rate applied consistently; this is the carefully worked number.

---

Part 4 — Things that could break this model before you hit 100 clients

1. **Adzuna's free API tier caps out at ~8 active customers** (flagged earlier, still unresolved). At 50–100 clients you're 6–12x past that ceiling. Adzuna's paid tier is contact-sales-only — no published price — so it's not in the numbers above at all. This fails silently today (no error, `job_posting_unclaimed` signals from Adzuna just stop appearing), so nothing will alarm you when it happens; a scheduled weekly check-in is now watching your live customer count against this threshold (and TheirStack's own 5-customer review point) and will flag it directly when either is crossed.
2. **TheirStack's real rate above 20k credits/month is unconfirmed.** At 50 clients you're at ~30,000 credits/month platform-wide; at 100, ~60,000. Both exceed the one tier Michael actually verified. If the next tier up is meaningfully more (or less) than $12/1,000, the TheirStack line above — and therefore the 67% margin figure — moves with it. Worth re-checking TheirStack's pricing page directly once near either volume, the same way the $12/1,000 figure was confirmed.
3. **Fixed infra estimates above are directional, not quoted.** Supabase Pro ($25/mo base) and Netlify Pro (from $20/mo, credit-metered) both have usage-based overage past their included allowances — estimated at $100/mo at 50 clients and $225/mo at 100 based on typical overage at that scan volume, but the real number depends on actual Netlify function compute and Supabase egress, not yet measured. Worth pulling the real last-month bills once near either scale and swapping in the actual figure — this line is small relative to variable COGS either way (2–4% of revenue), so it won't change the conclusion, just the exact dollar amount.

---

Bottom line
-----------

At the current $79/$129/$99-per-seat pricing, with TheirStack confirmed live at its real bulk rate, **Annie clears roughly 67% gross margin at both 50 and 100 clients** — comfortably profitable, and the percentage doesn't erode as you scale from 50 to 100 because the cost is almost entirely variable. The two things that could actually move this number aren't customer count, they're: (1) whether TheirStack's rate holds steady above the 20k-credit tier once you're actually there, and (2) getting a real Adzuna paid-tier quote before customer #8 becomes customer #50 — both are now things the weekly check-in will surface as they approach, rather than things to remember to check manually.

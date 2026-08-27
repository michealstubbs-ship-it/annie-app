# Line-by-line audit — findings (26 Aug 2026)

Full read-through of the rest of the app (netlify/functions, src/lib, src/components — ~16,700 lines), done by 8 parallel reviewers each assigned a subsystem, cross-checking every candidate against callers/schema before reporting. Two items were fixed immediately given real, live risk (see below); everything else is listed for you to prioritize.

## Already fixed this pass

**CRITICAL — RPC permission hole, patched directly in production.** The 2026-08-26 per-customer-credit-caps migration created new versions of `apollo_reserve_credits`/`theirstack_reserve_credits`/`anthropic_reserve_tokens` with no lockdown at all. Postgres grants EXECUTE to everyone by default, so any logged-in customer (or, for TheirStack, even a logged-out visitor) could call these directly and bypass every credit/token cap in the app — pass an arbitrary amount and an arbitrary cap of your own choosing, or target another customer's account by ID. This is the identical bug already fixed once on 2026-08-21 for an older version of one of these functions; the fix just didn't carry over to the new ones. Verified exploitable, then verified fixed, directly against the production database. Migration file delivered for the repo's record; no action needed on your end.

**Recurring bug — env vars set to `0` were silently ignored, across 4 files.** Every numeric env-var override used a pattern that treats `0` as "unset" and falls back to the default — exactly the value you'd reach for as a kill-switch (e.g. `FREE_MONTH_MAX_REDEMPTIONS=0` to shut off the free-trial link right now). Fixed with a shared helper, applied everywhere it appeared. Also closed a related gap in `chat.js`: its config check didn't include the service-role key, so if that key were ever missing, every rate limit and spend cap on the chat endpoint would silently switch off instead of the endpoint returning a clear error.

Both delivered and tested (668/668 tests passing, build clean).

## Not yet fixed — for you to prioritize

### High

1. **Signup has no bot verification at all.** `Turnstile.jsx` and `verify-turnstile.js` both exist and both have comments claiming they're wired into signup — they aren't. `Login.jsx`'s signup form never renders Turnstile, collects no token, and never calls the verify endpoint. This has probably been true since Turnstile was built; nothing broke it, it was just never actually connected.
2. **Team seat limits aren't atomic.** `team-invite.js` reads the current seat count, checks it against the plan's limit, then inserts — two concurrent invite requests can both pass the check and both insert, pushing a 3-seat plan to 4+ members with no error and no trace. No database constraint backs this up either.
3. **A customer with a declined card gets steered into creating a duplicate subscription.** When Stripe marks a subscription `past_due` (card failed, still auto-retrying — not cancelled), Billing.jsx hides the "Manage billing" button and instead shows "Choose a plan to resubscribe." Clicking it starts a brand-new Stripe subscription rather than opening the billing portal (which already works correctly for this exact case and just isn't being shown).
4. **A comment in `stripe-webhook.js` describes a fallback that can't actually run.** The code assumes an update-with-no-matching-row sets an error so it can retry the match a different way; Postgres/PostgREST don't work that way (no error on zero rows updated), so that fallback path is dead code. Mostly cushioned by other logic elsewhere in the same file, but worth knowing it doesn't do what the comment says.

### Medium

5. Failed transactional emails (payment-failed notices, "add a card" reminders) are invisible if Resend ever rejects a send — no log, no alert, nothing. Only one of the four call sites checks the result at all.
6. `.env.example` documents the old (stale) default cap values for Apollo/TheirStack/Anthropic — an operator reading it would underestimate real spend by 2–12x.
7. Settings page: saving your profile or writing-style sample doesn't check for a write error — shows "Saved!" even if the save silently failed.
8. TheirStack usage is billed by credits reserved (a flat 10 per call), not by jobs actually returned, contradicting the file's own comment that TheirStack bills per job. Inflates internal cost tracking and can cap a customer out early.
9. If the internal secret used to chain multi-round scans together ever goes missing or out of sync, Growth/Team scans silently stop after round 1 for every customer — only a console log, no alert, so nothing would point at the actual cause.
10. A scan-status timestamp bug means a scan that dies mid-chain can take longer than intended to be marked "timed out."
11. Pipeline (deals) "Add Deal" form has no validation on the required Company field — leaving it blank surfaces a raw database error instead of a friendly message.
12. Several places optimistically update the UI ("Saved," "Added," "Marked done") without checking whether the underlying write actually succeeded — Intelligence Feed's mark-seen/mark-actioned/add-to-actions, and Today's Actions' mark-done. A failed write is invisible until the item quietly reappears later.
13. Every frontend data-loading function (contacts, companies, candidates, deals, jobs, meetings, tasks, signals, team activity) treats a Supabase error the same as "no rows" — a real outage or permissions issue looks identical to an empty list everywhere in the app.

### Low / worth a look eventually

- `useScanStatusPoll.js`'s header claims it replaced duplicate polling logic in Overview.jsx/Settings.jsx — neither actually uses it; both still hand-roll the same logic.
- A couple of cache-read spots in `scanShared.js` (company contact cache, company enrichment cache, "learned sources") swallow query errors without logging — the exact bug class already fixed elsewhere in the same file, just missed in these two spots.
- AdminOverview's "Revenue by tier" chart doesn't account for annual billing discounts on Starter/Growth (cosmetic only).
- Overview page's "Needs your attention" card doesn't refresh when a poll finds new signals, until a manual reload.
- A couple of very minor items: a dead ternary in IntelligenceFeed.jsx, a hardcoded scan-timeout fallback that duplicates a value instead of referencing it, `jsonExtract.js` mishandling one edge case (AI narration appearing before rather than after the JSON block).
- The Supabase security advisor also flags a handful of `get_admin_*` functions as callable by any signed-in user — these all check for admin internally and RAISE an exception for anyone else (same pattern already reviewed and accepted in the 2026-08-21 lockdown), so likely not a real gap, but worth a quick spot-check given what the reserve-functions bug just turned up.

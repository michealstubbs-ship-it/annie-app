@echo off
cd /d "%~dp0"

echo Cleaning up any leftover lock files...
if exist ".git\index.lock" del /f /q ".git\index.lock"
if exist ".git\HEAD.lock" del /f /q ".git\HEAD.lock"
echo Done.
echo.

echo Staging: GCC company matching, founder/CEO contact search, live-job drop-ordering,
echo fair multi-country Adzuna search, and the per-customer + tier-based credit/token caps...
git add netlify\functions\lib\scanShared.js netlify\functions\lib\scanShared.test.js src\lib\companyMatch.js src\lib\companyMatch.test.js netlify\functions\lib\entitlements.js netlify\functions\lib\entitlements.test.js netlify\functions\lib\aiUsage.js netlify\functions\lib\aiUsage.test.js netlify\functions\chat.js netlify\functions\intelligence-scan.js netlify\functions\scan-now-background.js netlify\functions\apollo-enrich-companies.js netlify\functions\tests\apollo-enrich-companies.test.js supabase-migrations\2026-08-26-per-customer-credit-caps.sql
echo (add - errorlevel %errorlevel%)
echo.

echo Committing the staged changes...
git commit -m "Five real, verified gaps found by re-running the same audit that caught the Strategy keyword bug, all specific to why results were thin: (1) company-name matching (pickBestOrgMatch, used to resolve which Apollo record a signal's company actually is) did plain exact-string comparison with no legal-suffix handling at all -- a genuinely correct match like 'Acme Trading' vs Apollo's own 'Acme Trading FZE' was rejected as two different companies, blocking every downstream contact lookup; companyMatch.js's suffix list now covers FZE/DMCC/PJSC/WLL/Establishment alongside the US/UK ones it already had, and pickBestOrgMatch tries a suffix-normalized exact match (still an exact match, not fuzzy, so it keeps the same protection that fixed the original Stitch/Stitch Fix wrong-company bug). (2) funding/expansion signals only ever searched functional titles (Head of Product, VP Sales, etc) for a contact, never Founder/CEO/Managing Director/Owner -- exactly the titles a small, recently-funded or newly-expanding company's real, only decision-maker is likely to hold; added a leadership bucket searched alongside the existing three, for every tier. (3) the 'drop the generic hiring signal once a live job exists for the same company' rule ran on the AI's raw, unverified live_job label, before the URL is ever checked -- a real, well-sourced hiring_activity signal could get discarded in favour of a live_job entry that turns out not to have a genuine posting URL at all; it now only counts a live_job entry if its source URL actually looks like a real posting. (4) Adzuna discovery only ever queried a customer's first 2 selected countries and capped combined results at 10 first-country-biased with no log -- now queries every mapped country (Adzuna is free, no cost reason to hold back) and interleaves results fairly across markets, logging when the cap actually discards something. (5) the shared, platform-wide Apollo/TheirStack daily credit caps used to fail completely silently when hit -- a customer's scan could come back thin because ANOTHER customer's scan spent the shared budget earlier that day, with zero visible signal anywhere that this, not a lack of real prospects, was why; now alerts to Slack (if SLACK_WEBHOOK_URL is set) the first time each cap is hit each day. Also added targeted logging to verifyContact's previously-silent null-return paths so 'why did this signal never get a contact' is answerable from production logs going forward.

Per-customer + tier-based Apollo/TheirStack/Anthropic caps (the actual point Michael raised: 'each customer gets their own amount of credits, it's not shared across the whole platform where one customer can exhaust it for another'). Apollo/TheirStack/Anthropic daily caps were ALL platform-wide-shared counters with no per-customer scoping -- one customer's scan could exhaust the whole day's budget and starve every other customer's scan/chat that day with zero visible reason why. Every reserve function (apollo_reserve_credits, theirstack_reserve_credits, and the newly-added anthropic_reserve_tokens, replacing the old day+hour-sharded version) now checks a per-customer cap AND a platform-wide backstop atomically in one SQL statement, and the caps differ by tier (Starter/Growth/Team) via the new resolveResourceCaps() in entitlements.js, following the same SCAN_TIER_CONFIG pattern the scan-depth tiering already uses. The reserve RPCs now return 'ok'/'user_cap'/'platform_cap' instead of a bare boolean so a routine per-customer cap hit (expected, affects nobody else) is never confused with a platform-wide cap hit (affects every customer, now Slack-alerted) the way the old boolean couldn't tell apart. Also raised anthropicMaxTokens per tier (Starter 4096->6144, Growth/Team 12000->16000) after finding a real, measured truncation risk: the scan prompt's own JSON schema (14 fields per signal, including a full 3-paragraph outreach letter) averages ~550-700 output tokens per entry against a prompt asking for up to 8 signals, and extractJson requires a fully-closed array to parse at all -- a response that ran out of token budget mid-object didn't lose just the last entry, it silently returned zero signals for that whole call, indistinguishable in the logs from 'genuinely found nothing'. Added looksTruncatedByTokenLimit + production logging so this is now measurable going forward rather than estimated. Also fixed a real pre-existing bug found while making this change: scan-now-background.js's round-2+ chained-scan calls (runAdditionalRound) never passed supabase into the Anthropic token-cap check at all, so every round-2+ call silently skipped the cap check entirely. New migration: supabase-migrations/2026-08-26-per-customer-credit-caps.sql (run this in the Supabase SQL Editor before this deploy goes live, same as previous migration files)."
echo (commit - errorlevel %errorlevel%)
pause

echo.
echo Step 1: Pushing test-payments to GitHub...
git push origin test-payments
echo (push test-payments - errorlevel %errorlevel%)
pause

echo.
echo Step 2: Switching to main and merging...
git checkout main
git merge test-payments --ff-only
echo (merge - errorlevel %errorlevel%)
pause

echo.
echo Step 3: Pushing main to GitHub - this triggers the production deploy...
git push origin main
echo (push main - errorlevel %errorlevel%)
pause

echo.
git checkout test-payments
echo All done. IMPORTANT: before (or right after) this deploy goes live, run
echo supabase-migrations\2026-08-26-per-customer-credit-caps.sql in the Supabase
echo SQL Editor for the production project - the new code calls apollo_reserve_credits/
echo theirstack_reserve_credits/anthropic_reserve_tokens with a new signature that
echo only exists after that migration runs.
pause

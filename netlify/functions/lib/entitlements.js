import { parseIntEnv } from './env.js'

// Soft-gate tier lookup, shared by every Netlify function that needs to
// know "what plan is this caller's team on" (chat.js's message cap,
// onboarding's research depth).
//
// Soft gate, confirmed with Michael (2026-08-24): nobody is ever locked out
// of core product (CRM, Today's Actions, Intelligence Feed) for lacking an
// active subscription. Only tier-specific perks are gated, and an
// unrecognized or missing subscription degrades to Starter-level limits,
// never a hard failure. If you're changing this to a hard gate later, this
// is the one file that decision lives in.
//
// Tier resolves through the caller's TEAM, not the caller's own user_id —
// every account (solo or multi-seat) belongs to exactly one active team
// (see supabase-migrations/2026-08-24-teams-and-shared-crm.sql), and a
// team's subscription is looked up by team_id. This is one code path for
// everyone: a Growth solo user and a Team-tier teammate both resolve their
// tier the same way, through their team's own subscription row.
//
// 2026-08-26 pricing/copy alignment: linkedinReimportOnDemand used to live
// here (false for starter, true for growth/team) but was never actually
// read by any call site — LinkedIn re-import has no tier check anywhere
// (LinkedInImport.jsx, Settings.jsx). Rather than wire up a gate the
// product doesn't actually want (SupportWidget.jsx's own fact base tells
// customers directly it's available "for anyone, regardless of plan," and
// pricing.js no longer sells it as Growth-exclusive — see that file's own
// comment), the flag itself is removed. Keeping an unused gate flag around
// invites exactly the bug this would have been: someone wiring it up later
// on the strength of its name alone, re-introducing a restriction the
// product deliberately doesn't have.
// 2026-09-01, Michael, after measuring the real numbers rather than guessing.
// Starter's Ask Annie allowance was 100/month. Measured against a real desk
// on production: one Ask Annie message costs ~518 input + ~485 output tokens,
// which at Haiku 4.5's $1/M in / $5/M out is about $0.003 — a third of a
// penny. 450 messages a month is roughly $1.30 for short questions on a small
// desk, ~$3.40 for realistic 5-turn conversations, ~$8 for a heavy user with
// a large CRM and long threads. So the 100-message cap was protecting against
// a cost of a few dollars a month on a plan priced two orders of magnitude
// above it.
//
// It was also the binding constraint by roughly 20x, not the spend caps that
// exist for cost: Starter's own anthropicUserDailyTokenCap (80,000/day) minus
// the twice-daily scan leaves room for ~65 chat messages a DAY, while
// 100/month allows five. The cap was set where it constrained the product,
// not where it protected the bill.
//
// 500/month is ~25 per working day — enough that a recruiter genuinely stops
// counting — while staying a real ceiling that a multi-desk power user will
// reach, so the upgrade conversation stays honest rather than artificial.
// Growth and Team stay unlimited (Michael's call: "for Growth there cannot be
// a significant cap"); see CHAT_ABUSE_ALERT_THRESHOLD in chat.js for the
// monitoring-only backstop that replaces a limit there.
// contactCreditsPerMonth, added 2026-09-04 with the single-stream rebuild.
//
// Contacts used to be enriched for every signal at scan time whether the
// customer ever looked at it or not, which is how five test tenants burned
// through a 2,500/month Apollo plan in under two weeks. They are now fetched
// only when the recruiter clicks, and this is the allowance for that.
//
// A credit is consumed ONLY when a real person comes back. Verified against
// the live Apollo API on 2026-09-04: a search costs nothing, and an enrichment
// that matches nobody costs nothing either. So a failed lookup is free to
// Annie and is free to the customer — there is deliberately no state where
// someone spends an allowance and receives nothing.
//
// That also changes what the number means when it is shown to them: 50 is 50
// CONTACTS, not 50 attempts, which is both easier to sell and easier to
// explain at the ceiling. Team's pool is shared across the whole team, which
// is why usage is keyed on team_id rather than user_id.
export const TIER_LIMITS = {
  starter: { chatMessagesPerMonth: 500, deepOnboardingResearch: false, contactCreditsPerMonth: 50 },
  growth: { chatMessagesPerMonth: Infinity, deepOnboardingResearch: true, contactCreditsPerMonth: 150 },
  team: { chatMessagesPerMonth: Infinity, deepOnboardingResearch: true, contactCreditsPerMonth: 400 },
}

// The actual numbers behind deepOnboardingResearch above (2026-08-25,
// confirmed with Michael). Starter gets one solid, honest scan; Growth and
// Team get a materially deeper one — both the chained onboarding/upgrade
// scan AND the ongoing daily cron, permanently, not a one-time signup
// bonus that quietly fades back to parity the next day. Read by
// scan-now-background.js (feedSignalTarget/actionsEligibleTarget/maxRounds/
// maxWallClockMs drive the chained onboarding+upgrade scan) and
// intelligence-scan.js (anthropicMaxTokens/anthropicMaxUses drive the
// daily per-user call — that file never chains, it's one call per user per
// scheduled run by design, so maxRounds/maxWallClockMs don't apply there).
// apolloContactRetry drives verifyContact's extra retry pass in
// scanShared.js — the real lever for Actions-eligibility (see that file),
// not just search budget.
// 2026-08-26, Michael: anthropicMaxTokens raised from the original
// 4096/12000 — this isn't a "more is better" bump, it's a fix to a real,
// measured truncation risk found by walking the actual scan prompt's own
// JSON schema (buildScanPrompt in intelligence-scan.js/scan-now-
// background.js: 14 fields per signal, including a full 3-paragraph
// introMessage letter and a nested candidateProfile object) against a
// real filled-in example of one signal entry: that averages roughly
// 550-700 output tokens per entry once JSON punctuation/keys are counted,
// against a prompt that asks for "up to 8 signals" per call. At the OLD
// Starter ceiling (4096, with ~200-400 of that already spent on the
// web_search tool-use blocks themselves before any JSON text is even
// generated), a call that genuinely finds 6+ good signals runs out of
// budget mid-object — and extractJson (src/lib/jsonExtract.js) requires a
// BALANCED, closed array to parse at all, so a truncated response doesn't
// lose just the last entry, it silently returns [] and the entire call's
// signals are discarded, indistinguishable in the logs from "genuinely
// found nothing". 6144 gives ~40% headroom over the ~5700-token safe
// minimum for 8 full entries, closing that failure mode for Starter.
// Growth/Team's old 12000 already had ~2x the safe minimum (effectively no
// truncation risk there today) — the 16000 here is deliberately modest
// extra headroom for their richer candidateProfile output (more search
// budget → more named competitor companies per entry), not a fix for a
// measured problem the way Starter's bump is. Reported to Michael
// alongside this change: raising Growth/Team's ceiling further would NOT
// meaningfully improve their data completeness — they're not currently
// truncation-bottlenecked, more chained rounds (maxRounds) is what's
// actually buying them more signals, and that's unchanged here.
//
// apolloUserDailyCap/theirStackUserDailyCap/anthropicUserDailyTokenCap
// (all new, 2026-08-26): the per-customer half of the shared-resource fix
// — see supabase-migrations/2026-08-26-per-customer-credit-caps.sql and
// resolveResourceCaps below. Sized off each tier's own actual usage
// pattern (feedSignalTarget/maxRounds/apolloContactRetry above), not a
// guess: Growth/Team run up to 3x the sector-group+broaden-pass rounds of
// Starter during a chained onboarding scan, plus the extra
// EXTENDED_FUNCTION_TITLE_BUCKETS retry pass Starter never runs, so their
// per-customer ceiling is set well above a flat multiple of Starter's
// rather than a simple x2. These are starting points reasoned from the
// product's own call patterns, not measured against your actual Apollo/
// TheirStack contracted plan limits — sanity-check them against your real
// plan quotas before trusting them at scale, and tune via the env vars
// resolveResourceCaps reads (documented there).
export const SCAN_TIER_CONFIG = {
  starter: {
    feedSignalTarget: 10,
    actionsEligibleTarget: 1,
    maxRounds: 2,
    maxWallClockMs: 10 * 60 * 1000,
    anthropicMaxTokens: 6144,
    anthropicMaxUses: 8,
    anthropicBroadenMaxUses: 10,
    apolloContactRetry: false,
    apolloUserDailyCap: 120,
    // 2026-08-31: raised 40 -> 60 (Michael's call, cheap headroom on top of
    // the scan-now over-spend fix shipped the same day). The routine daily
    // cron alone already costs 20/day (confirmed in Annie-Cost-Analysis-
    // 50-100-Clients.md) — after fixing manual "Scan now" to cost the same
    // 10 credits as a routine scan instead of up to 40, a customer who
    // scans once automatically and clicks "Scan now" a couple more times
    // the same day could still reach 40 within a few days. 60 gives real
    // room above that pattern (cron 20 + up to 4 manual scans at 10 each)
    // without raising the platform-wide backstop — extra cost is small:
    // TheirStack's real bulk rate is $0.012/credit, so 20 more credits/day
    // ceiling is at most ~$7.20/customer/month if fully used, well under
    // what a once-daily-cadence cut would have cost in detection delay.
    theirStackUserDailyCap: 60,
    anthropicUserDailyTokenCap: 80_000,
  },
  growth: {
    feedSignalTarget: 20,
    actionsEligibleTarget: 3,
    maxRounds: 6,
    maxWallClockMs: 20 * 60 * 1000,
    anthropicMaxTokens: 16000,
    anthropicMaxUses: 12,
    anthropicBroadenMaxUses: 15,
    apolloContactRetry: true,
    apolloUserDailyCap: 280,
    theirStackUserDailyCap: 90,
    anthropicUserDailyTokenCap: 500_000,
  },
  team: {
    feedSignalTarget: 20,
    actionsEligibleTarget: 3,
    maxRounds: 6,
    maxWallClockMs: 20 * 60 * 1000,
    anthropicMaxTokens: 16000,
    anthropicMaxUses: 12,
    anthropicBroadenMaxUses: 15,
    apolloContactRetry: true,
    // Same scan behaviour as Growth (Team is a seat-count/collaboration
    // upgrade, not a deeper-scan tier), but a small headroom bump over
    // Growth's own numbers — a multi-seat team is more likely to have more
    // than one person triggering manual "Scan now" runs the same day.
    apolloUserDailyCap: 320,
    theirStackUserDailyCap: 100,
    anthropicUserDailyTokenCap: 600_000,
  },
}

const DEFAULT_TIER = 'starter'

// Platform-wide backstop defaults — see the SQL migration's own header for
// why this stays as a secondary ceiling under the per-customer caps above,
// not the primary protection any more. Raised from the old flat values
// (Apollo 500, TheirStack 40→150, Anthropic 2,000,000) because those were
// sized for a single shared pool serving every customer combined — once
// each customer has their own real budget via the caps above, several
// customers legitimately using their own full allowance the same day adds
// up past the old totals fast (e.g. two Growth customers each running a
// same-day onboarding scan can alone approach 1M Anthropic tokens). These
// are still just starting points — the one number in this whole change
// Michael should sanity-check directly against his real Apollo/TheirStack/
// Anthropic plan quotas and billing tolerance before trusting at scale,
// since that's account-specific information this code has no way to see.
// All three stay overridable via the existing env vars with no code
// change needed: APOLLO_DAILY_CREDIT_CAP, THEIRSTACK_DAILY_CREDIT_CAP,
// ANTHROPIC_DAILY_TOKEN_CAP.
// 5th-pass audit fix (2026-08-26): theirStack raised again — see
// DEFAULT_THEIRSTACK_DAILY_CAP's own comment in scanShared.js for the full
// reasoning (must stay in sync with that constant). Annie-Cost-Analysis-
// 50-100-Clients.md confirmed a flat, unconditional 20 credits/customer/day
// on every tier; 500 was already short of the target scale (exceeded past
// ~25 customers), not just an eventual concern. apollo/anthropicTokens are
// untouched here — Apollo's real per-account credit rate (as opposed to its
// dollar cost, which the same doc does confirm) isn't something this code
// has visibility into, so raising that number needs the same real-usage
// check against Michael's own Apollo billing before trusting it at scale,
// per the comment above.
const DEFAULT_PLATFORM_CAPS = {
  apollo: 1200,
  theirStack: 3000,
  anthropicTokens: 4_000_000,
}

// Single place that turns "this tier" into the actual {userDailyCap,
// platformDailyCap} pair every reserve*Credits/reserveAnthropicTokens call
// needs — callers resolve this once per request (from getEntitlements)
// and thread the result down, rather than every low-level Apollo/
// TheirStack/Anthropic call site needing to know about tiers itself.
export function resolveResourceCaps(tier) {
  const t = SCAN_TIER_CONFIG[tier] || SCAN_TIER_CONFIG[DEFAULT_TIER]
  return {
    apollo: {
      userDailyCap: t.apolloUserDailyCap,
      platformDailyCap: parseIntEnv(process.env.APOLLO_DAILY_CREDIT_CAP, DEFAULT_PLATFORM_CAPS.apollo),
    },
    theirStack: {
      userDailyCap: t.theirStackUserDailyCap,
      platformDailyCap: parseIntEnv(process.env.THEIRSTACK_DAILY_CREDIT_CAP, DEFAULT_PLATFORM_CAPS.theirStack),
    },
    anthropicTokens: {
      userDailyCap: t.anthropicUserDailyTokenCap,
      platformDailyCap: parseIntEnv(process.env.ANTHROPIC_DAILY_TOKEN_CAP, DEFAULT_PLATFORM_CAPS.anthropicTokens),
    },
  }
}

// { tier, status, teamId, limits }. `tier` is always one of the real keys
// above (never null) — a user with no team yet (shouldn't happen post
// handle_new_user, but defensive) or no subscription row at all is treated
// as Starter-level, not denied.
export async function getEntitlements(supabase, userId) {
  const { data: membership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (!membership) {
    return { tier: DEFAULT_TIER, status: null, teamId: null, limits: TIER_LIMITS[DEFAULT_TIER] }
  }

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('tier, status')
    .eq('team_id', membership.team_id)
    .maybeSingle()

  // Admin accounts keep their subscription row's configured tier even when
  // its Stripe status isn't active/trialing — added 2026-09-02 after
  // Michael's own account (tier: growth, status: canceled from a real,
  // deliberately-cancelled Stripe subscription — stripe-webhook.js is "the
  // only writer" of this table, so that status is genuine, not a sync bug)
  // silently fell back to Starter-tier scan config with no way to tell.
  // Michael didn't want to either hand-edit the subscriptions row (would
  // desync from Stripe's real state and could get silently overwritten the
  // next time stripe-webhook.js writes this table) or run a real Stripe
  // checkout just to unblock his own testing. is_admin already gates the
  // separate admin-dashboard views (see profiles table / Sidebar.jsx) —
  // reusing that same flag here means any future internal/test account gets
  // the same treatment without another one-off carve-out, and it's scoped
  // to bypassing the *status* check only: an admin account still needs a
  // real subscriptions row with a real tier on it, and the returned
  // `status` still reports the true Stripe status (so billing UI doesn't
  // lie about it) — only which tier's scan config gets used changes.
  // Only queried when actually needed (sub exists but isn't active/
  // trialing) so the common case — a real paying customer — costs no extra
  // query.
  let isAdminOverride = false
  if (sub && !['active', 'trialing'].includes(sub.status)) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', userId)
      .maybeSingle()
    isAdminOverride = !!profile?.is_admin
  }

  const isEntitled = sub && (['active', 'trialing'].includes(sub.status) || isAdminOverride) && TIER_LIMITS[sub.tier]
  const tier = isEntitled ? sub.tier : DEFAULT_TIER

  return { tier, status: sub?.status || null, teamId: membership.team_id, limits: TIER_LIMITS[tier] }
}

// Reads this team's contact-credit usage for the current calendar month.
// Never throws: a meter that cannot be read must not stop a customer finding a
// contact, so a failure here degrades to "no meter shown" rather than an error.
export async function getContactCredits(supabase, teamId, tier) {
  const limit = TIER_LIMITS[tier]?.contactCreditsPerMonth ?? TIER_LIMITS[DEFAULT_TIER].contactCreditsPerMonth
  if (!supabase || !teamId) return { used: 0, limit, remaining: limit }
  try {
    const { data, error } = await supabase.rpc('contact_credits_used', { p_team_id: teamId })
    if (error) {
      console.error('[entitlements] contact_credits_used RPC failed:', error.message)
      return { used: 0, limit, remaining: limit }
    }
    const used = Number(data) || 0
    return { used, limit, remaining: Math.max(0, limit - used) }
  } catch (err) {
    console.error('[entitlements] contact_credits_used threw:', err.message)
    return { used: 0, limit, remaining: limit }
  }
}

// Consumes one credit. Called ONLY after Apollo has actually returned a
// person — see the note on contactCreditsPerMonth above.
export async function consumeContactCredit(supabase, teamId) {
  if (!supabase || !teamId) return null
  try {
    const { data, error } = await supabase.rpc('contact_credits_consume', { p_team_id: teamId, p_credits: 1 })
    if (error) {
      console.error('[entitlements] contact_credits_consume RPC failed:', error.message)
      return null
    }
    return Number(data) || 0
  } catch (err) {
    console.error('[entitlements] contact_credits_consume threw:', err.message)
    return null
  }
}

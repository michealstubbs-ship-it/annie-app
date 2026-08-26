import { parseIntEnv } from './env.js'

// Soft-gate tier lookup, shared by every Netlify function that needs to
// know "what plan is this caller's team on" (chat.js's message cap today;
// onboarding's research depth and LinkedIn re-import-on-demand are the
// next call sites, flagged in this build's summary rather than wired up
// yet — see PRICING_AND_TEAMS.md).
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
export const TIER_LIMITS = {
  starter: { chatMessagesPerMonth: 100, deepOnboardingResearch: false, linkedinReimportOnDemand: false },
  growth: { chatMessagesPerMonth: Infinity, deepOnboardingResearch: true, linkedinReimportOnDemand: true },
  team: { chatMessagesPerMonth: Infinity, deepOnboardingResearch: true, linkedinReimportOnDemand: true },
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
    theirStackUserDailyCap: 40,
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
const DEFAULT_PLATFORM_CAPS = {
  apollo: 1200,
  theirStack: 500,
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

  const isEntitled = sub && ['active', 'trialing'].includes(sub.status) && TIER_LIMITS[sub.tier]
  const tier = isEntitled ? sub.tier : DEFAULT_TIER

  return { tier, status: sub?.status || null, teamId: membership.team_id, limits: TIER_LIMITS[tier] }
}

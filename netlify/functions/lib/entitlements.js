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

const DEFAULT_TIER = 'starter'

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

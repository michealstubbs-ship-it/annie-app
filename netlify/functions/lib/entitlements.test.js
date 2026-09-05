import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getEntitlements, TIER_LIMITS, SCAN_TIER_CONFIG, resolveResourceCaps } from './entitlements.js'

function makeSupabase({ membership = null, subscription = null, isAdmin = false } = {}) {
  return {
    from(table) {
      if (table === 'team_members') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: membership, error: null }) }) }) }) }
      }
      if (table === 'subscriptions') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: subscription, error: null }) }) }) }
      }
      if (table === 'profiles') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { is_admin: isAdmin }, error: null }) }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

describe('getEntitlements', () => {
  it('defaults to Solo-level limits when the user has no active team membership at all', async () => {
    const result = await getEntitlements(makeSupabase({ membership: null }), 'u1')
    expect(result.tier).toBe('solo')
    expect(result.teamId).toBeNull()
    expect(result.limits).toEqual(TIER_LIMITS.solo)
  })

  it('defaults to Solo-level limits when the team has no subscription row (a real, unpaid team-of-one)', async () => {
    const result = await getEntitlements(makeSupabase({ membership: { team_id: 't1' }, subscription: null }), 'u1')
    expect(result.tier).toBe('solo')
    expect(result.teamId).toBe('t1')
  })

  it('defaults to Solo-level limits when the subscription exists but is not active/trialing', async () => {
    const result = await getEntitlements(makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'solo', status: 'canceled' } }), 'u1')
    expect(result.tier).toBe('solo')
  })

  // 2026-09-02: is_admin override — see getEntitlements's own header comment.
  // Michael's own account had a real, genuinely-cancelled Stripe
  // subscription (tier: solo) blocking his own testing; rather than
  // hand-edit the subscriptions row (would desync from Stripe and could be
  // silently overwritten by the next stripe-webhook.js write) or run a real
  // checkout, an admin account keeps its subscription's configured tier
  // regardless of status.
  it('an admin account keeps its configured tier even when the subscription is canceled', async () => {
    const result = await getEntitlements(
      makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'solo', status: 'canceled' }, isAdmin: true }),
      'u1',
    )
    expect(result.tier).toBe('solo')
    expect(result.limits).toEqual(TIER_LIMITS.solo)
  })

  it('an admin account still reports the true underlying status — the override changes tier, not the billing truth', async () => {
    const result = await getEntitlements(
      makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'solo', status: 'canceled' }, isAdmin: true }),
      'u1',
    )
    expect(result.status).toBe('canceled')
  })

  it('a non-admin account with the exact same canceled subscription still falls back to Solo — the override is scoped to is_admin, not universal', async () => {
    const result = await getEntitlements(
      makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'solo', status: 'canceled' }, isAdmin: false }),
      'u1',
    )
    expect(result.tier).toBe('solo')
  })

  it('an admin account with no subscription row at all still falls back to Solo — the override bypasses the status check only, not the missing-row case', async () => {
    const result = await getEntitlements(
      makeSupabase({ membership: { team_id: 't1' }, subscription: null, isAdmin: true }),
      'u1',
    )
    expect(result.tier).toBe('solo')
  })

  it('an admin account with an already-active subscription never even queries profiles (no extra cost on the common path)', async () => {
    let profilesQueried = false
    const supabase = makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'solo', status: 'active' } })
    const originalFrom = supabase.from.bind(supabase)
    supabase.from = (table) => {
      if (table === 'profiles') profilesQueried = true
      return originalFrom(table)
    }
    const result = await getEntitlements(supabase, 'u1')
    expect(result.tier).toBe('solo')
    expect(profilesQueried).toBe(false)
  })

  it('resolves the real tier for an active subscription', async () => {
    const result = await getEntitlements(makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'solo', status: 'active' } }), 'u1')
    expect(result.tier).toBe('solo')
    expect(result.limits).toEqual(TIER_LIMITS.solo)
  })

  it('treats a trialing subscription the same as active — soft gate never punishes a customer mid-trial', async () => {
    const result = await getEntitlements(makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'team', status: 'trialing' } }), 'u1')
    expect(result.tier).toBe('team')
  })

  it('two different members of the same team resolve the same tier — the whole point of team-scoped billing', async () => {
    const supabase = makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'team', status: 'active' } })
    const ownerResult = await getEntitlements(supabase, 'owner_1')
    const memberResult = await getEntitlements(supabase, 'member_2')
    expect(ownerResult.tier).toBe(memberResult.tier)
    expect(ownerResult.tier).toBe('team')
  })

  // Starter's 500/month cap went with Starter, and both remaining tiers were
  // briefly Infinity — which quietly disabled the server-side ceiling on every
  // live plan. These numbers are a runaway backstop, not a product limit: no
  // real user reaches 150 messages a working day, a stuck loop reaches it in an
  // hour. If either ever goes back to Infinity, chat.js's refusal path becomes
  // unreachable again.
  it('keeps a real, unreachable ceiling on both tiers rather than Infinity', () => {
    expect(TIER_LIMITS.solo.chatMessagesPerMonth).toBe(3000)
    expect(TIER_LIMITS.team.chatMessagesPerMonth).toBe(5000)
    for (const tier of ['solo', 'team']) {
      expect(Number.isFinite(TIER_LIMITS[tier].chatMessagesPerMonth)).toBe(true)
      // Comfortably above the measured heavy user (~25/working day).
      expect(TIER_LIMITS[tier].chatMessagesPerMonth).toBeGreaterThan(1000)
    }
  })
})

describe('resolveResourceCaps (per-customer + platform-wide caps, 2026-08-26)', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    delete process.env.APOLLO_DAILY_CREDIT_CAP
    delete process.env.THEIRSTACK_DAILY_CREDIT_CAP
    delete process.env.ANTHROPIC_DAILY_TOKEN_CAP
  })
  afterEach(() => { process.env = { ...originalEnv } })

  it('resolves a real, distinct per-customer cap for every tier, for all three resources', () => {
    for (const tier of ['solo', 'team']) {
      const caps = resolveResourceCaps(tier)
      expect(caps.apollo.userDailyCap).toBe(SCAN_TIER_CONFIG[tier].apolloUserDailyCap)
      expect(caps.theirStack.userDailyCap).toBe(SCAN_TIER_CONFIG[tier].theirStackUserDailyCap)
      expect(caps.anthropicTokens.userDailyCap).toBe(SCAN_TIER_CONFIG[tier].anthropicUserDailyTokenCap)
    }
  })

  // Was "Growth and Team beat Starter on every resource". With Starter gone
  // there is no lower tier to beat, so what is worth pinning now is that Team
  // is never WORSE than Solo — the two share scan behaviour deliberately (Team
  // is a seat-count and collaboration difference, not a bigger scan), so equal
  // is correct and lower would be a bug.
  it('never gives Team a smaller per-customer cap than Solo', () => {
    const solo = resolveResourceCaps('solo')
    const team = resolveResourceCaps('team')
    for (const resource of ['apollo', 'theirStack', 'anthropicTokens']) {
      expect(team[resource].userDailyCap).toBeGreaterThanOrEqual(solo[resource].userDailyCap)
    }
  })

  it('falls back to Solo caps for an unrecognized tier, same soft-gate philosophy as getEntitlements', () => {
    expect(resolveResourceCaps('bogus-tier').apollo.userDailyCap).toBe(SCAN_TIER_CONFIG.solo.apolloUserDailyCap)
  })

  it('every platform-wide cap is shared across tiers — it is one real backstop, not a per-tier number', () => {
    const solo = resolveResourceCaps('solo')
    const team = resolveResourceCaps('team')
    expect(team.apollo.platformDailyCap).toBe(solo.apollo.platformDailyCap)
    expect(team.theirStack.platformDailyCap).toBe(solo.theirStack.platformDailyCap)
    expect(team.anthropicTokens.platformDailyCap).toBe(solo.anthropicTokens.platformDailyCap)
  })

  // The retired keys must resolve, not fall through to the default by accident
  // — a customer whose subscription row still says 'growth' should get Solo's
  // real caps because that is their plan, not because the lookup missed.
  it('resolves a retired tier key to the tier that replaced it', () => {
    expect(resolveResourceCaps('growth').apollo.userDailyCap).toBe(SCAN_TIER_CONFIG.solo.apolloUserDailyCap)
    expect(resolveResourceCaps('starter').apollo.userDailyCap).toBe(SCAN_TIER_CONFIG.solo.apolloUserDailyCap)
  })

  it('platform-wide caps are overridable via env var without any code change', () => {
    process.env.APOLLO_DAILY_CREDIT_CAP = '9999'
    process.env.THEIRSTACK_DAILY_CREDIT_CAP = '8888'
    process.env.ANTHROPIC_DAILY_TOKEN_CAP = '7777777'
    const caps = resolveResourceCaps('solo')
    expect(caps.apollo.platformDailyCap).toBe(9999)
    expect(caps.theirStack.platformDailyCap).toBe(8888)
    expect(caps.anthropicTokens.platformDailyCap).toBe(7777777)
  })
})

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
  it('defaults to Starter-level limits when the user has no active team membership at all', async () => {
    const result = await getEntitlements(makeSupabase({ membership: null }), 'u1')
    expect(result.tier).toBe('starter')
    expect(result.teamId).toBeNull()
    expect(result.limits).toEqual(TIER_LIMITS.starter)
  })

  it('defaults to Starter-level limits when the team has no subscription row (a real, unpaid team-of-one)', async () => {
    const result = await getEntitlements(makeSupabase({ membership: { team_id: 't1' }, subscription: null }), 'u1')
    expect(result.tier).toBe('starter')
    expect(result.teamId).toBe('t1')
  })

  it('defaults to Starter-level limits when the subscription exists but is not active/trialing', async () => {
    const result = await getEntitlements(makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'growth', status: 'canceled' } }), 'u1')
    expect(result.tier).toBe('starter')
  })

  // 2026-09-02: is_admin override — see getEntitlements's own header comment.
  // Michael's own account had a real, genuinely-cancelled Stripe
  // subscription (tier: growth) blocking his own testing; rather than
  // hand-edit the subscriptions row (would desync from Stripe and could be
  // silently overwritten by the next stripe-webhook.js write) or run a real
  // checkout, an admin account keeps its subscription's configured tier
  // regardless of status.
  it('an admin account keeps its configured tier even when the subscription is canceled', async () => {
    const result = await getEntitlements(
      makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'growth', status: 'canceled' }, isAdmin: true }),
      'u1',
    )
    expect(result.tier).toBe('growth')
    expect(result.limits).toEqual(TIER_LIMITS.growth)
  })

  it('an admin account still reports the true underlying status — the override changes tier, not the billing truth', async () => {
    const result = await getEntitlements(
      makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'growth', status: 'canceled' }, isAdmin: true }),
      'u1',
    )
    expect(result.status).toBe('canceled')
  })

  it('a non-admin account with the exact same canceled subscription still falls back to Starter — the override is scoped to is_admin, not universal', async () => {
    const result = await getEntitlements(
      makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'growth', status: 'canceled' }, isAdmin: false }),
      'u1',
    )
    expect(result.tier).toBe('starter')
  })

  it('an admin account with no subscription row at all still falls back to Starter — the override bypasses the status check only, not the missing-row case', async () => {
    const result = await getEntitlements(
      makeSupabase({ membership: { team_id: 't1' }, subscription: null, isAdmin: true }),
      'u1',
    )
    expect(result.tier).toBe('starter')
  })

  it('an admin account with an already-active subscription never even queries profiles (no extra cost on the common path)', async () => {
    let profilesQueried = false
    const supabase = makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'growth', status: 'active' } })
    const originalFrom = supabase.from.bind(supabase)
    supabase.from = (table) => {
      if (table === 'profiles') profilesQueried = true
      return originalFrom(table)
    }
    const result = await getEntitlements(supabase, 'u1')
    expect(result.tier).toBe('growth')
    expect(profilesQueried).toBe(false)
  })

  it('resolves the real tier for an active subscription', async () => {
    const result = await getEntitlements(makeSupabase({ membership: { team_id: 't1' }, subscription: { tier: 'growth', status: 'active' } }), 'u1')
    expect(result.tier).toBe('growth')
    expect(result.limits).toEqual(TIER_LIMITS.growth)
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

  it('growth and team are both unlimited on chat messages', () => {
    expect(TIER_LIMITS.growth.chatMessagesPerMonth).toBe(Infinity)
    expect(TIER_LIMITS.team.chatMessagesPerMonth).toBe(Infinity)
    expect(TIER_LIMITS.starter.chatMessagesPerMonth).toBe(500)
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
    for (const tier of ['starter', 'growth', 'team']) {
      const caps = resolveResourceCaps(tier)
      expect(caps.apollo.userDailyCap).toBe(SCAN_TIER_CONFIG[tier].apolloUserDailyCap)
      expect(caps.theirStack.userDailyCap).toBe(SCAN_TIER_CONFIG[tier].theirStackUserDailyCap)
      expect(caps.anthropicTokens.userDailyCap).toBe(SCAN_TIER_CONFIG[tier].anthropicUserDailyTokenCap)
    }
  })

  it('growth and team get a strictly higher per-customer cap than starter on every resource — the whole point of tiering', () => {
    const starter = resolveResourceCaps('starter')
    const growth = resolveResourceCaps('growth')
    const team = resolveResourceCaps('team')
    for (const resource of ['apollo', 'theirStack', 'anthropicTokens']) {
      expect(growth[resource].userDailyCap).toBeGreaterThan(starter[resource].userDailyCap)
      expect(team[resource].userDailyCap).toBeGreaterThan(starter[resource].userDailyCap)
    }
  })

  it('falls back to Starter caps for an unrecognized tier, same soft-gate philosophy as getEntitlements', () => {
    expect(resolveResourceCaps('bogus-tier').apollo.userDailyCap).toBe(SCAN_TIER_CONFIG.starter.apolloUserDailyCap)
  })

  it('every platform-wide cap is shared across tiers — it is one real backstop, not a per-tier number', () => {
    const starter = resolveResourceCaps('starter')
    const growth = resolveResourceCaps('growth')
    expect(starter.apollo.platformDailyCap).toBe(growth.apollo.platformDailyCap)
    expect(starter.theirStack.platformDailyCap).toBe(growth.theirStack.platformDailyCap)
    expect(starter.anthropicTokens.platformDailyCap).toBe(growth.anthropicTokens.platformDailyCap)
  })

  it('platform-wide caps are overridable via env var without any code change', () => {
    process.env.APOLLO_DAILY_CREDIT_CAP = '9999'
    process.env.THEIRSTACK_DAILY_CREDIT_CAP = '8888'
    process.env.ANTHROPIC_DAILY_TOKEN_CAP = '7777777'
    const caps = resolveResourceCaps('growth')
    expect(caps.apollo.platformDailyCap).toBe(9999)
    expect(caps.theirStack.platformDailyCap).toBe(8888)
    expect(caps.anthropicTokens.platformDailyCap).toBe(7777777)
  })
})

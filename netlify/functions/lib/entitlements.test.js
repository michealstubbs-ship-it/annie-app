import { describe, it, expect, vi } from 'vitest'
import { getEntitlements, TIER_LIMITS } from './entitlements.js'

function makeSupabase({ membership = null, subscription = null } = {}) {
  return {
    from(table) {
      if (table === 'team_members') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: membership, error: null }) }) }) }) }
      }
      if (table === 'subscriptions') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: subscription, error: null }) }) }) }
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
    expect(TIER_LIMITS.starter.chatMessagesPerMonth).toBe(100)
  })
})

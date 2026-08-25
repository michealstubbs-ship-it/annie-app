import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reserveAnthropicTokens, reserveChatCall } from './aiUsage.js'

describe('reserveAnthropicTokens (daily token-cost cap)', () => {
  let errSpy
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { errSpy.mockRestore() })

  it('fails open (allows the call) when no supabase client is passed — e.g. a unit test context', async () => {
    expect(await reserveAnthropicTokens(undefined, 1000, 100000)).toBe(true)
    expect(await reserveAnthropicTokens(null, 1000, 100000)).toBe(true)
  })

  it('allows the call through and passes tokens/dailyCap to the RPC when under cap', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
    const supabase = { rpc }
    expect(await reserveAnthropicTokens(supabase, 1500, 100000)).toBe(true)
    expect(rpc).toHaveBeenCalledWith('anthropic_reserve_tokens', { p_tokens: 1500, p_daily_cap: 100000 })
  })

  it('blocks the call when the RPC reports the daily cap is reached', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) }
    expect(await reserveAnthropicTokens(supabase, 1500, 100000)).toBe(false)
  })

  it('fails open when the RPC itself errors', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } }) }
    expect(await reserveAnthropicTokens(supabase, 1500, 100000)).toBe(true)
  })

  it('fails open when calling the RPC throws', async () => {
    const supabase = { rpc: vi.fn().mockRejectedValue(new Error('network down')) }
    expect(await reserveAnthropicTokens(supabase, 1500, 100000)).toBe(true)
  })
})

describe('reserveChatCall (per-user, per-minute rate limit)', () => {
  let errSpy
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { errSpy.mockRestore() })

  it('fails open when supabase or userId is missing', async () => {
    expect(await reserveChatCall(undefined, 'u1', 10)).toBe(true)
    expect(await reserveChatCall({ rpc: vi.fn() }, null, 10)).toBe(true)
    expect(await reserveChatCall({ rpc: vi.fn() }, undefined, 10)).toBe(true)
  })

  it('allows the call through and passes userId/perMinuteCap to the RPC when under cap', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
    const supabase = { rpc }
    expect(await reserveChatCall(supabase, 'u1', 20)).toBe(true)
    expect(rpc).toHaveBeenCalledWith('chat_reserve_call', { p_user_id: 'u1', p_per_minute_cap: 20 })
  })

  it('blocks the call when the RPC reports the per-minute cap is reached', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) }
    expect(await reserveChatCall(supabase, 'u1', 20)).toBe(false)
  })

  it('fails open when the RPC itself errors', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } }) }
    expect(await reserveChatCall(supabase, 'u1', 20)).toBe(true)
  })

  it('fails open when calling the RPC throws', async () => {
    const supabase = { rpc: vi.fn().mockRejectedValue(new Error('network down')) }
    expect(await reserveChatCall(supabase, 'u1', 20)).toBe(true)
  })

  it('is independent per user (does not share state between two different userIds within the RPC call itself)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
    const supabase = { rpc }
    await reserveChatCall(supabase, 'user_a', 5)
    await reserveChatCall(supabase, 'user_b', 5)
    expect(rpc).toHaveBeenNthCalledWith(1, 'chat_reserve_call', { p_user_id: 'user_a', p_per_minute_cap: 5 })
    expect(rpc).toHaveBeenNthCalledWith(2, 'chat_reserve_call', { p_user_id: 'user_b', p_per_minute_cap: 5 })
  })
})

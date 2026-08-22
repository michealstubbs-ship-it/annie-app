// Anthropic spend had no cap anywhere in this codebase — Apollo has a real,
// atomic, daily-capped reservation system (reserveApolloCredits in
// scanShared.js), but chat.js and both scan functions could run up
// unbounded Anthropic cost with nothing to stop a bug, a scripted abuse
// case, or a retry loop. This mirrors that exact pattern (day+hour sharded
// from the start, learning from apollo_usage's own single-row-per-day
// bottleneck found in the same audit) rather than being new design.
//
// Reserves against a token-count proxy (maxTokens, known before the call
// fires) rather than actual usage (only known after) — same tradeoff
// Apollo's credit reservation makes: reserve first, refund isn't needed on
// success since the reservation already reflects the worst case for that
// call.
export async function reserveAnthropicTokens(supabase, tokens, dailyCap) {
  if (!supabase) return true // no DB context (e.g. a unit test) — fail open, same as reserveApolloCredits
  try {
    const { data, error } = await supabase.rpc('anthropic_reserve_tokens', { p_tokens: tokens, p_daily_cap: dailyCap })
    if (error) {
      console.error('[aiUsage] anthropic_reserve_tokens RPC failed, allowing the call through:', error.message)
      return true
    }
    if (!data) console.error(`[aiUsage] Anthropic daily token cap (${dailyCap}) reached for today, skipping call`)
    return data
  } catch (err) {
    console.error('[aiUsage] anthropic_reserve_tokens threw, allowing the call through:', err.message)
    return true
  }
}

// Per-user, per-minute call-frequency cap — a separate concern from the
// cost cap above: even within the per-call token ceiling, a valid session
// could otherwise call chat.js in a tight loop indefinitely. Independent of
// which user is calling, the global token cap above still bounds aggregate
// platform-wide cost either way.
export async function reserveChatCall(supabase, userId, perMinuteCap) {
  if (!supabase || !userId) return true
  try {
    const { data, error } = await supabase.rpc('chat_reserve_call', { p_user_id: userId, p_per_minute_cap: perMinuteCap })
    if (error) {
      console.error('[aiUsage] chat_reserve_call RPC failed, allowing the call through:', error.message)
      return true
    }
    if (!data) console.error(`[aiUsage] per-minute chat rate limit (${perMinuteCap}) reached for user`, userId)
    return data
  } catch (err) {
    console.error('[aiUsage] chat_reserve_call threw, allowing the call through:', err.message)
    return true
  }
}

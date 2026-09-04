import { alertIfConfigured } from './scanShared.js'

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
//
// 2026-08-26, Michael: this used to reserve against ONE platform-wide daily
// total (summed across every customer's calls combined) — the second real
// instance, alongside Apollo/TheirStack, of "one customer's usage can
// exhaust the whole day's shared budget and starve everyone else with no
// visible reason why". Now takes userId plus a resolved {userDailyCap,
// platformDailyCap} pair (see resolveResourceCaps in entitlements.js) and
// checks both atomically in the SQL function, same pattern as
// reserveApolloCredits/reserveTheirStackCredits in scanShared.js. Returns
// a boolean still (true = reserved), same contract as before — the
// underlying RPC now returns 'ok'/'user_cap'/'platform_cap' instead of a
// bare boolean so the two failure reasons can be logged/alerted
// differently (a per-customer cap hit is normal and affects nobody else;
// a platform-wide cap hit affects every customer that day and is worth a
// Slack alert), but callers of this function only need the simple
// reserved/not-reserved answer.
export async function reserveAnthropicTokens(supabase, userId, tokens, caps) {
  if (!supabase) return true // no DB context (e.g. a unit test) — fail open, same as reserveApolloCredits
  const userDailyCap = caps?.userDailyCap
  const platformDailyCap = caps?.platformDailyCap
  try {
    const { data, error } = await supabase.rpc('anthropic_reserve_tokens', {
      p_tokens: tokens, p_user_id: userId || null, p_user_daily_cap: userDailyCap, p_platform_daily_cap: platformDailyCap,
    })
    if (error) {
      console.error('[aiUsage] anthropic_reserve_tokens RPC failed, allowing the call through:', error.message)
      return true
    }
    if (data === 'user_cap') {
      console.log(`[aiUsage] Anthropic per-customer daily token cap (${userDailyCap}) reached for user ${userId} — expected behaviour, does not affect other customers`)
      return false
    }
    if (data === 'platform_cap') {
      console.error(`[aiUsage] Anthropic PLATFORM-WIDE daily token cap (${platformDailyCap}) reached for today — every customer's chat/scan calls are now affected until it resets at midnight UTC`)
      alertIfConfigured(`:warning: Anthropic platform-wide daily token cap (${platformDailyCap}) reached for today — every customer's chat and scan calls are now being refused until it resets at midnight UTC. Raise ANTHROPIC_DAILY_TOKEN_CAP in Netlify if this is happening earlier in the day than expected.`)
      return false
    }
    if (data !== 'ok') console.error('[aiUsage] anthropic_reserve_tokens RPC returned an unexpected value, allowing the call through:', data)
    return true
  } catch (err) {
    console.error('[aiUsage] anthropic_reserve_tokens threw, allowing the call through:', err.message)
    return true
  }
}

// Corrects a reservation once Anthropic has told us what the call actually
// cost. reserveAnthropicTokens books max_tokens up front because that is the
// only number available before the call; nothing ever adjusted it afterwards,
// so anthropic_usage was wrong in three directions at once — output
// over-counted (Chat.jsx reserves 1500 against a measured ~485), input
// counted as ZERO despite the system prompt, CRM snapshot, history and every
// web-search result block all being billed input, and web search tool uses
// metered as nothing at all.
//
// `actual` should be usage.input_tokens + usage.output_tokens straight off
// the Anthropic response. The delta is applied signed: usually negative
// (hand budget back), but positive whenever input dominated, which is the
// case that was previously invisible and is exactly when a customer should
// be approaching their cap.
//
// Best-effort by design. A failure here must never turn a successful reply
// into an error — the worst case is the old behaviour, an unreconciled
// reservation.
export async function reconcileAnthropicTokens(supabase, userId, reservedTokens, actualTokens) {
  if (!supabase) return
  if (!Number.isFinite(reservedTokens) || !Number.isFinite(actualTokens)) return
  if (reservedTokens === actualTokens) return
  try {
    const { error } = await supabase.rpc('anthropic_reconcile_tokens', {
      p_reserved: Math.round(reservedTokens), p_actual: Math.round(actualTokens), p_user_id: userId || null,
    })
    if (error) console.error('[aiUsage] anthropic_reconcile_tokens RPC failed:', error.message)
  } catch (err) {
    console.error('[aiUsage] anthropic_reconcile_tokens threw:', err.message)
  }
}

// Pulls the billable token total out of an Anthropic response body. Handles
// both the non-streaming shape (top-level `usage`) and the accumulated
// streaming shape, where message_start carries input_tokens and message_delta
// carries the final output_tokens. Returns null when Anthropic reported
// nothing usable, so callers can leave the reservation alone rather than
// reconcile against a guess.
export function anthropicBilledTokens(usage) {
  if (!usage) return null
  const input = Number(usage.input_tokens) || 0
  const output = Number(usage.output_tokens) || 0
  const cacheRead = Number(usage.cache_read_input_tokens) || 0
  const cacheWrite = Number(usage.cache_creation_input_tokens) || 0
  const total = input + output + cacheRead + cacheWrite
  return total > 0 ? total : null
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

// Raw I/O against todays_action_state — see the migration
// (2026-08-24-todays-action-state.sql) for why this table only ever stores
// "have I shown this" and "is it done", never any copy of a card's content.
// resolve.js is the only caller; kept as its own file so the actual
// Supabase calls are isolated from the selection logic around them.

// 2026-09-02 audit fix: a single .in('item_key', itemKeys) sends every key
// as a GET querystring. A first-ever bulk CSV import (hundreds of new hot/
// warm contacts, zero deals anywhere yet) produces hundreds of brand-new
// item keys on one load, building a 40KB+ request URL that gets rejected
// before it reaches Postgres -- this is what took down Today's Actions AND
// Overview together (Overview runs this exact same pipeline, see its own
// header comment). Chunking keeps every request small regardless of import
// size, with no behavior change for the normal, small-batch case.
const CHUNK_SIZE = 150

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function loadActionState(supabase, userId, itemKeys) {
  if (!itemKeys.length) return new Map()
  const result = new Map()
  for (const batch of chunk(itemKeys, CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('todays_action_state')
      .select('item_key, status, first_shown_at')
      .eq('user_id', userId)
      .in('item_key', batch)
    if (error) throw error
    for (const r of (data || [])) result.set(r.item_key, r)
  }
  return result
}

// Called once per genuinely new item on every load — records that it's now
// been seen, so a later load can tell "already shown, still eligible" apart
// from "brand new today". ignoreDuplicates means a race between two tabs
// loading at once can't throw on the unique (user_id, item_key) constraint.
// Also chunked (same reasoning as loadActionState) so a large first import
// can't send one oversized upsert payload either.
export async function recordFirstSeen(supabase, userId, itemKeys) {
  if (!itemKeys.length) return
  for (const batch of chunk(itemKeys, CHUNK_SIZE)) {
    await supabase.from('todays_action_state').upsert(
      batch.map(item_key => ({ user_id: userId, item_key, status: 'active' })),
      { onConflict: 'user_id,item_key', ignoreDuplicates: true }
    )
  }
}

export async function markItemDone(supabase, userId, itemKey) {
  // 2026-08-26 audit fix: this write's result was previously discarded, so
  // a failed upsert (RLS denial, dropped connection) still let the caller
  // remove the card from the visible list — it would then silently
  // reappear on the next load since todays_action_state never actually
  // recorded it as done.
  if (!itemKey) return { error: null }
  const { error } = await supabase.from('todays_action_state').upsert(
    { user_id: userId, item_key: itemKey, status: 'done', done_at: new Date().toISOString() },
    { onConflict: 'user_id,item_key' }
  )
  return { error }
}

// Raw I/O against todays_action_state — see the migration
// (2026-08-24-todays-action-state.sql) for why this table only ever stores
// "have I shown this" and "is it done", never any copy of a card's content.
// resolve.js is the only caller; kept as its own file so the actual
// Supabase calls are isolated from the selection logic around them.

export async function loadActionState(supabase, userId, itemKeys) {
  if (!itemKeys.length) return new Map()
  const { data, error } = await supabase
    .from('todays_action_state')
    .select('item_key, status, first_shown_at')
    .eq('user_id', userId)
    .in('item_key', itemKeys)
  if (error) throw error
  return new Map((data || []).map(r => [r.item_key, r]))
}

// Called once per genuinely new item on every load — records that it's now
// been seen, so a later load can tell "already shown, still eligible" apart
// from "brand new today". ignoreDuplicates means a race between two tabs
// loading at once can't throw on the unique (user_id, item_key) constraint.
export async function recordFirstSeen(supabase, userId, itemKeys) {
  if (!itemKeys.length) return
  await supabase.from('todays_action_state').upsert(
    itemKeys.map(item_key => ({ user_id: userId, item_key, status: 'active' })),
    { onConflict: 'user_id,item_key', ignoreDuplicates: true }
  )
}

export async function markItemDone(supabase, userId, itemKey) {
  if (!itemKey) return
  await supabase.from('todays_action_state').upsert(
    { user_id: userId, item_key: itemKey, status: 'done', done_at: new Date().toISOString() },
    { onConflict: 'user_id,item_key' }
  )
}

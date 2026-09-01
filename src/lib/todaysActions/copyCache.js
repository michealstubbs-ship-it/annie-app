// Raw I/O against actions_cache — same "isolate the actual Supabase calls
// from the selection logic around them" convention as state.js. `supabase`
// is a parameter, not imported here, so this can be tested with a fake
// client the same way resolve.test.js/state.test.js already do — see this
// file's own tests.
//
// 2026-09-01 fix, Michael's own report: "Today's actions takes too long to
// load." Root cause: useTodaysActions.js's refresh() ran a live AI batch
// call for EVERY CRM item's headline/detail/moveForward and EVERY sourced
// item's candidate pitch, on every single page open, with zero caching —
// even when nothing about the underlying contact/deal/signal had changed
// since the last visit. Each batch carries its own 15s ceiling
// (AI_BATCH_TIMEOUT_MS in useTodaysActions.js), so a normal load with a
// handful of batches routinely took several seconds to feel far from
// "instant".
//
// This repurposes the actions_cache table — one row per user (UNIQUE
// user_id, see supabase-setup.sql), RLS-scoped to its own owner — which has
// been unused dead weight since Today's BD Actions moved off the old
// wholesale-regenerated actionsEngine.js design. Its `actions` JSONB column
// now holds a plain map of { [itemKey]: { sig, enriched?, pitch?, cachedAt } }
// instead of that old design's full rendered list — keyed by each item's
// stable actionKey (or a "pitch:" prefixed variant for a sourced item's
// candidate pitch, a different piece of copy on the same signal), each
// entry paired with a signature of exactly the fields that fed that item's
// prompt (see describeItem/describePitchTarget in actionsCopy.js).
// useTodaysActions.js only pays for a fresh AI call when an item is new or
// its signature has actually changed; everything else renders straight
// from cache.
// A read failure here is never worth failing the whole page load over — the
// cache is a perf optimization, not a correctness requirement (every cache
// miss just falls back to the real AI call, same as today, so the worst a
// bad read does is cost the load a bit of speed, not break it). Any error
// (RLS hiccup, dropped connection, unreadable payload) is treated the same
// as "nothing cached yet".
export async function loadCopyCache(supabase, userId) {
  const { data, error } = await supabase.from('actions_cache').select('actions').eq('user_id', userId).maybeSingle()
  if (error) return {}
  return (data?.actions && typeof data.actions === 'object' && !Array.isArray(data.actions)) ? data.actions : {}
}

// Called fire-and-forget from useTodaysActions.js — writing the cache is
// never on the critical path for what the user sees, only reading it is.
// `keepKeys` prunes any entry for an item that isn't part of this round's
// selection any more (done, aged out, underlying record gone) so the cache
// can't grow unbounded — it naturally tracks the size of what's currently
// selected, not everything ever seen.
export async function saveCopyCache(supabase, userId, previousCache, newEntries, keepKeys) {
  const merged = {}
  for (const [key, value] of Object.entries(previousCache || {})) {
    if (keepKeys.has(key)) merged[key] = value
  }
  for (const [key, value] of Object.entries(newEntries || {})) {
    merged[key] = value
  }
  const { error } = await supabase.from('actions_cache').upsert(
    { user_id: userId, actions: merged, generated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  )
  if (error) throw error
}

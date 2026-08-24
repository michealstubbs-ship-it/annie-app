import { actionKey } from './actionKey.js'
import { loadActionState, recordFirstSeen, markItemDone } from './state.js'

// The replacement for the old mergeActions/stillActive pair — and the
// actual fix for why every version of Today's Actions has broken in some
// way. The old design stored a frozen content snapshot per item and had to
// separately re-derive, on every load, whether each snapshot still
// deserved to be shown (stillActive) — a second, independent copy of
// "is this eligible" that the pool builders' own filtering could silently
// drift out of sync with. That's exactly what happened with the DP World
// card and the Apollo contact-masking bug.
//
// This has no snapshot and nothing to re-derive. `freshActions` is always
// the result of a fresh, live computation (pools -> selectDailyItems -> AI
// copy -> reshaped into final action objects, all done by the caller before
// this runs) — so "is this still eligible" is already true by construction,
// every single time. The only question left for this function to answer is
// "has the user already marked this done", which is the one thing that
// genuinely needs to persist across loads, and the one thing
// todays_action_state exists to store.
export async function resolveTodaysActions({ supabase, userId, freshActions }) {
  // An item with no stable identity can never be tracked as done, so it can
  // never safely be shown as persistent state, same as the old code's own
  // final fallback ("no stable identity to verify against, don't keep an
  // item around unverified").
  const keyed = freshActions.map(item => ({ item, key: actionKey(item) })).filter(({ key }) => key)

  const state = await loadActionState(supabase, userId, keyed.map(k => k.key))

  const visible = keyed.filter(({ key }) => state.get(key)?.status !== 'done')

  const newKeys = visible.filter(({ key }) => !state.has(key)).map(({ key }) => key)
  if (newKeys.length) await recordFirstSeen(supabase, userId, newKeys)

  return visible
    .map(({ item }) => item)
    .sort((a, b) => (b.urgency - a.urgency) || ((b.score || 0) - (a.score || 0)))
}

// Marks an item done in todays_action_state, and — for signal-backed items
// only — also flips the real, server-side status on intelligence_signals.
// That second write is what makes "actioned" a genuine fact every consumer
// of that table sees (the Intelligence Feed, a future scan), not something
// local to Today's Actions' own bookkeeping.
export async function markActionDone(supabase, userId, action) {
  const key = actionKey(action)
  if (!key) return
  await markItemDone(supabase, userId, key)
  if (action.signalId) {
    await supabase.from('intelligence_signals').update({ status: 'actioned' }).eq('id', action.signalId)
  }
}

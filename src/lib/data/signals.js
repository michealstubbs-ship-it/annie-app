import { supabase } from '../supabase'

// Every raw `intelligence_signals` Supabase call (IntelligenceFeed.jsx), in
// one place — same reasoning as contacts.js/candidates.js/companies.js/jobs.js.

// The feed's own list: everything not yet actioned, newest first, capped
// at 200.
// 2026-09-02, Michael: live_job rows used to be excluded here deliberately —
// shown only in Today's Actions, not the Feed. Michael's own direction
// ("I think it should show up here as Live job in its own tab and always
// filter into today's actions") reverses that: live_job now flows into the
// Feed like every other signal type, where SIGNAL_TYPE_META.live_job
// (signalTypes.js) already gives it a "Live roles" 💼 chip that appears
// automatically the moment a live_job row exists — see IntelligenceFeed.jsx's
// presentTypes derivation. It still ALSO always surfaces in Today's Actions
// via BD_ACTION_SIGNAL_TYPES (todaysActions/eligibility.js) — this is
// additive, not a move out of Actions.
// 2026-08-24: intelligence_signals is PERSONAL, not team-scoped — a
// previous pass here incorrectly treated it like the shared CRM tables and
// dropped this filter, relying only on RLS. RLS does still enforce this
// (see the 2026-08-24 crm-sharing-model-and-signal-privacy migration —
// intelligence_signals_select_own is user_id-only, no team branch), but the
// filter is kept explicit here too: different recruiters on the same team
// can be working entirely different markets, so Annie's feed and Today's
// Actions have to stay tuned to each person's own market, never pooled
// across the team. A team owner gets their own separate, read-only,
// explicitly-additive way to see teammates' activity — see
// lib/data/teamActivity.js — rather than this list ever silently widening.
// 2026-08-26 audit fix: throws on a Supabase error instead of silently
// falling back to `data || []` — see contacts.js's header comment for the
// full reasoning. Here the throw is caught by useSupabaseQuery (see
// loadFeedPageData in IntelligenceFeed.jsx), which already sets its own
// `error` state for exactly this case.
export async function listActiveSignals(userId) {
  const { data, error } = await supabase
    .from('intelligence_signals')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'actioned')
    .order('found_at', { ascending: false })
    .limit(200)
  if (error) throw error
  return data || []
}

export function markSignalSeen(id) {
  return supabase.from('intelligence_signals').update({ status: 'seen' }).eq('id', id)
}

export function markSignalActioned(id) {
  return supabase.from('intelligence_signals').update({ status: 'actioned' }).eq('id', id)
}

// The Feed's "Add to Today's BD Actions" button — a real human explicitly
// chose to pursue this signal, so it needs to reliably show up in Today's
// Actions regardless of score/age/urgency. See actionsEngine.js's
// buildSourcedPool/buildRelationshipPool for the bypass rule this enables.
export function markSignalManuallyAdded(id) {
  return supabase.from('intelligence_signals').update({ manually_added_at: new Date().toISOString() }).eq('id', id)
}

// The two states the recruiter sets themselves, added 2026-09-04 with the
// single-stream rebuild. intelligence_signals.status already carried
// new/seen/actioned; these sit alongside them and, crucially, are NOT
// 'actioned' — so a working or parked item still comes back from every read
// in the app (they all filter on .neq('status','actioned')) and stays in the
// stream where the recruiter put it.
export function markSignalWorking(id) {
  return supabase.from('intelligence_signals').update({ status: 'working' }).eq('id', id)
}

export function markSignalParked(id) {
  return supabase.from('intelligence_signals').update({ status: 'parked' }).eq('id', id)
}

// Back to the undifferentiated pile. 'seen' rather than 'new' because the
// recruiter has demonstrably looked at it.
export function markSignalOpen(id) {
  return supabase.from('intelligence_signals').update({ status: 'seen' }).eq('id', id)
}

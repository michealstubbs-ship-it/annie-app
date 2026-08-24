import { supabase } from '../supabase'

// Every raw `intelligence_signals` Supabase call (IntelligenceFeed.jsx), in
// one place — same reasoning as contacts.js/candidates.js/companies.js/jobs.js.

// The feed's own list: everything not yet actioned, newest first, capped
// at 200. live_job rows are excluded deliberately — they're specific open
// roles behind a hiring push, shown only in Today's Actions (see the
// comment this carries over from IntelligenceFeed.jsx itself), not
// duplicated here.
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
export async function listActiveSignals(userId) {
  const { data } = await supabase
    .from('intelligence_signals')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'actioned')
    .neq('signal_type', 'live_job')
    .order('found_at', { ascending: false })
    .limit(200)
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

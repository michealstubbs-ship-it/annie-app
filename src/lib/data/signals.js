import { supabase } from '../supabase'

// Every raw `intelligence_signals` Supabase call (IntelligenceFeed.jsx), in
// one place — same reasoning as contacts.js/candidates.js/companies.js/jobs.js.

// The feed's own list: everything not yet actioned, newest first, capped
// at 200. live_job rows are excluded deliberately — they're specific open
// roles behind a hiring push, shown only in Today's Actions (see the
// comment this carries over from IntelligenceFeed.jsx itself), not
// duplicated here.
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

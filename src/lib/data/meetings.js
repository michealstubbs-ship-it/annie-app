import { supabase } from '../supabase'

// Every raw `meetings` Supabase call, in one place — same reasoning as
// contacts.js/candidates.js/companies.js/jobs.js.

// 2026-08-24: meetings is team-scoped — RLS already restricts every row to
// the caller's active team, so no client-side user_id filter on top of it.
// 2026-08-26 audit fix: throws on a Supabase error instead of silently
// falling back to `data || []` — see contacts.js's header comment for the
// full reasoning (same fix, same pattern, applied file-by-file).
// 2026-09-08, gap-analysis batch 9 ("interview notes typed on the Meetings
// page don't show up anywhere for that candidate"): meetings has always had
// a candidate_id column too (interviews created via updatePipelineLinkInterview
// in pipelineLinks.js set it), but this query never joined the candidate's
// own name — a candidate-linked meeting rendered with a blank "who this was
// with" line, same class of bug as the contact join it already had.
export async function listMeetingsWithContacts(userId) {
  const { data, error } = await supabase
    .from('meetings')
    .select('*, contacts(name, company), candidates(name)')
    .order('meeting_date', { ascending: false })
  if (error) throw error
  return data || []
}

export function createMeeting(row, userId) {
  return supabase.from('meetings').insert({ ...row, user_id: userId })
}

export function updateMeeting(id, row) {
  return supabase.from('meetings').update(row).eq('id', id)
}

export function deleteMeeting(id) {
  return supabase.from('meetings').delete().eq('id', id)
}

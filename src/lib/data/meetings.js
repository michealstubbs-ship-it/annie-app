import { supabase } from '../supabase'

// Every raw `meetings` Supabase call, in one place — same reasoning as
// contacts.js/candidates.js/companies.js/jobs.js.

export async function listMeetingsWithContacts(userId) {
  const { data } = await supabase
    .from('meetings')
    .select('*, contacts(name, company)')
    .eq('user_id', userId)
    .order('meeting_date', { ascending: false })
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

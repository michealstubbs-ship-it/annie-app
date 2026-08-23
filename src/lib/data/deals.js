import { supabase } from '../supabase'

// Every raw `deals` Supabase call (Pipeline.jsx), in one place — same
// reasoning as contacts.js/candidates.js/companies.js/jobs.js.

export async function listDeals(userId) {
  const { data } = await supabase.from('deals').select('*').eq('user_id', userId).order('created_at', { ascending: false })
  return data || []
}

export function createDeal(row, userId) {
  return supabase.from('deals').insert({ ...row, user_id: userId })
}

export function updateDeal(id, row) {
  return supabase.from('deals').update(row).eq('id', id)
}

export function deleteDeal(id) {
  return supabase.from('deals').delete().eq('id', id)
}

import { supabase } from '../supabase'

// Every raw `deals` Supabase call (Pipeline.jsx), in one place — same
// reasoning as contacts.js/candidates.js/companies.js/jobs.js.

// 2026-08-24: deals is team-scoped — RLS already restricts every row to the
// caller's active team, so no client-side user_id filter on top of it.
export async function listDeals(userId) {
  const { data } = await supabase.from('deals').select('*').order('created_at', { ascending: false })
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

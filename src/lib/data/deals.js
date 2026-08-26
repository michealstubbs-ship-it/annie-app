import { supabase } from '../supabase'

// Every raw `deals` Supabase call (Pipeline.jsx), in one place — same
// reasoning as contacts.js/candidates.js/companies.js/jobs.js.

// 2026-08-24: deals is team-scoped — RLS already restricts every row to the
// caller's active team, so no client-side user_id filter on top of it.
// 2026-08-26 audit fix: throws on a Supabase error instead of silently
// falling back to `data || []` — see contacts.js's header comment for the
// full reasoning (same fix, same pattern, applied file-by-file).
export async function listDeals(userId) {
  const { data, error } = await supabase.from('deals').select('*').order('created_at', { ascending: false })
  if (error) throw error
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

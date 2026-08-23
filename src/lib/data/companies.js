import { supabase } from '../supabase'

// Every raw `companies` Supabase call, in one place — see contacts.js's
// header comment for why (same 2026-08-22 audit finding, same fix).

export async function listCompanies(userId) {
  const { data } = await supabase.from('companies').select('*').eq('user_id', userId).order('name')
  return data || []
}

export function createCompany(row, userId) {
  return supabase.from('companies').insert({ ...row, user_id: userId })
}

export function updateCompany(id, row) {
  return supabase.from('companies').update(row).eq('id', id)
}

export function deleteCompany(id) {
  return supabase.from('companies').delete().eq('id', id)
}

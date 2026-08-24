import { supabase } from '../supabase'

// Every raw `companies` Supabase call, in one place — see contacts.js's
// header comment for why (same 2026-08-22 audit finding, same fix).

// 2026-08-24: companies is now a team-scoped table (see
// supabase-migrations/2026-08-24-teams-and-shared-crm.sql) — RLS already
// restricts every row to the caller's active team, so no client-side
// user_id filter is added on top of it. `userId` is kept as a parameter
// only for createCompany, which still needs to stamp who created a row.
export async function listCompanies(userId) {
  const { data } = await supabase.from('companies').select('*').order('name')
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

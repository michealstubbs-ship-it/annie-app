import { supabase } from '../supabase'

// Every raw call backing the admin "Learned sources" tab, in one place —
// same reasoning as contacts.js/companies.js's own header comments. Both
// RPCs are admin-gated server-side (get_admin_learned_sources/
// admin_delete_learned_source, 2026-08-27-learned-sources-quality-guard.sql)
// — a non-admin calling either gets a thrown "Not authorized" from Postgres
// itself, same pattern as every other admin RPC in this codebase.
//
// Built for a real, previously-flagged gap: annie_learned_sources (the
// shared company/source memory the scan prompts read from, see
// scanShared.js's getLearnedSources) had zero admin visibility — no way to
// see what Annie has learned, or remove a bad entry (a typo, test data, or
// a placeholder a customer typed into their CRM), short of direct SQL.
export async function getAdminLearnedSources({ sector = null, search = null, limit = 200 } = {}) {
  const { data, error } = await supabase.rpc('get_admin_learned_sources', {
    p_sector: sector || null,
    p_search: search || null,
    p_limit: limit,
  })
  if (error) throw error
  return data || []
}

export async function deleteAdminLearnedSource(id) {
  const { error } = await supabase.rpc('admin_delete_learned_source', { p_id: id })
  if (error) throw error
}

import { supabase } from '../supabase'

// Every raw `company_documents` Supabase call, in one place — same
// convention as contacts.js/companies.js (see companies.js's own header
// comment for the reasoning). Storage upload/download itself stays in
// Companies.jsx, same precedent Candidates.jsx already set for CVs — this
// file is just the DB row side (list/create/delete).

export async function listCompanyDocuments(companyId) {
  const { data, error } = await supabase
    .from('company_documents')
    .select('*')
    .eq('company_id', companyId)
    .order('uploaded_at', { ascending: false })
  if (error) throw error
  return data || []
}

export function createCompanyDocument(row) {
  return supabase.from('company_documents').insert(row)
}

export function deleteCompanyDocument(id) {
  return supabase.from('company_documents').delete().eq('id', id)
}

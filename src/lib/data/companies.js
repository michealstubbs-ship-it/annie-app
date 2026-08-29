import { supabase } from '../supabase'
import { normalizeCompanyName } from '../companyMatch'

// Every raw `companies` Supabase call, in one place — see contacts.js's
// header comment for why (same 2026-08-22 audit finding, same fix).

// 2026-08-24: companies is now a team-scoped table (see
// supabase-migrations/2026-08-24-teams-and-shared-crm.sql) — RLS already
// restricts every row to the caller's active team, so no client-side
// user_id filter is added on top of it. `userId` is kept as a parameter
// only for createCompany, which still needs to stamp who created a row.
// 2026-08-26 audit fix: throws on a Supabase error instead of silently
// falling back to `data || []` — see contacts.js's header comment for the
// full reasoning (same fix, same pattern, applied file-by-file).
export async function listCompanies(userId) {
  const { data, error } = await supabase.from('companies').select('*').order('name')
  if (error) throw error
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

// 2026-08-29 audit fix, flagged directly: Today's Actions' "add to CRM"
// button only ever wrote a bare free-text `company` string onto the new
// contact — it never found or created a real companies row, so the contact
// never got a company_id and was silently invisible under its own
// company's tab in Companies.jsx (see listContactsWithCompany in
// contacts.js — it only returns contacts that already have one). Every
// other contact-creation path already does this correctly: ContactFormModal
// via its CompanySelect picker, and LinkedInImport.jsx's bulk import (same
// find-or-create-by-name approach, just for a whole batch at once). This is
// that same pattern, for one contact at a time.
//
// Matches on the exact-normalized-name convention CompanySelect.jsx already
// uses (normalizeCompanyName(a) === normalizeCompanyName(b)) — not the
// fuzzy, containment-allowing companiesMatch used elsewhere for AI-written
// signal company names. That fuzziness is right when guessing whether an
// AI-generated name refers to a company already in the CRM; it's the wrong
// bar here, where a mismatch would silently attach a contact to the wrong
// company. Same reasoning CompanySelect.jsx's own dedup already applies.
//
// Paginated read, not a single .select(): Supabase caps one request at
// 1000 rows by default with no error — an established team's CRM growing
// past that would otherwise silently miss a real match and create a
// duplicate company (same fix LinkedInImport.jsx already applies, same
// reason — see its own header comment).
const COMPANY_PAGE_SIZE = 500
async function fetchAllCompanyNames() {
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await supabase.from('companies').select('id, name').range(from, from + COMPANY_PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < COMPANY_PAGE_SIZE) break
    from += COMPANY_PAGE_SIZE
  }
  return rows
}

// Returns the id of an existing company matching `name`, or creates one and
// returns its new id. Returns null for a blank name — not every contact has
// a company on file, and that's a legitimate state, not an error.
export async function findOrCreateCompany(name, userId) {
  const trimmed = (name || '').trim()
  if (!trimmed) return null

  const existing = await fetchAllCompanyNames()
  const key = normalizeCompanyName(trimmed)
  const match = existing.find(co => normalizeCompanyName(co.name) === key)
  if (match) return match.id

  const { data, error } = await supabase.from('companies').insert({ name: trimmed, user_id: userId }).select('id').single()
  if (error) throw error
  return data.id
}

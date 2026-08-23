import { supabase } from '../supabase'

// Every raw `contacts` Supabase call, in one place. A 2026-08-22
// scale-readiness audit found the same shape of query (select/insert/update/
// delete against this table, scoped to eq('user_id', ...)) duplicated,
// with small inconsistencies, across Contacts.jsx, ContactFormModal.jsx, and
// Companies.jsx. The goal isn't behavior change, it's that a future change
// to this table (a renamed column, a new required field, an added RLS
// concern) has one file to touch instead of three.

export async function listContacts(userId) {
  const { data } = await supabase.from('contacts').select('*').eq('user_id', userId).order('created_at', { ascending: false })
  return data || []
}

// Companies.jsx's own read: every contact that belongs to SOME company,
// for building each company's contact list client-side (see contactsFor()).
export async function listContactsWithCompany(userId) {
  const { data } = await supabase
    .from('contacts')
    .select('id, name, title, email, status, company_id')
    .eq('user_id', userId)
    .not('company_id', 'is', null)
  return data || []
}

export function createContact(row, userId) {
  return supabase.from('contacts').insert({ ...row, user_id: userId }).select().single()
}

export function updateContact(id, row) {
  return supabase.from('contacts').update(row).eq('id', id).select().single()
}

export function deleteContact(id) {
  return supabase.from('contacts').delete().eq('id', id)
}

// Meetings.jsx and Tasks.jsx's "link to a contact" pickers — just enough
// to show a name (and company, for disambiguating two "John"s) in a
// dropdown, not the full contact record.
export async function listContactsMinimal(userId) {
  const { data } = await supabase.from('contacts').select('id, name, company').eq('user_id', userId).order('name')
  return data || []
}

// IntelligenceFeed.jsx's "warm door" check (see findWarmContacts) — every
// contact, just enough fields to match a signal's company against and to
// show if a match is found.
export async function listContactsForMatching(userId) {
  const { data } = await supabase.from('contacts').select('id, name, title, company, linkedin_url').eq('user_id', userId)
  return data || []
}

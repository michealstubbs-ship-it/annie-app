import { supabase } from '../supabase'

// Every raw `candidates` Supabase call, in one place — see contacts.js's
// header comment for why (same 2026-08-22 audit finding, same fix).

// 2026-08-24: candidates is team-scoped — RLS already restricts every row
// to the caller's active team, so none of the reads below add a
// client-side user_id filter on top of it.
// 2026-08-26 audit fix: every read below now throws on a Supabase error
// instead of silently falling back to `data || []` — see contacts.js's
// header comment for the full reasoning (same fix, same pattern).
export async function listCandidatesWithJobs(userId) {
  const { data, error } = await supabase
    .from('candidates')
    .select('*, jobs(title, companies(name))')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export function createCandidate(row, userId) {
  return supabase.from('candidates').insert({ ...row, user_id: userId })
}

// 2026-09-03, Michael: "in case there are any ownerships" — before a second
// team member unknowingly adds the same candidate as if they were new, this
// checks for an existing row with the same email first. Email-only (not
// name — two different real people are very often named the same thing,
// but never share an email) and case-insensitive, since a re-typed email
// varies in case far more often than it varies in spelling. Nothing calls
// this automatically on every keystroke — Candidates.jsx's save() checks it
// once, only for a brand-new candidate, only when an email was given.
export async function findCandidateDuplicateByEmail(email) {
  if (!email?.trim()) return null
  const { data, error } = await supabase
    .from('candidates')
    .select('id, name, owner_id, created_at')
    .ilike('email', email.trim())
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data || null
}

export function updateCandidate(id, row) {
  return supabase.from('candidates').update(row).eq('id', id)
}

export function deleteCandidate(id) {
  return supabase.from('candidates').delete().eq('id', id)
}

// Jobs.jsx's per-job candidate count — just the job_id of every candidate
// that's linked to one, counted client-side (see candCounts in Jobs.jsx).
export async function listCandidateJobLinks(userId) {
  const { data, error } = await supabase.from('candidates').select('job_id').not('job_id', 'is', null)
  if (error) throw error
  return data || []
}

// Today's Actions' pipeline-match check (see matchCandidatesToSignal) —
// every candidate, just enough fields to match a signal against and to
// show a real name/role/company on a matched card. `company` added
// 2026-08-23 so the pipeline-match box can show a matched candidate's
// actual current employer instead of just a bare name. `notes` added the
// same day so the per-candidate "why" pitch (buildWhyChips/generate() in
// TodaysActions.jsx) has real, recruiter-written substance to ground a
// specific-sounding sentence in, rather than only role/company/industry —
// still nothing invented beyond what's actually on file for that candidate.
//
// Deliberately no .limit() here, unlike the contacts/deals queries in
// useTodaysActions.js's refresh(): capping this would silently drop real
// candidates from pipeline-matching, worst for exactly the agencies with
// the biggest candidate pools — the customers this feature helps most.
// 2026-08-29 audit fix: an uncapped query here was never the actual
// problem — matching every candidate against every sourced signal, once
// per signal, with the SAME candidates re-tokenized from scratch on every
// single call, was. See candidateMatch.js's prepareCandidatesForMatching
// for the real fix (tokenize once per refresh, not once per signal).
export async function listCandidatesForMatching(userId) {
  const { data, error } = await supabase.from('candidates').select('id, name, role, industry, status, company, notes')
  if (error) throw error
  return data || []
}

// Tasks.jsx's "link to a candidate" picker — just a name in a dropdown.
export async function listCandidatesMinimal(userId) {
  const { data, error } = await supabase.from('candidates').select('id, name').order('name')
  if (error) throw error
  return data || []
}

// Invoices.jsx's "candidate placed" picker — every candidate with enough
// fields to filter to the ones linked to the invoice's selected job and to
// show which one is actually marked 'placed'. Any candidate on the job can
// still be picked, not just 'placed' ones — a recruiter sometimes raises
// the invoice before formally flipping the status, and this shouldn't
// block that.
export async function listCandidatesForInvoicePicker() {
  const { data, error } = await supabase.from('candidates').select('id, name, job_id, status').order('name')
  if (error) throw error
  return data || []
}

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

// 2026-09-07: now selects its own insert back (previously just fired the
// insert and returned {error}). Candidates.jsx's own comment on this used
// to note that a brand-new candidate's id was unknown right after Save, so
// the "raise an invoice now" placement prompt couldn't pre-select them, and
// the new "create a candidate from a job's pipeline" flow (JobPipeline.jsx,
// gap-analysis batch 8) needs the fresh id to add the right row to
// candidate_job_links. Every existing caller destructures only `{ error }`
// off the result, so this is additive, not a breaking change.
export function createCandidate(row, userId) {
  return supabase.from('candidates').insert({ ...row, user_id: userId }).select().single()
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

// 2026-09-03, Michael ("double-submission warnings" — the other of the two
// oversights he asked to be prioritized): a same-candidate check that's
// ADDITIONALLY scoped to one job, unlike findCandidateDuplicateByEmail
// above (which is deliberately team-wide, not job-scoped — "is this person
// already anywhere in our system"). This is the more specific, classic
// recruitment-agency landmine researched the same day: two consultants on
// the same team submitting the same real person to the same client
// without realizing it, which damages the client relationship and creates
// an internal dispute over whose placement it is. A soft warning, not a
// hard block — matches both the researched industry norm (Bullhorn) and
// this codebase's own existing duplicate-check UX, rather than refusing
// the save outright the way a stricter competitor (Recruitee/AgencyHub)
// does.
export async function findDuplicateSubmission(email, jobId) {
  if (!email?.trim() || !jobId) return null
  const { data, error } = await supabase
    .from('candidates')
    .select('id, name, owner_id, status, created_at')
    .ilike('email', email.trim())
    .eq('job_id', jobId)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data || null
}

// 2026-09-06, gap-analysis batch 2 ("referral program tracking"): best-
// effort resolve of a free-typed referrer name to an existing candidate
// record, mirroring findOrCreateCompany's own "not found is a legitimate
// state, not an error" reasoning — a referrer who isn't in the CRM at all
// (a client contact, a friend-of-the-agency) is common and fine; this
// just upgrades referrer_name to a real link when an exact match exists.
// Case-insensitive exact match only (not fuzzy) — the same bar
// findOrCreateCompany uses for its own dedupe check, since a loose match
// here risks silently linking to the WRONG person.
export async function findCandidateIdByExactName(name) {
  if (!name?.trim()) return null
  const { data, error } = await supabase
    .from('candidates')
    .select('id')
    .ilike('name', name.trim())
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.id || null
}

export function updateCandidate(id, row) {
  return supabase.from('candidates').update(row).eq('id', id)
}

// 2026-09-08, gap-analysis batch 9 ("interview notes typed on the Meetings
// page don't show up anywhere for that candidate"): unlike contacts (which
// have a real contact_notes timeline table), candidates only ever had the
// single candidates.notes text field — so this appends a timestamped block
// onto whatever's already there instead of silently overwriting it, same
// non-destructive intent as contactNotes.js's createContactNote, just
// modeled on this table's own existing single-field shape rather than
// standing up a new table for one feature. Called from Meetings.jsx's own
// logMeetingNoteIfChanged, the candidate-linked twin of its existing
// contact_notes path.
export async function appendCandidateNote(candidateId, text) {
  if (!candidateId || !text?.trim()) return
  const { data, error } = await supabase.from('candidates').select('notes').eq('id', candidateId).maybeSingle()
  if (error) throw error
  if (!data) return
  const existing = (data.notes || '').trim()
  const next = existing ? `${existing}\n\n${text.trim()}` : text.trim()
  const { error: updErr } = await updateCandidate(candidateId, { notes: next })
  if (updErr) throw updErr
}

export function deleteCandidate(id) {
  return supabase.from('candidates').delete().eq('id', id)
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

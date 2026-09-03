import { supabase } from '../supabase'
import { updateCandidate } from './candidates'
import { createMeeting } from './meetings'

// Same hand-rolled "today" bounds Overview.jsx already uses for its own
// meetings query — no date-fns dependency in this project, so this matches
// the existing local pattern rather than adding one.
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d }
function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d }
function isToday(dateStr) {
  const t = new Date(dateStr).getTime()
  return t >= startOfToday().getTime() && t <= endOfToday().getTime()
}

// Every raw `candidate_job_links` call, in one place — same reasoning as
// contacts.js/candidates.js/companies.js/jobs.js/meetings.js. This is the
// real build behind mockups/pipeline-v2-mockup.html (2026-09-03, Michael:
// "build the whole job [pipeline] mock you created"), backed by the
// many-to-many candidate_job_links table (see
// supabase-migrations/2026-09-03-candidate-job-pipeline-links.sql) rather
// than the single candidates.job_id column every other page still reads.
//
// candidate_job_links is team-scoped by RLS — none of the reads below add
// a client-side user_id filter on top of it, and every read throws on a
// Supabase error instead of silently falling back to `data || []`, same
// pattern as every other data/*.js file this session.

// The job pipeline board's own query: every link for one job, newest
// stage-change first, joined with just enough of the candidate to render a
// card (want_sal is the "salary" field of record — see candidatesView.js's
// own sortCandidates for why want_sal, not curr_sal, is what's shown).
export async function listPipelineForJob(jobId) {
  const { data, error } = await supabase
    .from('candidate_job_links')
    .select('*, candidates(id, name, role, company, want_sal, want_sal_currency, source, email, cv_path)')
    .eq('job_id', jobId)
    .order('stage_changed_at', { ascending: false })
  if (error) throw error
  return data || []
}

// The mockup's "also in 2 other pipelines" / Candidate view — every OTHER
// job this candidate has a pipeline entry on. excludeJobId leaves out the
// job currently being viewed, since that's the primary context, not one of
// the "others".
export async function listOtherPipelinesForCandidate(candidateId, excludeJobId) {
  if (!candidateId) return []
  let query = supabase
    .from('candidate_job_links')
    .select('*, jobs(id, title, companies(name))')
    .eq('candidate_id', candidateId)
  if (excludeJobId) query = query.neq('job_id', excludeJobId)
  const { data, error } = await query.order('stage_changed_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Adds a candidate to a job's pipeline as a SECONDARY link — the mockup's
// "submit to another job" action taken from the pipeline board itself.
// is_primary stays false here: only the sync trigger driven off
// candidates.job_id ever sets is_primary=true (see the migration's own
// comment on why the app must never write is_primary=true directly), so a
// candidate who already has a different primary job keeps it untouched.
export async function createPipelineLink(candidateId, jobId, teamId, userId) {
  const { data, error } = await supabase
    .from('candidate_job_links')
    .insert({ candidate_id: candidateId, job_id: jobId, team_id: teamId, is_primary: false, added_by: userId, owner_id: userId })
    .select('*, candidates(id, name, role, company, want_sal, want_sal_currency, source, email, cv_path)')
    .single()
  if (error) throw error
  return data
}

// Moves a pipeline entry to a new stage, stamping stage_changed_at so the
// board's "Nd in stage" age pill resets from zero.
//
// The sync trigger (sync_primary_candidate_job_link) only keeps
// candidates -> links in sync, never the other way — so when this link IS
// the primary one (isPrimary, mirroring candidates.job_id), an app-level
// move made from the PIPELINE board has to write candidates.status back
// explicitly, or every existing reader of it (Candidates.jsx's badges/
// filters, the invoice candidate picker) would silently stop matching what
// the board shows. A move on a SECONDARY link never touches candidates.
export async function updatePipelineLinkStage(linkId, newStage, { isPrimary, candidateId } = {}) {
  const { data, error } = await supabase
    .from('candidate_job_links')
    .update({ stage: newStage, stage_changed_at: new Date().toISOString() })
    .eq('id', linkId)
    .select()
    .single()
  if (error) throw error

  if (isPrimary && candidateId) {
    const { error: candError } = await updateCandidate(candidateId, { status: newStage })
    if (candError) throw candError
  }

  return data
}

// Schedules (or reschedules) the interview on one pipeline entry.
//
// When the new time falls TODAY, this also creates a real `meetings` row
// (meeting_type: 'interview', candidate_id set) — reusing meetings.js's
// existing createMeeting rather than inventing a parallel schedule, so the
// interview shows up on Overview's "Today's schedule" automatically with
// zero new query/section needed there (meetings already has a candidate_id
// column; see meetings.js's own header comment). Rescheduling off today,
// or scheduling for a future day, intentionally does NOT create a meeting
// — Today's schedule only ever wants what's actually happening today.
export async function updatePipelineLinkInterview(linkId, { round, at, candidateId, candidateName, jobTitle, userId } = {}) {
  const { data, error } = await supabase
    .from('candidate_job_links')
    .update({ interview_round: round ?? null, interview_at: at || null })
    .eq('id', linkId)
    .select()
    .single()
  if (error) throw error

  if (at && isToday(at)) {
    const title = round ? `Interview (round ${round}): ${candidateName || 'Candidate'}` : `Interview: ${candidateName || 'Candidate'}`
    const { error: meetingError } = await createMeeting(
      {
        title: jobTitle ? `${title} — ${jobTitle}` : title,
        meeting_type: 'interview',
        meeting_date: at,
        candidate_id: candidateId || null,
      },
      userId
    )
    if (meetingError) throw meetingError
  }

  return data
}

// Bulk "how many pipelines is this candidate in, total" count for every
// candidate on the board — one query for the whole board instead of N
// calls to listOtherPipelinesForCandidate. Powers the "also in N other
// pipelines" pill (the board subtracts 1 for the current job's own link);
// the fuller, job-titled version stays in listOtherPipelinesForCandidate,
// fetched lazily only once a candidate's pill/detail panel is actually
// opened.
export async function countPipelinesPerCandidate(candidateIds) {
  if (!candidateIds?.length) return {}
  const { data, error } = await supabase.from('candidate_job_links').select('candidate_id').in('candidate_id', candidateIds)
  if (error) throw error
  const counts = {}
  for (const row of data || []) counts[row.candidate_id] = (counts[row.candidate_id] || 0) + 1
  return counts
}

// "Add candidate to pipeline" picker for the board — every candidate not
// already linked to this job, name + current role for a readable dropdown.
// jobId's own already-linked candidates are excluded client-side by the
// caller (needs the board's already-loaded pipeline, not a second round
// trip), so this stays a plain, cacheable "every candidate" read like
// listCandidatesMinimal/listCandidatesForInvoicePicker in candidates.js.
export async function listCandidatesForPipelinePicker() {
  const { data, error } = await supabase.from('candidates').select('id, name, role, company').order('name')
  if (error) throw error
  return data || []
}

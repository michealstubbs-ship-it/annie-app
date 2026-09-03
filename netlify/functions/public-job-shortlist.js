// 2026-09-06, gap-analysis batch 1 ("client-facing shortlist link"): the
// one public (no-auth) read in the pipeline data path. Deliberately does
// NOT reuse getAuthedUser — a client viewing their own shortlist has no
// Annie account at all. Safety comes from three things instead: (1) the
// token is an unguessable uuid, not a sequential id; (2) share_enabled
// must be explicitly true (see the migration's own column comment) — a
// token existing is not the same as a job being shared; (3) the service-
// role client's SELECT is a hand-picked field allowlist, never `select('*')`
// — a candidate's email/phone/notes/CV/salary-currency-of-record and every
// other internal field simply never leaves this function, the same "never
// trust the caller to only read what they're shown" reasoning as every
// other server-side allowlist in this codebase.
import { createClient } from '@supabase/supabase-js'
import { createTimeoutFetch } from './lib/scanShared.js'
import { jsonError } from './lib/httpError.js'

// Client-ready stage labels only — internal-only early stages (sourced,
// screening) collapse into "In review" rather than exposing Annie's own
// pipeline vocabulary to someone outside the agency.
const CLIENT_STAGE_LABEL = {
  sourced: 'In review',
  screening: 'In review',
  shortlisted: 'Shortlisted',
  presented: 'Presented to you',
  interviewing: 'Interviewing',
  offer: 'Offer stage',
  placed: 'Placed',
  rejected: 'Not progressing',
  withdrawn: 'Withdrawn',
}

export default async (req) => {
  if (req.method !== 'GET') {
    return jsonError(405, 'Method not allowed')
  }

  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  if (!token) return jsonError(400, 'Missing token')

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return jsonError(500, 'Not configured')

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createTimeoutFetch() },
  })

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .select('id, title, share_enabled, companies(name)')
    .eq('public_share_token', token)
    .maybeSingle()

  if (jobErr) return jsonError(500, 'Could not load this shortlist right now.')
  if (!job || !job.share_enabled) return jsonError(404, 'This link is not active. Ask your recruiter for a current link.')

  const { data: links, error: linksErr } = await supabase
    .from('candidate_job_links')
    .select('stage, interview_at, candidates(name, want_sal, want_sal_currency)')
    .eq('job_id', job.id)
    .order('stage_changed_at', { ascending: false })

  if (linksErr) return jsonError(500, 'Could not load this shortlist right now.')

  const candidates = (links || [])
    // A client shortlist link is for people actively (or once) in
    // consideration, not a recruiter's private "not progressing" pile —
    // withdrawn/rejected candidates are excluded outright rather than just
    // relabeled, matching how a recruiter would curate this by hand.
    .filter(l => l.stage !== 'rejected' && l.stage !== 'withdrawn')
    .map(l => ({
      name: l.candidates?.name || 'Candidate',
      stage: CLIENT_STAGE_LABEL[l.stage] || 'In review',
      interviewAt: l.interview_at || null,
      wantSalary: l.candidates?.want_sal ?? null,
      wantSalaryCurrency: l.candidates?.want_sal_currency ?? null,
    }))

  return new Response(JSON.stringify({
    jobTitle: job.title,
    companyName: job.companies?.name || '',
    candidates,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

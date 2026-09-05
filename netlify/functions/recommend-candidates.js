// AI-powered "recommend CRM candidates from job brief" — mid-turn addition
// this session, Michael: "if its an upgrade replace it" (confirmed: this
// REPLACES the old keyword-overlap "Suggested candidates" panel on
// Jobs.jsx, see candidateMatch.js's matchCandidatesToJob — that scorer
// stays in the codebase for Today's Actions' own BD-signal matching, it's
// just no longer what Jobs.jsx calls). Synchronous, single-job, single
// Anthropic call — same "comfortably fits a normal function's budget"
// reasoning as parse-cv.js, called on-demand (a button, not on every card
// render) since it's a real AI call with a real rate cap.
//
// The geographic gate (Saudi/Emirati candidates only for Saudi/UAE jobs)
// is applied HERE, deterministically, via candidateMatch.js's own
// isGeographicallyEligible — the exact same rule Today's Actions and the
// CV auto-fill matching already use — before any candidate ever reaches
// the prompt. The model is told this filtering has already happened and
// is explicitly instructed never to second-guess it (see
// candidateRecommend.js's system prompt); it never sees an ineligible
// candidate in the first place, so there's nothing for it to get wrong.
import { createClient } from '@supabase/supabase-js'
import { getAuthedClient } from './lib/auth.js'
import { reserveAnthropicTokens } from './lib/aiUsage.js'
import { getEntitlements, resolveResourceCaps } from './lib/entitlements.js'
import { createTimeoutFetch, fetchWithTimeout } from './lib/scanShared.js'
import { reportServerError } from './lib/reportError.js'
import { isGeographicallyEligible } from '../../src/lib/candidateMatch.js'
import {
  MAX_CANDIDATES_FOR_PROMPT,
  buildRecommendationSystemPrompt,
  buildRecommendationUserMessage,
  parseRecommendationsResponse,
} from './lib/candidateRecommend.js'

const MAX_TOKENS = 2048
// Same three statuses Candidates.jsx itself filters "active" on — a placed,
// rejected, or withdrawn candidate isn't a real recommendation candidate
// for a fresh job, whatever their old profile says.
const CLOSED_STATUSES = ['placed', 'rejected', 'withdrawn']

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!supabaseUrl || !anonKey || !serviceKey || !anthropicKey) return json({ error: 'Not configured' }, 500)

  // Token-scoped client for both reads below — job and candidates are both
  // team-scoped by RLS, so this naturally can never read another team's
  // data, exactly like parse-cv.js's own storage download.
  const { client: authedClient, user, error: authError } = await getAuthedClient(req, supabaseUrl, anonKey)
  if (authError || !user) return json({ error: 'Not authenticated' }, 401)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid request body' }, 400) }
  const jobId = typeof body?.job_id === 'string' ? body.job_id : ''
  if (!jobId) return json({ error: 'Missing job_id' }, 400)

  const { data: job, error: jobError } = await authedClient
    .from('jobs')
    .select('id, title, industry, notes, fee_value, companies(name, industry, location)')
    .eq('id', jobId)
    .maybeSingle()
  if (jobError || !job) {
    return json({ ok: false, reason: 'not_found', message: 'Couldn’t find that job — please refresh and try again.' })
  }

  const { data: rawCandidates, error: candError } = await authedClient
    .from('candidates')
    .select('id, name, role, company, industry, titles, industries, nationality, status, notes, want_sal, want_sal_currency, notice_period, updated_at')
    .order('updated_at', { ascending: false })
  if (candError) {
    return json({ ok: false, reason: 'load_failed', message: 'Couldn’t load your candidate pool just now — please try again.' })
  }

  const locationText = job.companies?.location || ''
  const eligible = (rawCandidates || [])
    .filter(c => !CLOSED_STATUSES.includes(c.status))
    .filter(c => isGeographicallyEligible(c, locationText))
    .slice(0, MAX_CANDIDATES_FOR_PROMPT)

  if (!eligible.length) {
    return json({ ok: true, recommendations: [] })
  }

  const usageClient = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })
  const entitlements = await getEntitlements(usageClient, user.id).catch(() => ({ tier: 'solo' }))
  const caps = resolveResourceCaps(entitlements.tier).anthropicTokens
  const reserved = await reserveAnthropicTokens(usageClient, user.id, MAX_TOKENS, caps)
  if (!reserved) {
    return json({ ok: false, reason: 'rate_limited', message: 'Annie has hit her daily research budget — try again later, or check your CRM manually for now.' }, 429)
  }

  const candidatesById = new Map(eligible.map(c => [c.id, c]))

  try {
    const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: MAX_TOKENS,
        system: buildRecommendationSystemPrompt(),
        messages: [{ role: 'user', content: buildRecommendationUserMessage(job, eligible) }],
      }),
    }, 45000)
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}`)
    const data = await resp.json()
    const replyText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
    const recommendations = parseRecommendationsResponse(replyText, candidatesById)
    return json({ ok: true, recommendations })
  } catch (err) {
    console.error('[recommend-candidates] Anthropic call failed:', err.message)
    await reportServerError('recommend-candidates', err, { userId: user.id, jobId, stage: 'anthropic-call' }).catch(() => {})
    return json({ ok: false, reason: 'ai_failed', message: 'Annie couldn’t generate recommendations just now — please try again in a moment.' })
  }
}

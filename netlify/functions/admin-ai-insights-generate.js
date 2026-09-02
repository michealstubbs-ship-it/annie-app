// "Annie's Read" — see admin_ai_insights migration's own header for the
// narrate-only design (every row starts 'new'; nothing here ever acts on
// its own). Runs daily, after admin-daily-metrics-snapshot.js (02:00 vs.
// 01:00) so today's snapshot row already exists to read back.
//
// Grounding data is pulled directly from the tables that already exist —
// admin_daily_metrics (this session's own snapshot job), support_escalations,
// profiles.last_active_at — via the service-role client, same as every
// other scheduled function here. The AI call gets ONLY these real numbers
// as input and is instructed never to cite a number that isn't in them;
// each insight is stored with the specific figure it's grounded in
// (cited_metric) so a card can always be checked against its source.
import { createClient } from '@supabase/supabase-js'
import { createTimeoutFetch, fetchWithRetry } from './lib/scanShared.js'
import { extractJson } from '../../src/lib/jsonExtract.js'
import { resolveResourceCaps } from './lib/entitlements.js'
import { reserveAnthropicTokens } from './lib/aiUsage.js'
import { reportServerError } from './lib/reportError.js'

const MAX_TOKENS = 2048

const SYSTEM_PROMPT = `You are Annie's internal business analyst, writing for Michael, the founder of a BD-intelligence SaaS for recruitment firms.

You will be given a JSON object of real, current metrics about the business — nothing else. Your job: write up to 5 short, specific, useful observations or recommendations grounded ONLY in the numbers given.

Hard rules:
- Never invent a number, trend, or fact that isn't present in the input. If the input doesn't have enough data to say something meaningful about a category, skip that category entirely rather than guessing.
- Every insight must name the specific metric/figure it's based on in citedMetric (e.g. "MRR: $3,592, down from $4,100 7 days ago").
- Categories: "finance" (revenue, MRR, churn risk from account activity), "product" (signal/data quality rates), "customer" (escalations), "growth" (active accounts, adoption).
- severity: "action" only for something that genuinely needs a decision soon, "watch" for something worth keeping an eye on, "info" for a plain observation.
- Write for someone who is the entire team — no corporate hedging, no "it is recommended that". Say what you see and what you'd do about it, in one or two sentences (detail field).

Return ONLY a JSON array, no other text, shaped exactly like:
[{"category": "finance", "severity": "watch", "headline": "short headline", "detail": "one or two sentences", "citedMetric": "the exact figure this is based on"}]`

async function callAnthropic(apiKey, groundingData, supabase) {
  const caps = resolveResourceCaps('starter').anthropicTokens
  if (!(await reserveAnthropicTokens(supabase, null, MAX_TOKENS, caps))) {
    throw new Error('Anthropic daily token cap reached — skipping insight generation for today')
  }

  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(groundingData) }],
    }),
  }, 30000, 1)
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}`)
  const data = await resp.json()
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

async function gatherGroundingData(supabase) {
  const { data: metricsHistory } = await supabase
    .from('admin_daily_metrics').select('day, mrr, active_accounts, contact_verified_rate, company_matched_rate')
    .order('day', { ascending: false }).limit(14)

  const { data: escalations } = await supabase.from('support_escalations').select('status, created_at')

  const { data: activity } = await supabase.from('profiles').select('last_active_at').not('last_active_at', 'is', null)

  const openEscalations = (escalations || []).filter(e => e.status === 'open').length
  const inProgressEscalations = (escalations || []).filter(e => e.status === 'in_progress').length

  const now = Date.now()
  const inactive14d = (activity || []).filter(a => now - new Date(a.last_active_at).getTime() > 14 * 24 * 60 * 60 * 1000).length

  return {
    dailyMetricsLast14Days: (metricsHistory || []).slice().reverse(), // oldest first, easier for the model to read as a trend
    openSupportEscalations: openEscalations,
    inProgressSupportEscalations: inProgressEscalations,
    accountsInactive14PlusDays: inactive14d,
    accountsWithActivityTracked: (activity || []).length,
  }
}

export default async () => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!supabaseUrl || !serviceKey || !anthropicKey) {
    return new Response('Not configured', { status: 200 })
  }

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  try {
    const groundingData = await gatherGroundingData(supabase)
    const text = await callAnthropic(anthropicKey, groundingData, supabase)
    const insights = extractJson(text)

    const rows = insights
      .filter(i => i && typeof i.headline === 'string' && typeof i.detail === 'string')
      .slice(0, 5)
      .map(i => ({
        category: ['finance', 'product', 'customer', 'growth'].includes(i.category) ? i.category : 'growth',
        severity: ['info', 'watch', 'action'].includes(i.severity) ? i.severity : 'info',
        headline: i.headline,
        detail: i.detail,
        cited_metric: typeof i.citedMetric === 'string' ? i.citedMetric : null,
      }))

    if (rows.length > 0) {
      const { error: insertError } = await supabase.from('admin_ai_insights').insert(rows)
      if (insertError) throw new Error(`admin_ai_insights insert failed: ${insertError.message}`)
    }

    return new Response('ok', { status: 200 })
  } catch (err) {
    await reportServerError('admin-ai-insights-generate', err, {})
    // Same posture as every other scheduled function here — never let a
    // background job's own failure alarm anyone but Michael; tomorrow's
    // run tries again on its own.
    return new Response('error, logged', { status: 200 })
  }
}

export const config = { schedule: '0 2 * * *' }

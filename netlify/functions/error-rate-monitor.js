// A production-readiness audit (2026-08-22) found error_logs (see
// supabase-migrations/2026-08-21-error-logs.sql) was write-only from the
// app's own perspective — every error since launch has been landing there,
// but nothing ever reads it except an admin who happens to open Insights.
// A spike (a bad deploy, a broken integration, a Stripe webhook failing on
// every event) could run for days before anyone noticed. This is the
// minimum viable fix: an hourly count against error_logs, alerted through
// the same Slack webhook alertIfConfigured already uses for the "zero
// signals" scan alert — no new account, no new secret, reusing what's
// already there. It is deliberately not a replacement for a real APM/error
// tracker (Sentry or similar) — that's flagged separately as a decision for
// Michael, since it needs a third-party account this environment can't
// create on his behalf.
import { createClient } from '@supabase/supabase-js'
import { alertIfConfigured } from './lib/scanShared.js'

// No hard science behind this number — it's a first, conservative
// threshold meant to catch "something is clearly broken" (a bad deploy, an
// integration down) without paging on ordinary background noise (a user
// mistyping a form field, a transient network blip). Tune once real
// baseline volume is known.
const ERROR_SPIKE_THRESHOLD = 20

export default async () => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return new Response('Not configured', { status: 200 })

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count, error } = await supabase
      .from('error_logs')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', oneHourAgo)

    if (error) {
      console.error('[error-rate-monitor] failed to read error_logs:', error.message)
      return new Response('error', { status: 500 })
    }

    if ((count || 0) >= ERROR_SPIKE_THRESHOLD) {
      await alertIfConfigured(
        `⚠️ Annie error rate spike: ${count} entries in error_logs over the last hour (threshold ${ERROR_SPIKE_THRESHOLD}). Check the Insights page or query error_logs directly.`
      )
    }

    return new Response(JSON.stringify({ count: count || 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('[error-rate-monitor] unexpected failure:', err.message)
    return new Response('error', { status: 500 })
  }
}

// A plain count query over an indexed timestamp column (error_logs_created_at_idx)
// comfortably finishes well inside Netlify's 30-second cap for scheduled
// functions without background:true — no need for the same background
// treatment intelligence-scan.js needed, since this does no LLM/third-party
// API calls.
export const config = { schedule: '0 * * * *' }

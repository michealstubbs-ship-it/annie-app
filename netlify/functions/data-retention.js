// A scale-readiness audit (2026-08-22) found nothing ever deletes or
// archives a row from intelligence_signals, chat_messages,
// support_messages, or error_logs. At a conservative 2,000 customers
// generating ~5 new signals per 12-hour scan, that's ~20,000 new rows a
// day — permanently — with no product value once a signal's outcome is
// already captured. This runs weekly and calls the four batched cleanup
// RPCs in supabase-migrations/2026-08-22-data-retention.sql, each of which
// deletes in chunks server-side rather than one unbounded DELETE, so even a
// large backlog can't hold a lock for long. background: true because a
// large first-ever cleanup (or one that ran late) could plausibly exceed
// Netlify's 30-second cap for a non-background scheduled function — the
// exact bug intelligence-scan.js had before this same fix was applied there.
import { createClient } from '@supabase/supabase-js'
import { alertIfConfigured, createTimeoutFetch } from './lib/scanShared.js'

const RETENTION_MS = 18 * 30 * 24 * 60 * 60 * 1000 // ~18 months

// chat_rate_limit rows are per-minute rate-limit buckets (see
// chat_reserve_call in the 2026-08-22 migration), not historical records —
// nothing reads one after its own request finishes with it, so it gets a
// much shorter retention than the four tables above rather than sharing
// their 18-month cutoff. 2 days comfortably outlives any in-flight request.
const RATE_LIMIT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000

const TABLES = [
  { label: 'intelligence_signals', rpc: 'retention_cleanup_intelligence_signals', retentionMs: RETENTION_MS },
  { label: 'chat_messages', rpc: 'retention_cleanup_chat_messages', retentionMs: RETENTION_MS },
  { label: 'support_messages', rpc: 'retention_cleanup_support_messages', retentionMs: RETENTION_MS },
  { label: 'error_logs', rpc: 'retention_cleanup_error_logs', retentionMs: RETENTION_MS },
  // Task 3 (2026-08-24): closes the gap where chat_rate_limit was the only
  // unbounded-growth table this job didn't cover.
  { label: 'chat_rate_limit', rpc: 'retention_cleanup_chat_rate_limit', retentionMs: RATE_LIMIT_RETENTION_MS },
]

export default async () => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return new Response('Not configured', { status: 200 })

  // 2026-08-24 Task 3: createTimeoutFetch applied — see its own header in
  // scanShared.js.
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createTimeoutFetch() },
  })

  const results = {}
  let hadError = false

  // Snapshot "now" once and derive each table's cutoff from it, cached per
  // distinct retentionMs, rather than calling Date.now() fresh inside the
  // loop — the four 18-month tables share RETENTION_MS and should get an
  // identical cutoff, not one that drifts by a few ms depending on how long
  // each RPC call took to await.
  const now = Date.now()
  const cutoffCache = new Map()
  const cutoffFor = (retentionMs) => {
    if (!cutoffCache.has(retentionMs)) {
      cutoffCache.set(retentionMs, new Date(now - retentionMs).toISOString())
    }
    return cutoffCache.get(retentionMs)
  }

  for (const { label, rpc, retentionMs } of TABLES) {
    const cutoff = cutoffFor(retentionMs)
    try {
      const { data, error } = await supabase.rpc(rpc, { p_cutoff: cutoff })
      if (error) {
        hadError = true
        results[label] = `error: ${error.message}`
        console.error(`[data-retention] ${label} cleanup failed:`, error.message)
      } else {
        results[label] = data
      }
    } catch (err) {
      hadError = true
      results[label] = `error: ${err.message}`
      console.error(`[data-retention] ${label} cleanup threw:`, err.message)
    }
  }

  console.log('[data-retention] run complete:', JSON.stringify(results))

  if (hadError) {
    await alertIfConfigured(`⚠️ Annie data-retention run had at least one failure: ${JSON.stringify(results)}`)
  }

  return new Response(JSON.stringify({ results }), {
    status: hadError ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const config = { schedule: '0 3 * * 0', background: true }

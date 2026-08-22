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
import { alertIfConfigured } from './lib/scanShared.js'

const RETENTION_MS = 18 * 30 * 24 * 60 * 60 * 1000 // ~18 months

const TABLES = [
  { label: 'intelligence_signals', rpc: 'retention_cleanup_intelligence_signals' },
  { label: 'chat_messages', rpc: 'retention_cleanup_chat_messages' },
  { label: 'support_messages', rpc: 'retention_cleanup_support_messages' },
  { label: 'error_logs', rpc: 'retention_cleanup_error_logs' },
]

export default async () => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return new Response('Not configured', { status: 200 })

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString()
  const results = {}
  let hadError = false

  for (const { label, rpc } of TABLES) {
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

  return new Response(JSON.stringify({ cutoff, results }), {
    status: hadError ? 500 : 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

export const config = { schedule: '0 3 * * 0', background: true }

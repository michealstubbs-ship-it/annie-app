// The first sweep, and every catch-up sweep after it.
//
// Sent is read before inbox, deliberately. Measured on a real recruiter mailbox
// (2026-09-05): 50 sent messages yielded 11 genuine work contacts; 50 received
// yielded zero, because an inbox is mostly LinkedIn digests, DMARC reports and
// bank statements. Writing to someone is the signal. Receiving is noise until
// there is already a thread.
//
// Runs as a background function because a full backfill is minutes of paging,
// not seconds, and it must survive being slower than an HTTP timeout.
import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { unipileConfig, listEmails } from './lib/unipile.js'
import { ingestBatch } from './lib/emailIngest.js'
import { reserveAnthropicTokens, reconcileAnthropicTokens, anthropicBilledTokens } from './lib/aiUsage.js'

const PAGE = 50
const MAX_PAGES_PER_ROLE = 12          // ~600 messages each way, then stop
const WALL_CLOCK_MS = 11 * 60 * 1000   // leave headroom under the 15-minute cap

export default async (req) => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return new Response('Not configured', { status: 503 })

  const cfg = unipileConfig()
  if (!cfg.configured) return new Response('Unipile not configured', { status: 503 })

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const started = Date.now()

  let body = {}
  try { body = await req.json() } catch { body = {} }

  // Either one named account (just connected) or every account due a catch-up.
  let accounts = []
  if (body.accountId) {
    const { data } = await admin.from('email_accounts')
      .select('id, user_id, email_address, unipile_account_id, status, backfill_done')
      .eq('id', body.accountId).eq('status', 'connected').maybeSingle()
    if (data) accounts = [data]
  } else {
    const { data } = await admin.from('email_accounts')
      .select('id, user_id, email_address, unipile_account_id, status, backfill_done')
      .eq('status', 'connected')
      .limit(50)
    accounts = data || []
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY || null
  const report = []

  for (const account of accounts) {
    if (Date.now() - started > WALL_CLOCK_MS) break

    const totals = {
      account: account.email_address, read: 0, created: 0,
      matchedEmail: 0, matchedName: 0, heldPersonal: 0, heldRole: 0,
      skipped: 0, noted: 0, enriched: 0, autoReplies: 0, companies: new Set(),
    }

    try {
      for (const role of ['sent', 'inbox']) {
        let cursor = null
        for (let page = 0; page < MAX_PAGES_PER_ROLE; page++) {
          if (Date.now() - started > WALL_CLOCK_MS) break

          const listed = await listEmails(cfg, {
            accountId: account.unipile_account_id,
            role,
            limit: PAGE,
            cursor,
          })
          if (!listed.ok) {
            await admin.from('email_accounts')
              .update({ last_error: listed.error, status: listed.status === 401 ? 'disconnected' : 'connected' })
              .eq('id', account.id)
            break
          }

          const items = listed.data?.items || []
          if (!items.length) break

          const estimate = items.length * 500
          const reserved = anthropicKey
            ? await reserveAnthropicTokens(admin, account.user_id, estimate, null)
            : { ok: false }

          let actual = 0
          const summary = await ingestBatch(admin, {
            userId: account.user_id,
            account,
            messages: items,
            anthropicKey: reserved.ok ? anthropicKey : null,
            onUsage: (usage) => { actual += anthropicBilledTokens(usage) },
          })
          if (reserved.ok) await reconcileAnthropicTokens(admin, account.user_id, estimate, actual)

          for (const k of ['read', 'created', 'matchedEmail', 'matchedName', 'heldPersonal', 'heldRole', 'skipped', 'noted', 'enriched', 'autoReplies']) {
            totals[k] += summary[k] || 0
          }
          for (const c of summary.companies) totals.companies.add(c)

          cursor = listed.data?.cursor || null
          if (!cursor) break
        }
      }

      await admin.from('email_accounts').update({
        backfill_done: true,
        last_synced_at: new Date().toISOString(),
        last_error: null,
      }).eq('id', account.id)
    } catch (err) {
      await reportServerError('email-sync-background', err, { userId: account.user_id })
      await admin.from('email_accounts')
        .update({ last_error: String(err?.message || 'sync_failed') })
        .eq('id', account.id)
    }

    report.push({ ...totals, companies: [...totals.companies] })
  }

  return new Response(JSON.stringify({ accounts: report.length, report }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

// Netlify: a custom path replaces the default /.netlify/functions/ alias,
// so this is the ONLY URL this function answers on.
export const config = { path: '/api/email-sync-background' }

// Unipile calls this: once when a mailbox finishes connecting, and then for
// every new message.
//
// Two rules shape this file.
//
// 1. It answers 200 fast and does the work behind it. A webhook that blocks on
//    Anthropic will time out, get retried, and be re-delivered — and although
//    ingest is idempotent, a queue of timing-out retries is still a mess.
// 2. It trusts nothing in the payload except the account id, which it looks up
//    against our own table to find the user. A webhook body cannot name the
//    tenant it wants to write to.
import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { unipileConfig, getAccount, listEmails } from './lib/unipile.js'
import { ingestBatch } from './lib/emailIngest.js'
import { reserveAnthropicTokens, reconcileAnthropicTokens, anthropicBilledTokens } from './lib/aiUsage.js'

const ok = (body = { received: true }) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const secret = process.env.UNIPILE_WEBHOOK_SECRET
  if (!supabaseUrl || !serviceKey) return ok({ received: true, ignored: 'not_configured' })

  // A shared secret in the header, when one is configured. Unipile does not
  // sign its payloads, so this is the available check; without it, anyone who
  // learns the URL could post to it.
  if (secret) {
    const given = req.headers.get('x-annie-webhook-secret') || ''
    if (given !== secret) return new Response('Forbidden', { status: 403 })
  }

  let payload = null
  try { payload = await req.json() } catch { return ok({ received: true, ignored: 'unparseable' }) }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const cfg = unipileConfig()

  try {
    const accountId = payload?.account_id || payload?.data?.account_id || null
    if (!accountId) return ok({ received: true, ignored: 'no_account' })

    // --- a mailbox finished connecting -----------------------------------
    // `name` is what we passed as the user id when the hosted link was made.
    const status = String(payload?.status || payload?.type || '').toLowerCase()
    if (status.includes('creation_success') || status === 'account.connected') {
      const userId = payload?.name || null
      if (!userId) return ok({ received: true, ignored: 'no_user' })

      const detail = await getAccount(cfg, accountId)
      const address =
        detail.data?.connection_params?.mail?.username ||
        detail.data?.name || 'unknown'

      await admin.from('email_accounts')
        .delete()
        .eq('user_id', userId)
        .eq('email_address', 'pending')

      await admin.from('email_accounts').upsert({
        user_id: userId,
        unipile_account_id: accountId,
        email_address: String(address).toLowerCase(),
        provider: detail.data?.type || null,
        status: 'connected',
        connected_at: new Date().toISOString(),
      }, { onConflict: 'unipile_account_id' })

      return ok({ received: true, connected: true })
    }

    // --- new mail ---------------------------------------------------------
    const { data: account } = await admin
      .from('email_accounts')
      .select('id, user_id, email_address, status')
      .eq('unipile_account_id', accountId)
      .maybeSingle()

    if (!account) return ok({ received: true, ignored: 'unknown_account' })
    if (account.status !== 'connected') return ok({ received: true, ignored: 'not_connected' })

    // The payload may carry the message. If it does not, ask for the newest few
    // rather than trusting anything in the body.
    let messages = []
    if (payload?.email || payload?.message) {
      messages = [payload.email || payload.message]
    } else {
      const listed = await listEmails(cfg, { accountId, role: 'inbox', limit: 10 })
      messages = listed.data?.items || []
    }
    if (!messages.length) return ok({ received: true, ingested: 0 })

    const anthropicKey = process.env.ANTHROPIC_API_KEY || null
    // Reserved up front, reconciled after: the same accounting every other
    // Anthropic call in this codebase uses, so notes cannot spend silently.
    const estimate = messages.length * 500
    const reserved = anthropicKey
      ? await reserveAnthropicTokens(admin, account.user_id, estimate, null)
      : { ok: false }

    let actual = 0
    const summary = await ingestBatch(admin, {
      userId: account.user_id,
      account,
      messages,
      anthropicKey: reserved.ok ? anthropicKey : null,
      onUsage: (usage) => { actual += anthropicBilledTokens(usage) },
    })

    if (reserved.ok) await reconcileAnthropicTokens(admin, account.user_id, estimate, actual)
    await admin.from('email_accounts')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', account.id)

    return ok({ received: true, ...summary })
  } catch (err) {
    await reportServerError('email-webhook', err, {})
    // Always 200: a 500 here just makes Unipile retry a message we may already
    // have written, and the ledger's unique constraint has already handled it.
    return ok({ received: true, error: true })
  }
}

// Netlify: a custom path replaces the default /.netlify/functions/ alias,
// so this is the ONLY URL this function answers on.
export const config = { path: '/api/email-webhook' }

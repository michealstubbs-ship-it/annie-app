// Turning email on, and telling the UI where it stands.
//
// GET  -> the current state of this user's mailbox connection
// POST -> a one-time Unipile hosted link to send them to
// DELETE -> disconnect
//
// The recruiter's Google or Microsoft password never touches Annie. They
// authenticate against Unipile's verified app, which is the entire reason for
// using hosted auth: asking Google for restricted mailbox scopes directly
// means passing their security assessment, redone annually.
import { createClient } from '@supabase/supabase-js'
import { getAuthedUser } from './lib/auth.js'
import { getEntitlements } from './lib/entitlements.js'
import { jsonError } from './lib/httpError.js'
import { reportServerError } from './lib/reportError.js'
import { unipileConfig, createHostedAuthLink } from './lib/unipile.js'

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
})

export default async (req) => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = process.env.APP_URL || 'https://app.meetannie.ai'

  if (!supabaseUrl || !anonKey || !serviceKey) return jsonError(503, 'Not configured')

  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError || !user) return jsonError(401, 'Not authenticated')

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  try {
    const { data: account } = await admin
      .from('email_accounts')
      // sweep_stats carries the finished 18-month sweep's tally, including the
      // free-mail count — the number of people who genuinely correspond with
      // this recruiter from a personal address and were deliberately NOT filed
      // as contacts. It is surfaced rather than buried because the decision
      // about what to do with those people is Michael's, and it should be made
      // against a real figure rather than an argument about whether they exist.
      .select('id, email_address, provider, status, connected_at, last_synced_at, backfill_done, sweep_stats, sweep_completed_at')
      .eq('user_id', user.id)
      .maybeSingle()

    if (req.method === 'GET') {
      const ent = await getEntitlements(admin, user.id)
      return json(200, {
        available: Boolean(ent?.limits?.emailSync),
        tier: ent?.tier || null,
        account: account || null,
        configured: unipileConfig().configured,
      })
    }

    if (req.method === 'POST') {
      // Where to land after the consent screen. Same-origin PATHS only —
      // taking a full URL from the request body would turn this endpoint into
      // an open redirect that any page could point at its own domain.
      let returnTo = '/settings?email=connected'
      try {
        const body = await req.json()
        const asked = String(body?.returnTo || '')
        if (/^\/[A-Za-z0-9/_\-?=&.]*$/.test(asked) && !asked.startsWith('//')) returnTo = asked
      } catch { /* no body is fine — the default covers Settings */ }

      const ent = await getEntitlements(admin, user.id)
      if (!ent?.limits?.emailSync) {
        return json(402, { error: 'Email sync is on Growth and Team', upgrade: true })
      }

      const cfg = unipileConfig()
      if (!cfg.configured) return jsonError(503, 'Email connection is not configured yet')

      // Ten minutes is plenty for a consent screen and short enough that a
      // link left in a browser history is useless later.
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
      const result = await createHostedAuthLink(cfg, {
        userId: user.id,
        successUrl: `${appUrl}${returnTo}`,
        failureUrl: `${appUrl}${returnTo.includes('?') ? returnTo.split('?')[0] : returnTo}?email=failed`,
        notifyUrl: `${appUrl}/api/email-webhook`,
        expiresAt,
      })

      if (!result.ok || !result.data?.url) {
        await reportServerError('email-connect', new Error(result.error || 'no_link'), { userId: user.id })
        return jsonError(502, 'Could not start the email connection')
      }

      // 'connecting' is recorded now so a user who abandons the consent screen
      // shows as pending rather than as never having tried.
      await admin.from('email_accounts').upsert({
        user_id: user.id,
        unipile_account_id: `pending:${user.id}`,
        email_address: 'pending',
        status: 'connecting',
      }, { onConflict: 'user_id,email_address' })

      return json(200, { url: result.data.url, expiresAt })
    }

    if (req.method === 'DELETE') {
      if (!account) return json(200, { disconnected: true })
      // The ledger goes with it. Notes already written stay on the contacts —
      // they are the recruiter's record now, not ours to remove.
      await admin.from('email_accounts').delete().eq('id', account.id).eq('user_id', user.id)
      return json(200, { disconnected: true })
    }

    return jsonError(405, 'Method not allowed')
  } catch (err) {
    await reportServerError('email-connect', err, { userId: user.id })
    return jsonError(500, 'Something went wrong')
  }
}

// Netlify: a custom path replaces the default /.netlify/functions/ alias,
// so this is the ONLY URL this function answers on.
export const config = { path: '/api/email-connect' }

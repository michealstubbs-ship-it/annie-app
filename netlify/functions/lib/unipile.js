// The Unipile client, kept deliberately small.
//
// Note what is NOT in this file: there is no update/PATCH method, and there
// never should be. Unipile changes a message's read state only through
// PUT /api/v1/emails/{id} with `unread` in the body. Annie does not have that
// call, so a customer's mail can never be marked read by us — which is the one
// failure that would actually cost them a mandate.
//
// LinkedIn is equally deliberate: the hosted auth link below pins `providers`
// to mail only, so LinkedIn cannot be connected by accident. Annie never holds
// a LinkedIn session.

import { fetchWithRetry } from './scanShared.js'

export const MAIL_PROVIDERS = ['GOOGLE', 'OUTLOOK', 'MAIL']

export function unipileConfig(env = process.env) {
  const base = String(env.UNIPILE_DSN || '').replace(/\/+$/, '')
  const key = env.UNIPILE_API_KEY || ''
  return { base, key, configured: Boolean(base && key) }
}

function headers(key) {
  return { 'X-API-KEY': key, 'Content-Type': 'application/json', Accept: 'application/json' }
}

async function call(cfg, path, { method = 'GET', body = null, timeoutMs = 15000 } = {}) {
  if (!cfg.configured) return { ok: false, status: 503, data: null, error: 'unipile_not_configured' }
  const url = `${cfg.base}${path}`
  try {
    const resp = await fetchWithRetry(url, {
      method,
      headers: headers(cfg.key),
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, timeoutMs, 1)

    let data = null
    try { data = await resp.json() } catch { data = null }
    if (!resp.ok) return { ok: false, status: resp.status, data, error: data?.type || `http_${resp.status}` }
    return { ok: true, status: resp.status, data, error: null }
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err?.message || 'network_error' }
  }
}

/**
 * A one-time hosted link the recruiter is sent to. Their credentials go to
 * Google or Microsoft and to Unipile — never to Annie, never through this
 * codebase. That is the whole reason for using hosted auth rather than asking
 * Google for restricted-scope access ourselves.
 */
export async function createHostedAuthLink(cfg, { userId, successUrl, failureUrl, notifyUrl, expiresAt }) {
  return call(cfg, '/api/v1/hosted/accounts/link', {
    method: 'POST',
    body: {
      type: 'create',
      providers: MAIL_PROVIDERS,
      api_url: cfg.base,
      expiresOn: expiresAt,
      name: userId,
      success_redirect_url: successUrl,
      failure_redirect_url: failureUrl,
      notify_url: notifyUrl,
    },
  })
}

export async function getAccount(cfg, accountId) {
  return call(cfg, `/api/v1/accounts/${encodeURIComponent(accountId)}`)
}

/**
 * List mail. `role` is 'sent' or 'inbox'.
 *
 * meta_only is false because the note writer needs the body — but the body is
 * used and dropped, never written to the database. include_headers is on so
 * an out-of-office can be spotted from Auto-Submitted rather than guessed from
 * the subject line.
 */
export async function listEmails(cfg, { accountId, role = 'sent', limit = 50, cursor = null, after = null }) {
  const params = new URLSearchParams({
    account_id: accountId,
    limit: String(Math.min(Math.max(limit, 1), 250)),
    meta_only: 'false',
    include_headers: 'true',
    role,
  })
  if (cursor) params.set('cursor', cursor)
  if (after) params.set('after', after)
  return call(cfg, `/api/v1/emails?${params.toString()}`, { timeoutMs: 25000 })
}

export async function getEmail(cfg, { accountId, emailId }) {
  const params = new URLSearchParams({ account_id: accountId, include_headers: 'true' })
  return call(cfg, `/api/v1/emails/${encodeURIComponent(emailId)}?${params.toString()}`)
}

/**
 * Send through the recruiter's own mailbox, so it threads normally and lands
 * in their sent items. Not a no-reply address, not Annie's domain.
 */
export async function sendEmail(cfg, { accountId, to, subject, body, replyTo = null }) {
  return call(cfg, '/api/v1/emails', {
    method: 'POST',
    timeoutMs: 25000,
    body: {
      account_id: accountId,
      to: (Array.isArray(to) ? to : [to]).filter(Boolean).map(identifier => ({ identifier })),
      subject,
      body,
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
  })
}

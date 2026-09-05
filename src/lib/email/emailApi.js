// Every call to the email-sync endpoints, in one place.
//
// All four functions declare a custom Netlify config.path, which REPLACES the
// default /.netlify/functions/<name> alias — so /api/<name> is the only URL
// that resolves. Calling the old path returns the SPA's HTML and fails as a
// confusing JSON parse error. That bug has been fixed three times in this
// codebase already; keeping the URLs here means there is one place to get it
// wrong instead of five.
import { supabase } from '../supabase'
import { withTimeout } from '../withTimeout'

const SESSION_TIMEOUT_MS = 8000

async function authHeaders() {
  // getSession() can hang rather than reject — same unwrapped-promise hazard
  // handled in callChat.js and resolveSignalContact.js.
  const { data: { session } } = await withTimeout(
    supabase.auth.getSession(), SESSION_TIMEOUT_MS, 'email-session'
  )
  const token = session?.access_token
  if (!token) throw new Error('Your session has expired. Please log in again.')
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

async function readJson(resp) {
  try { return await resp.json() } catch { return null }
}

/** What the UI needs to decide between "connect", "connected" and "upgrade". */
export async function getEmailStatus() {
  try {
    const resp = await fetch('/api/email-connect', { headers: await authHeaders() })
    const data = await readJson(resp)
    if (!resp.ok) return { available: false, error: data?.error || 'Could not check your email connection.' }
    return { ...data, error: null }
  } catch (err) {
    return { available: false, error: err.message || 'Could not check your email connection.' }
  }
}

/**
 * Returns the one-time Unipile URL to send the recruiter to. Their password
 * goes to Google or Microsoft, never to Annie.
 */
export async function startEmailConnect({ returnTo = '/settings?email=connected' } = {}) {
  try {
    const resp = await fetch('/api/email-connect', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ returnTo }),
    })
    const data = await readJson(resp)
    if (resp.status === 402) return { url: null, upgrade: true, error: data?.error || 'Email is on Growth and Team.' }
    if (!resp.ok || !data?.url) return { url: null, error: data?.error || 'Could not start the connection.' }
    return { url: data.url, error: null }
  } catch (err) {
    return { url: null, error: err.message || 'Could not start the connection.' }
  }
}

export async function disconnectEmail() {
  try {
    const resp = await fetch('/api/email-connect', { method: 'DELETE', headers: await authHeaders() })
    if (!resp.ok) return { ok: false, error: 'Could not disconnect.' }
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err.message || 'Could not disconnect.' }
  }
}

/**
 * Send from the recruiter's own mailbox. Returns { sent, contactId, note }.
 *
 * A failure here is always reported honestly rather than swallowed: a user who
 * is unsure whether their message went will send it twice.
 */
export async function sendFromAnnie({ to, subject, body }) {
  try {
    const resp = await fetch('/api/email-send', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ to, subject, body }),
    })
    const data = await readJson(resp)
    if (resp.status === 402) return { sent: false, upgrade: true, error: data?.error || 'Sending is on Growth and Team.' }
    if (resp.status === 409) return { sent: false, connect: true, error: 'Connect your email first.' }
    if (!resp.ok) return { sent: false, error: data?.error || 'The message could not be sent.' }
    return { sent: true, contactId: data?.contactId || null, note: Boolean(data?.note), error: null }
  } catch (err) {
    return { sent: false, error: err.message || 'The message could not be sent.' }
  }
}

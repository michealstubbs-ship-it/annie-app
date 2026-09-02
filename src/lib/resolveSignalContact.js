// Called from IntelligenceFeed.jsx's "Add to Today's BD Actions" button when
// the signal being added doesn't already have a verified contact or a
// contact-candidates panel — see resolve-signal-contact.js for why this
// exists (a manual add used to silently do nothing for a contact-less
// signal, which read as a broken button rather than "Annie hasn't found
// anyone yet"). Returns { found, contact?, contactCandidates?, error? } —
// found:false is a normal, honest outcome, not a thrown error.
import { supabase } from './supabase'
import { withTimeout } from './withTimeout'

export async function resolveSignalContact(signalId) {
  try {
    // 2026-08-29 audit fix: same unwrapped getSession() hang fixed
    // elsewhere this session — falls into the existing { found: false,
    // error } shape below exactly like any other failure here, rather
    // than leaving "Add to Today's BD Actions" stuck with no response.
    const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000, 'resolve-signal-contact-session')
    const token = session?.access_token
    if (!token) return { found: false, error: 'Your session has expired. Please log in again.' }
    // 2026-09-02 audit fix: resolve-signal-contact.js declares a custom
    // Netlify Functions path (config.path = '/api/resolve-signal-contact'),
    // which per Netlify's own routing rules means the default
    // '/.netlify/functions/resolve-signal-contact' alias no longer resolves
    // at all once a custom path is set. This was calling the default path,
    // so "Add to Today's BD Actions" on a contact-less signal silently hit
    // Netlify's SPA fallback (HTML, not JSON) every time and degraded to
    // the honest-looking "found: false" outcome instead of ever finding a
    // real contact. Same class of bug already fixed in callChat.js/
    // Billing.jsx/LinkedInImport.jsx/adminDashboard.js.
    const res = await fetch('/api/resolve-signal-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ signalId }),
    })
    return await res.json()
  } catch (err) {
    return { found: false, error: err.message || 'Something went wrong.' }
  }
}

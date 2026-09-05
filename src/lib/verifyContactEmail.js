// Client call for the "Verify with Apollo · 1 credit" button on the card.
//
// Same shape as resolveSignalContact: never throws, and found:false is a
// normal, honest outcome rather than an error. The custom Netlify path is
// deliberate and must be called directly — declaring config.path removes the
// default /.netlify/functions/ alias entirely, a bug this codebase has hit
// four separate times.
import { supabase } from './supabase'
import { withTimeout } from './withTimeout'

export async function verifyContactEmail(contactId) {
  try {
    const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000, 'verify-contact-session')
    const token = session?.access_token
    if (!token) return { found: false, error: 'Your session has expired. Please log in again.' }
    const res = await fetch('/api/verify-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ contactId }),
    })
    return await res.json()
  } catch (err) {
    return { found: false, error: err.message || 'Something went wrong.' }
  }
}

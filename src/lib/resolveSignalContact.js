// Called from IntelligenceFeed.jsx's "Add to Today's BD Actions" button when
// the signal being added doesn't already have a verified contact or a
// contact-candidates panel — see resolve-signal-contact.js for why this
// exists (a manual add used to silently do nothing for a contact-less
// signal, which read as a broken button rather than "Annie hasn't found
// anyone yet"). Returns { found, contact?, contactCandidates?, error? } —
// found:false is a normal, honest outcome, not a thrown error.
import { supabase } from './supabase'

export async function resolveSignalContact(signalId) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) return { found: false, error: 'Your session has expired. Please log in again.' }
    const res = await fetch('/.netlify/functions/resolve-signal-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ signalId }),
    })
    return await res.json()
  } catch (err) {
    return { found: false, error: err.message || 'Something went wrong.' }
  }
}

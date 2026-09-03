// Frontend client for recommend-candidates.js — same session-token-then-
// fetch shape callChat.js/cvParseClient.js already established, kept as its
// own small module since Jobs.jsx is the only caller.
import { supabase } from './supabase'
import { withTimeout } from './withTimeout'

const SESSION_TIMEOUT_MS = 8000

// Called on demand (a button click), not on every card render — this is a
// real AI call with a real rate cap, same "ask, don't auto-fire" precedent
// as parseCvViaAnnie. Never throws for a "couldn't generate this" outcome
// (see recommend-candidates.js's own ok:false reasons) — only for something
// genuinely unexpected (no session, a network failure, a malformed reply).
export async function recommendCandidatesForJob(jobId) {
  const { data: { session } } = await withTimeout(supabase.auth.getSession(), SESSION_TIMEOUT_MS, 'recommend-candidates-session')
  const token = session?.access_token
  if (!token) throw new Error('You need to be signed in for that.')

  const resp = await fetch('/.netlify/functions/recommend-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ job_id: jobId }),
  })
  return resp.json().catch(() => ({ ok: false, reason: 'bad_response', message: 'Annie couldn’t generate recommendations just now — please try again in a moment.' }))
}

// Frontend client for the two CV-parsing endpoints (parse-cv.js for the
// single-CV auto-fill, parse-cvs-bulk-background.js + cv-bulk-status.js for
// the "dump multiple CVs" bulk path) — same session-token-then-fetch shape
// callChat.js already established, kept here as its own small module since
// Candidates.jsx is the only caller and these aren't chat calls.
import { supabase } from './supabase'
import { withTimeout } from './withTimeout'

const SESSION_TIMEOUT_MS = 8000

async function getAccessToken(label) {
  const { data: { session } } = await withTimeout(supabase.auth.getSession(), SESSION_TIMEOUT_MS, label)
  const token = session?.access_token
  if (!token) throw new Error('You need to be signed in for that.')
  return token
}

// Single CV — called right after the file is uploaded to storage, before
// the candidate row itself is saved. Never throws for a "couldn't read
// this" outcome (that's a normal, expected result — see parse-cv.js's own
// `ok:false` reasons); only throws for something genuinely unexpected
// (no session, a network failure, a malformed response).
export async function parseCvViaAnnie(path) {
  const token = await getAccessToken('parse-cv-session')
  const resp = await fetch('/.netlify/functions/parse-cv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ path }),
  })
  return resp.json().catch(() => ({ ok: false, reason: 'bad_response', message: 'Annie couldn’t read this CV automatically just now — please fill in the candidate’s details manually.' }))
}

// Bulk — fires the background worker and returns immediately (true/false on
// whether the trigger itself succeeded); the actual per-file results are
// read back via fetchCvBulkStatus's polling.
export async function triggerBulkCvImport(paths) {
  const token = await getAccessToken('cv-bulk-trigger-session')
  const resp = await fetch('/.netlify/functions/parse-cvs-bulk-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ paths }),
  })
  return resp.ok
}

export async function fetchCvBulkStatus() {
  try {
    const token = await getAccessToken('cv-bulk-status-session')
    const resp = await fetch('/.netlify/functions/cv-bulk-status', { headers: { Authorization: `Bearer ${token}` } })
    return await resp.json().catch(() => ({ status: 'unknown' }))
  } catch {
    return { status: 'unknown' }
  }
}

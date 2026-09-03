// Cheap, synchronous read of the status blob parse-cvs-bulk-background.js
// writes — same "is my background job still running, and what actually
// happened" shape as scan-status.js, just for the bulk CV import instead of
// a research scan.
import { getStore } from '@netlify/blobs'
import { getAuthedUser } from './lib/auth.js'
import { reportServerError } from './lib/reportError.js'

const STATUS_STORE = 'annie-cv-bulk-status'
// Generous flat ceiling rather than a tier-specific one (scan-status.js's
// own reason for a per-tier ceiling doesn't apply here — CV parsing cost is
// the same regardless of subscription tier) — comfortably above the
// MAX_FILES_PER_BATCH * per-file worst case in parse-cvs-bulk-background.js,
// so a genuinely still-running large batch is never mistaken for a stuck one.
const TIMEOUT_MS = 12 * 60 * 1000

export default async (req) => {
  const unknown = () => new Response(JSON.stringify({ status: 'unknown' }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const { user, error } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (error) return unknown()

  try {
    const store = getStore({ name: STATUS_STORE, consistency: 'strong' })
    const record = await store.get(user.id, { type: 'json' })

    if (record?.status === 'running' && record?.startedAt && Date.now() - record.startedAt > TIMEOUT_MS) {
      return new Response(JSON.stringify({ ...record, status: 'done', reason: 'timed_out' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify(record || { status: 'unknown' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('[cv-bulk-status] failed to read status blob:', err.message)
    await reportServerError('cv-bulk-status', err).catch(() => {})
    return unknown()
  }
}

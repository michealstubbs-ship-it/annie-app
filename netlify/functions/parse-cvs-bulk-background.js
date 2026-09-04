// "We need an option where you can dump multiple CVs and Annie can add it
// for you" — Michael, mid-turn addition to item 3. Frontend has already
// uploaded every file to the existing candidate-cvs bucket before firing
// this; this function reads each one, has Annie extract + structure it
// (same lib/cvParse.js used by the single-CV auto-fill in parse-cv.js), and
// creates a real candidate row per file that came back with at least a
// name — same "background worker + status blob + poll" shape already
// proven for research scans (see scan-now-background.js/scan-status.js),
// since a batch of CVs, unlike one, can plausibly run past a normal
// synchronous function's budget.
import { createClient } from '@supabase/supabase-js'
import { getStore } from '@netlify/blobs'
import { getAuthedUser } from './lib/auth.js'
import { reserveAnthropicTokens } from './lib/aiUsage.js'
import { getEntitlements, resolveResourceCaps } from './lib/entitlements.js'
import { createTimeoutFetch, fetchWithTimeout } from './lib/scanShared.js'
import { reportServerError } from './lib/reportError.js'
import {
  extractCvText,
  looksLikeUsableCvText,
  buildCvExtractionSystemPrompt,
  extractJsonObject,
  sanitizeParsedCv,
  parsedCvIsEmpty,
} from './lib/cvParse.js'

const MAX_TOKENS = 1024
const MAX_FILES_PER_BATCH = 25 // a generous real-world "dump" — bounds worst-case wall clock, well inside the 15-minute background budget even at a few seconds each

const STATUS_STORE = 'annie-cv-bulk-status'

async function writeStatus(userId, data) {
  try {
    const store = getStore({ name: STATUS_STORE, consistency: 'strong' })
    await store.setJSON(userId, data)
  } catch (err) {
    console.error('[parse-cvs-bulk] failed to write status blob:', err.message)
  }
}

async function parseOneFile(supabase, anthropicKey, caps, userId, path) {
  const { data: fileData, error: downloadError } = await supabase.storage.from('candidate-cvs').download(path)
  if (downloadError || !fileData) return { path, outcome: 'failed', reason: 'Couldn’t download this file.' }

  let text
  try {
    const bytes = new Uint8Array(await fileData.arrayBuffer())
    text = await extractCvText(bytes, path)
  } catch (err) {
    return { path, outcome: 'failed', reason: err.message }
  }

  if (!looksLikeUsableCvText(text)) {
    return { path, outcome: 'failed', reason: 'No readable text found (likely a scanned image, not real text).' }
  }

  const reserved = await reserveAnthropicTokens(supabase, userId, MAX_TOKENS, caps)
  if (!reserved) return { path, outcome: 'failed', reason: 'Annie’s daily research budget is used up for today.' }

  let parsed
  try {
    const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: MAX_TOKENS,
        system: buildCvExtractionSystemPrompt(),
        messages: [{ role: 'user', content: text }],
      }),
    }, 45000)
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}`)
    const data = await resp.json()
    const replyText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
    parsed = sanitizeParsedCv(extractJsonObject(replyText))
  } catch (err) {
    await reportServerError('parse-cvs-bulk-background', err, { userId, stage: 'anthropic-call', path }).catch(() => {})
    return { path, outcome: 'failed', reason: 'Annie couldn’t read this one automatically.' }
  }

  if (parsedCvIsEmpty(parsed) || !parsed.name) {
    return { path, outcome: 'failed', reason: 'Couldn’t find a name or real candidate details in this file.' }
  }

  const row = {
    user_id: userId,
    name: parsed.name,
    role: parsed.current_role,
    company: parsed.current_company,
    location: parsed.location,
    industry: parsed.industries[0] || '',
    nationality: parsed.nationality,
    email: parsed.email,
    phone: parsed.phone,
    titles: parsed.titles,
    industries: parsed.industries,
    cv_path: path,
    status: 'shortlisted',
    source: 'Bulk CV import',
  }

  const { data: created, error: insertError } = await supabase.from('candidates').insert(row).select('id, name').single()
  if (insertError) return { path, outcome: 'failed', reason: 'Read the CV but couldn’t save it — please add this one manually.' }

  return { path, outcome: 'created', candidateId: created.id, name: created.name }
}

export default async (req) => {
  if (req.method !== 'POST') return

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!supabaseUrl || !anonKey || !serviceKey || !anthropicKey) { console.error('[parse-cvs-bulk] not configured'); return }

  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (!user) { console.error('[parse-cvs-bulk] auth failed:', authError); return }

  let body
  try { body = await req.json() } catch { body = {} }
  const paths = Array.isArray(body?.paths) ? body.paths.filter(p => typeof p === 'string' && p.startsWith(`${user.id}/`)).slice(0, MAX_FILES_PER_BATCH) : []
  if (!paths.length) { await writeStatus(user.id, { status: 'done', startedAt: Date.now(), total: 0, completed: 0, results: [] }); return }

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })
  const entitlements = await getEntitlements(supabase, user.id).catch(() => ({ tier: 'starter' }))
  const caps = resolveResourceCaps(entitlements.tier).anthropicTokens

  const startedAt = Date.now()
  const results = []
  await writeStatus(user.id, { status: 'running', startedAt, total: paths.length, completed: 0, results: [] })

  for (const path of paths) {
    const result = await parseOneFile(supabase, anthropicKey, caps, user.id, path)
    results.push(result)
    await writeStatus(user.id, { status: 'running', startedAt, total: paths.length, completed: results.length, results })
  }

  await writeStatus(user.id, { status: 'done', startedAt, total: paths.length, completed: results.length, results })
}

// Synchronous, single-file CV auto-fill — Michael: "can we make it that you
// add the CV which moves from the bottom to the top, where if you add the
// profile, annie picks up all the details for name, role, current company,
// location, industry, email, phone? Then letting the customer know that if
// they add the CV that info will be automatically generated". Called by
// Candidates.jsx right after a CV is selected and uploaded to storage,
// BEFORE the candidate row itself is saved — the recruiter reviews/edits
// whatever comes back before anything is persisted, same "AI proposes, a
// human confirms" precedent as everywhere else in this codebase.
//
// A single CV's worth of work (one small download, one non-streaming
// Anthropic call) comfortably fits inside a normal synchronous function's
// budget, so this deliberately isn't a background function — the bulk "dump
// multiple CVs" path (parse-cvs-bulk-background.js) is, since a batch of
// them plausibly doesn't.
import { createClient } from '@supabase/supabase-js'
import { getAuthedClient } from './lib/auth.js'
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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!supabaseUrl || !anonKey || !serviceKey || !anthropicKey) return json({ error: 'Not configured' }, 500)

  // The token-scoped client — used for the storage download so the
  // existing candidate-cvs bucket RLS (per-uploading-user folder) is the
  // one thing deciding whether this caller can read this file, exactly as
  // if they'd called createSignedUrl themselves. No service-role bypass
  // here even though one exists below for the usage RPCs.
  const { client: authedClient, user, error: authError } = await getAuthedClient(req, supabaseUrl, anonKey)
  if (authError || !user) return json({ error: 'Not authenticated' }, 401)

  let body
  try { body = await req.json() } catch { return json({ error: 'Invalid request body' }, 400) }
  const path = typeof body?.path === 'string' ? body.path : ''
  if (!path) return json({ error: 'Missing path' }, 400)
  // Defense in depth: the bucket's own RLS already scopes reads to
  // `(storage.foldername(name))[1] = auth.uid()`, so a mismatched path
  // would fail at download() below regardless — this just gives a clearer,
  // earlier reason than a generic storage error would.
  if (!path.startsWith(`${user.id}/`)) return json({ error: 'Not your file' }, 403)

  const usageClient = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  const { data: fileData, error: downloadError } = await authedClient.storage.from('candidate-cvs').download(path)
  if (downloadError || !fileData) {
    return json({ ok: false, reason: 'download_failed', message: 'Couldn’t read that CV file — please try uploading it again.' })
  }

  let text
  try {
    const bytes = new Uint8Array(await fileData.arrayBuffer())
    text = await extractCvText(bytes, path)
  } catch (err) {
    // A genuinely unsupported format (legacy .doc, or something not a
    // CV at all) — cvParse.js's own error messages are already
    // user-facing, so pass them straight through rather than a generic
    // failure.
    return json({ ok: false, reason: 'unsupported', message: err.message })
  }

  if (!looksLikeUsableCvText(text)) {
    return json({ ok: false, reason: 'unreadable', message: 'Annie couldn’t find readable text in this file (a scanned image rather than real text, most likely) — please fill in the candidate’s details manually.' })
  }

  const entitlements = await getEntitlements(usageClient, user.id).catch(() => ({ tier: 'solo' }))
  const caps = resolveResourceCaps(entitlements.tier).anthropicTokens
  const reserved = await reserveAnthropicTokens(usageClient, user.id, MAX_TOKENS, caps)
  if (!reserved) {
    return json({ ok: false, reason: 'rate_limited', message: 'Annie has hit her daily research budget — please fill in the candidate’s details manually for now.' }, 429)
  }

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
    const raw = extractJsonObject(replyText)
    const parsed = sanitizeParsedCv(raw)

    if (parsedCvIsEmpty(parsed)) {
      return json({ ok: false, reason: 'empty', message: 'Annie read this file but couldn’t find real candidate details in it — please fill the form in manually.' })
    }

    return json({ ok: true, parsed })
  } catch (err) {
    console.error('[parse-cv] Anthropic call failed:', err.message)
    await reportServerError('parse-cv', err, { userId: user.id, stage: 'anthropic-call' }).catch(() => {})
    return json({ ok: false, reason: 'ai_failed', message: 'Annie couldn’t read this CV automatically just now — please fill in the candidate’s details manually.' })
  }
}

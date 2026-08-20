// Runs one immediate research scan for a single, just-onboarded customer, so
// they land on their dashboard with real signals already waiting instead of
// staring at an empty page until the next 4-hourly intelligence-scan cron
// tick (which loops every customer and can be up to 4 hours away). Fired
// once, without being awaited, right after onboarding finishes — the
// customer moves straight on to the LinkedIn import step while this keeps
// running server-side, and is very often done before they get through it.
//
// Deliberately self-contained rather than sharing code with
// intelligence-scan.js: this is a background function (different runtime
// contract, 15-minute wall clock budget, no response body), and keeping it
// separate means nothing here can ever risk the all-customers cron job that
// already runs reliably in production. Netlify requires the "-background"
// filename suffix to run it this way.
import { createClient } from '@supabase/supabase-js'
import { getStore } from '@netlify/blobs'

const SIGNAL_TYPES = ['funding', 'leadership_change', 'hiring_activity', 'expansion', 'team_building', 'public_commentary', 'job_posting_unclaimed', 'm_and_a', 'regulatory']

// A brand new customer landing on an empty dashboard for the full 6-minute
// "researching" window even when the scan genuinely finished in 11 seconds
// (found nothing worth reporting, or hit an error) reads as broken, not
// slow. This status blob is how the frontend tells "still running" apart
// from "finished, here's what actually happened" — see scan-status.js
// (reads it) and Overview.jsx (polls scan-status.js instead of just
// guessing off a timer).
async function setStatus(userId, data) {
  try {
    const store = getStore({ name: 'annie-scan-status', consistency: 'strong' })
    await store.setJSON(userId, data)
  } catch (err) {
    // Status tracking is a nicety for the loading UI, never let it take the
    // actual scan down.
    console.error('[scan-now] failed to write status blob for', userId, err.message)
  }
}

function normalizeKey(company, headline) {
  return `${(company || '').trim().toLowerCase()}::${(headline || '').trim().toLowerCase().slice(0, 80)}`
}

function buildScanPrompt(onboarding, recentCompanies) {
  const functions = onboarding?.functions?.length ? onboarding.functions.join(', ') : null
  return `You are Annie, an expert BD researcher for a recruitment firm.
Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Functions this recruiter places candidates into: ${functions || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `The recruiter's real writing style, follow this closely when writing the candidateAngle text:\n${onboarding.writing_style}\n` : ''}
Use web search to find genuine, timely BD-relevant signals in these sectors and markets right now: funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity.
${functions ? `This recruiter only places into the functions listed above (e.g. a Finance recruiter doesn't want a Marketing hiring signal, even at a company in their target sector). Every signal you surface must point to a genuine opening or need in one of those functions specifically, whether that's the role itself, or the function most likely to be affected by the news (e.g. a funding round signals Finance/Strategy hiring, a safety incident signals HSE hiring). Reject anything where you can't draw that connection.` : ''}

This is a brand new account with no history yet, so there is nothing to avoid repeating: ${recentCompanies.join(', ') || 'None yet'}.

Every signal must have a real, citable source you actually found via search. Do not invent anything. Return up to 8 signals, fewer if you can't find genuinely good ones, never pad with weak filler.

For each signal, determine:
- company: the company name
- signalType: one of ${SIGNAL_TYPES.join(', ')}
- headline: max 10 words
- whyItMatters: 1-2 sentences on why this is a genuine BD opportunity right now
- sourceUrl: the real URL you found this from
- sourceLabel: short label, e.g. techcrunch.com
- eventDate: your best estimate of when this actually happened or was posted, as YYYY-MM-DD, based on the source
- whoToApproach: the specific person or role to approach and why, bypass generic HR/Head of Talent unless they're genuinely the right door, and keep them within this recruiter's target functions above
- titleKeywords: 2-4 likely job title strings for the right decision-maker, used afterwards to look up a real verified contact
- candidateAngle: a specific, credible candidate profile to lead with (background, seniority, source companies), matching the target functions above, not a generic pitch, written in the recruiter's communication tone above. Leave blank if this signal isn't the kind that calls for a candidate pitch (e.g. a pure leadership-change or funding note with no obvious opening).

Return a JSON array, each object with exactly these fields: company, signalType, headline, whyItMatters, sourceUrl, sourceLabel, eventDate, whoToApproach, titleKeywords, candidateAngle.
Only return the JSON array, nothing else. If nothing genuinely good was found, return an empty array.`
}

async function callAnthropic(apiKey, systemPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Scan for signals now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }),
  })
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}`)
  const data = await resp.json()
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

function extractJson(text) {
  const match = text.match(/\[[\s\S]*\]/)
  try { return JSON.parse(match ? match[0] : '[]') } catch { return [] }
}

// Contact info is only ever trusted from Apollo. An AI-mentioned name is reasoning,
// not a fact, it stays in who_to_approach, never in the verified contact fields.
async function verifyContact(apolloKey, company, titleKeywords) {
  if (!apolloKey || !company) return null
  try {
    const resp = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify({ q_organization_name: company, person_titles: titleKeywords?.length ? titleKeywords : undefined, page: 1, per_page: 1 }),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const p = (data.people || [])[0]
    if (!p) return null
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
    if (!name) return null
    return { name, title: p.title || '', linkedin_url: p.linkedin_url || '' }
  } catch {
    return null
  }
}

async function enrichCompany(apolloKey, company) {
  if (!apolloKey || !company) return null
  try {
    const resp = await fetch('https://api.apollo.io/v1/mixed_companies/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify({ q_organization_name: company, page: 1, per_page: 1 }),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const org = (data.organizations && data.organizations[0]) || (data.accounts && data.accounts[0])
    if (!org) return null
    return {
      domain: org.primary_domain || org.domain || null,
      industry: org.industry || null,
      city: org.city || null,
      state: org.state || null,
      country: org.country || null,
      logo_url: org.logo_url || null,
    }
  } catch {
    return null
  }
}

export default async (req) => {
  if (req.method !== 'POST') return

  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) { console.error('[scan-now] missing auth token'); return }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const apolloKey = process.env.APOLLO_API_KEY
  if (!supabaseUrl || !anonKey || !serviceKey || !anthropicKey) { console.error('[scan-now] not configured'); return }

  // Identify the caller from their OWN token first. Never trust a user id
  // passed in the request body, that would let anyone trigger a scan (and
  // spend Anthropic/Apollo credit) against a different customer's account.
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await authClient.auth.getUser(token)
  if (userErr || !userData?.user) { console.error('[scan-now] invalid session'); return }
  const userId = userData.user.id

  // The scan's writes use the service role, same as the scheduled cron —
  // these are Annie's own findings, not user-authored data, and RLS on
  // intelligence_signals rightly doesn't grant customers insert access.
  const supabase = createClient(supabaseUrl, serviceKey)

  const startedAt = Date.now()
  await setStatus(userId, { status: 'running', startedAt })

  try {
    // Guard against duplicate triggers (a retried request, a second tab)
    // kicking off an expensive scan twice in quick succession.
    const { data: recentBatch } = await supabase
      .from('intelligence_signals')
      .select('id')
      .eq('user_id', userId)
      .gte('found_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
      .limit(1)
    if (recentBatch?.length) {
      console.log('[scan-now] recent signals already exist for', userId, 'skipping')
      await setStatus(userId, { status: 'done', reason: 'recent_signals_exist', signalsFound: recentBatch.length, startedAt, finishedAt: Date.now() })
      return
    }

    const { data: ob } = await supabase
      .from('onboarding')
      .select('user_id, sectors, functions, locations, tone, firm_name, writing_style')
      .eq('user_id', userId)
      .single()
    if (!ob) {
      console.error('[scan-now] no onboarding row yet for', userId)
      await setStatus(userId, { status: 'done', reason: 'no_onboarding', signalsFound: 0, startedAt, finishedAt: Date.now() })
      return
    }

    const text = await callAnthropic(anthropicKey, buildScanPrompt(ob, []))
    const found = extractJson(text)
    if (!found.length) {
      console.log('[scan-now] nothing found for', userId)
      await setStatus(userId, { status: 'done', reason: 'no_results', signalsFound: 0, startedAt, finishedAt: Date.now() })
      return
    }

    const rows = []
    for (const s of found) {
      if (!s.company || !s.headline) continue

      const [contact, companyInfo] = await Promise.all([
        verifyContact(apolloKey, s.company, s.titleKeywords),
        enrichCompany(apolloKey, s.company),
      ])

      rows.push({
        user_id: userId,
        company_name: s.company,
        company_domain: companyInfo?.domain || null,
        company_industry: companyInfo?.industry || null,
        company_city: companyInfo?.city || null,
        company_state: companyInfo?.state || null,
        company_country: companyInfo?.country || null,
        company_logo_url: companyInfo?.logo_url || null,
        signal_type: SIGNAL_TYPES.includes(s.signalType) ? s.signalType : 'public_commentary',
        headline: s.headline,
        why_it_matters: s.whyItMatters || '',
        source_url: s.sourceUrl || '',
        source_label: s.sourceLabel || '',
        event_at: s.eventDate && !isNaN(Date.parse(s.eventDate)) ? new Date(s.eventDate).toISOString() : null,
        who_to_approach: s.whoToApproach || '',
        candidate_angle: s.candidateAngle || '',
        contact_name: contact?.name || null,
        contact_title: contact?.title || null,
        contact_linkedin_url: contact?.linkedin_url || null,
        contact_verified: !!contact,
        dedup_key: normalizeKey(s.company, s.headline),
        status: 'new',
      })
    }

    if (rows.length) {
      await supabase.from('intelligence_signals').upsert(rows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true })
      console.log(`[scan-now] wrote ${rows.length} signals for`, userId)
    }
    await setStatus(userId, { status: 'done', reason: rows.length ? 'ok' : 'no_results', signalsFound: rows.length, startedAt, finishedAt: Date.now() })
  } catch (err) {
    console.error('[scan-now] failed for', userId, err.message)
    await setStatus(userId, { status: 'done', reason: 'error', errorMessage: err.message, signalsFound: 0, startedAt, finishedAt: Date.now() })
  }
}

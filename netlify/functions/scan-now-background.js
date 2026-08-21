// Runs one immediate research scan for a single, just-onboarded customer, so
// they land on their dashboard with real signals already waiting instead of
// staring at an empty page until the next 4-hourly intelligence-scan cron
// tick (which loops every customer and can be up to 4 hours away). Fired
// once, without being awaited, right after onboarding finishes — the
// customer moves straight on to the LinkedIn import step while this keeps
// running server-side, and is very often done before they get through it.
//
// This is THE first-impression moment for a brand new customer, so unlike
// the 4-hourly all-customer cron this one is deliberately over-resourced:
// instead of one AI call trying to cover every sector and function a
// customer picked with a shared search budget, it runs several calls in
// parallel (one per sector group), each with its own generous search
// budget, then merges the results. If that still comes up thin, it runs one
// more, deliberately broader pass before giving up. It only runs once per
// signup, never on a schedule, so the extra Anthropic/Apollo spend here is
// small in absolute terms.
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

// How many sector groups to research in parallel, and the minimum number of
// unique signals we want back before we're willing to show a brand new
// customer their first dashboard without trying harder first.
const MAX_SECTOR_GROUPS = 4
const MIN_SIGNAL_TARGET = 3
const MAX_TOTAL_SIGNALS = 12

// How far back Apollo's own job-posting data counts as "actively hiring right
// now" for the discovery pass below. Kept in sync with the AI prompt's own
// 5-day window so both sources agree on what "recent" means.
const APOLLO_DISCOVERY_LOOKBACK_DAYS = 5

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

// Splits a customer's selected sectors into up to maxGroups buckets so each
// AI call researches a narrower slice with its own full search budget,
// instead of one call rationing searches across everything the customer
// picked. A customer with 1-4 sectors gets one call per sector; more than
// that and sectors are distributed round-robin across the group cap so
// total cost stays bounded regardless of how many a customer selects.
function chunkSectors(sectors, maxGroups) {
  if (!sectors?.length) return [null]
  const groupCount = Math.min(maxGroups, sectors.length)
  const buckets = Array.from({ length: groupCount }, () => [])
  sectors.forEach((s, i) => buckets[i % groupCount].push(s))
  return buckets
}

// Merges signal lists from multiple AI calls (per-sector-group, plus
// optionally a broaden pass), deduplicating by company+headline so the same
// real event found via two different searches doesn't get written twice.
function mergeSignals(lists) {
  const seen = new Map()
  for (const list of lists) {
    for (const s of list || []) {
      if (!s?.company || !s?.headline) continue
      const key = normalizeKey(s.company, s.headline)
      if (!seen.has(key)) seen.set(key, s)
    }
  }
  return [...seen.values()]
}

// Turns a compound label like "Strategy & Corporate Development" or
// "Policy & Government Affairs" into loose keyword fragments ("strategy",
// "corporate development") without needing to import the full sector/function
// taxonomy into this function (this file stays deliberately self-contained,
// see the file header). Good enough for Apollo's fuzzy keyword/title
// matching, not meant to be exact.
function splitToKeywords(label) {
  return (label || '')
    .split(/&|\//)
    .map(s => s.trim())
    .filter(Boolean)
}

function isoDateDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// Apollo tracks real job postings and funding events directly, it isn't
// guessing from news the way web search has to. Querying it BEFORE the AI
// call gives Annie a list of companies Apollo has independently confirmed
// are actively hiring in this sector/function/location combo right now, so
// the AI's own search has real leads to investigate and write up rather than
// relying purely on whatever general news it happens to surface. This is a
// discovery input, not a replacement for the AI's narrative writeup (why it
// matters, who to approach, etc still needs real reasoning over real
// sources), so it deliberately asks for a short list, not a final answer.
async function discoverHotCompanies(apolloKey, { sectors, functions, locations }) {
  if (!apolloKey) return []
  try {
    const body = { per_page: 8, organization_num_jobs_range: { min: 1 } }
    body.organization_job_posted_at_range = { min: isoDateDaysAgo(APOLLO_DISCOVERY_LOOKBACK_DAYS) }

    const sectorKeywords = (sectors || []).flatMap(splitToKeywords)
    if (sectorKeywords.length) body.q_organization_keyword_tags = sectorKeywords.slice(0, 20)

    const titleKeywords = (functions || []).flatMap(splitToKeywords)
    if (titleKeywords.length) body.q_organization_job_titles = titleKeywords.slice(0, 20)

    if (locations?.length) body.organization_locations = locations.slice(0, 10)

    const resp = await fetch('https://api.apollo.io/v1/mixed_companies/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return []
    const data = await resp.json()
    const orgs = [...(data.organizations || []), ...(data.accounts || [])]
    return orgs
      .map(o => ({ name: o.name, industry: o.industry || null, employees: o.estimated_num_employees || null }))
      .filter(o => o.name)
      .slice(0, 8)
  } catch (err) {
    console.error('[scan-now] apollo discovery failed:', err.message)
    return []
  }
}

function buildScanPrompt(onboarding, recentCompanies, opts = {}) {
  const functions = onboarding?.functions?.length ? onboarding.functions.join(', ') : null
  const sectorsForPrompt = opts.sectorsOverride?.length ? opts.sectorsOverride : onboarding?.sectors
  return `You are Annie, an expert BD researcher for a recruitment firm.
Sectors: ${sectorsForPrompt?.join(', ') || 'General recruitment'}.
Functions this recruiter places candidates into: ${functions || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `The recruiter's real writing style, follow this closely when writing the candidateAngle text:\n${onboarding.writing_style}\n` : ''}
Use web search to find genuine, timely BD-relevant signals in these sectors and markets from the last 5 days: funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity. A signal from any point in the last 5 days counts as timely, it does not need to have happened today or this specific hour.
Also actively look for layoffs, redundancies, or restructuring news. This cuts both ways and both are worth surfacing: a company doing layoffs sometimes still needs to quietly backfill specific roles (frame the signal around that need), and separately, a real layoff or redundancy event puts a pool of genuinely available, often strong candidates on the market at once, worth surfacing on its own even with no obvious open role at that company, in which case candidateAngle should describe that available talent pool specifically. Classify these as signalType "regulatory" and make the headline clearly say layoffs or redundancy so it's not confused with an ordinary hiring signal.
Search thoroughly before concluding there is nothing. Run multiple distinct searches, try each sector and each function by name, try combinations of sector + "funding" / "hiring" / "appoints" / "expansion" / "acquires", try the specified markets by name, and try recent news generally in these sectors before narrowing. Do not stop after one or two searches, a real, live-news industry genuinely has more happening in it than that.
${functions ? `This recruiter places into the functions listed above. When you find a strong, genuine signal, connect it to whichever of those functions it most plausibly affects, even if the reasoning takes a small logical step (e.g. a funding round signals Finance/Strategy hiring, a safety incident signals HSE hiring, a new market launch signals Government/Regulatory Affairs hiring, an M&A deal signals Corporate Development or Legal hiring). Make your best reasonable case for the closest function rather than discarding a real, well-sourced signal purely because the function match isn't perfect. Only leave a strong signal out entirely if you genuinely cannot connect it to any of the functions listed, even loosely.` : ''}
${opts.broaden ? `\nIMPORTANT: an earlier, narrower search pass came up thin. For this pass, widen your net further: look back up to the last 4 weeks (not just the last 5 days), consider the parent industry category as well as the exact sub-sector, and count a signal even if the function connection takes a slightly longer logical chain, as long as it is still genuinely defensible. The bar is "real and sourced", not "perfect fit". Still never invent anything, and still cite a real source for every signal.\n` : ''}
${opts.apolloLeads?.length ? `\nApollo's own hiring database has independently confirmed these companies are actively posting jobs matching this recruiter's functions, within the last ${APOLLO_DISCOVERY_LOOKBACK_DAYS} days, in these sectors and markets: ${opts.apolloLeads.map(l => `${l.name}${l.industry ? ` (${l.industry})` : ''}`).join(', ')}. Treat these as strong, confirmed leads, actively search for the real story behind each one (why they're hiring, any funding or expansion tied to it, the right person to approach, a real citable source) before deciding whether to include it. You are not limited to only these companies, keep searching broadly too, but do not ignore this list, Apollo already did real work to surface it.\n` : ''}

This is a brand new account with no history yet, so there is nothing to avoid repeating: ${recentCompanies.join(', ') || 'None yet'}.

Every signal must have a real, citable source you actually found via search. Do not invent anything. Return up to 8 signals, fewer if you can't find genuinely good ones after searching thoroughly, never pad with weak filler.

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

async function callAnthropic(apiKey, systemPrompt, { maxUses = 8, maxTokens = 4096 } = {}) {
  // A brand new customer's first scan is the moment that makes or breaks
  // their first impression of the whole product, so this one uses the
  // stronger model even though it costs more per call. It only runs once
  // per signup, not on a recurring schedule, so the extra cost here is
  // small in absolute terms. The 4-hourly all-customer cron
  // (intelligence-scan.js) stays on the cheaper model to control cost at
  // scale.
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Scan for signals now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
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

    // Pass 1: research each sector group in parallel, each with its own
    // full search budget, instead of one call rationing searches across
    // everything the customer picked. Each group first asks Apollo which
    // companies it can independently confirm are hiring right now in that
    // slice, then hands that list to the AI as a head start (1 Apollo credit
    // per group, up to MAX_SECTOR_GROUPS credits total for this whole pass).
    const groups = chunkSectors(ob.sectors, MAX_SECTOR_GROUPS)
    const groupResults = await Promise.all(groups.map(async (sectorGroup) => {
      const apolloLeads = await discoverHotCompanies(apolloKey, {
        sectors: sectorGroup?.length ? sectorGroup : ob.sectors,
        functions: ob.functions,
        locations: ob.locations,
      })
      try {
        const text = await callAnthropic(anthropicKey, buildScanPrompt(ob, [], { sectorsOverride: sectorGroup, apolloLeads }))
        return { sectorGroup, found: extractJson(text), rawText: text }
      } catch (err) {
        console.error('[scan-now] group call failed for', userId, sectorGroup?.join('/') || 'general', err.message)
        return { sectorGroup, found: [], rawText: '', error: err.message }
      }
    }))

    groupResults.forEach(g => {
      if (!g.found.length) {
        const preview = (g.rawText || '').trim().slice(0, 300)
        console.log('[scan-now] group came back empty for', userId, '| sectors:', g.sectorGroup?.join('/') || 'general', '| preview:', preview || g.error || '(empty response)')
      }
    })

    let merged = mergeSignals(groupResults.map(g => g.found))
    let broadened = false
    let broadenPreview = null

    // Safety net: a brand new customer should not land on an empty first
    // dashboard just because the narrower per-sector passes came up thin.
    // Run one more deliberately broader pass before accepting that.
    if (merged.length < MIN_SIGNAL_TARGET) {
      try {
        const broadenText = await callAnthropic(anthropicKey, buildScanPrompt(ob, [], { broaden: true }), { maxUses: 10 })
        const broadenFound = extractJson(broadenText)
        broadened = true
        if (!broadenFound.length) broadenPreview = (broadenText || '').trim().slice(0, 400)
        merged = mergeSignals([merged, broadenFound])
      } catch (err) {
        console.error('[scan-now] broaden pass failed for', userId, err.message)
        broadened = true
        broadenPreview = `broaden pass error: ${err.message}`
      }
    }

    const capped = merged.slice(0, MAX_TOTAL_SIGNALS)

    if (!capped.length) {
      console.log('[scan-now] nothing found for', userId, '| sectors scanned:', groups.map(g => g?.join('/') || 'general').join(' | '), '| broadened:', broadened, '| broaden preview:', broadenPreview || '(n/a)')
      await setStatus(userId, {
        status: 'done',
        reason: 'no_results',
        signalsFound: 0,
        startedAt,
        finishedAt: Date.now(),
        sectorsScanned: ob.sectors || [],
        groupsRun: groups.length,
        broadened,
        rawPreview: broadenPreview || null,
      })
      return
    }

    // Dedupe against this customer's existing signals BEFORE spending Apollo
    // credits, not after. For a brand new account this set is normally
    // empty, but it's a cheap, free guard against a retried request or a
    // second concurrent trigger burning enrichment credits on a signal
    // that would just get discarded as a duplicate on write anyway.
    const { data: existingRows } = await supabase
      .from('intelligence_signals')
      .select('dedup_key')
      .eq('user_id', userId)
    const existingKeys = new Set((existingRows || []).map(r => r.dedup_key))

    const rows = []
    for (const s of capped) {
      if (!s.company || !s.headline) continue
      if (existingKeys.has(normalizeKey(s.company, s.headline))) continue

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
        title_keywords: Array.isArray(s.titleKeywords) ? s.titleKeywords.slice(0, 6) : [],
        dedup_key: normalizeKey(s.company, s.headline),
        status: 'new',
      })
    }

    if (rows.length) {
      await supabase.from('intelligence_signals').upsert(rows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true })
      console.log(`[scan-now] wrote ${rows.length} signals for`, userId, '| groups:', groups.length, '| broadened:', broadened)
    }
    await setStatus(userId, {
      status: 'done',
      reason: rows.length ? 'ok' : 'no_results',
      signalsFound: rows.length,
      startedAt,
      finishedAt: Date.now(),
      sectorsScanned: ob.sectors || [],
      groupsRun: groups.length,
      broadened,
    })
  } catch (err) {
    console.error('[scan-now] failed for', userId, err.message)
    await setStatus(userId, { status: 'done', reason: 'error', errorMessage: err.message, signalsFound: 0, startedAt, finishedAt: Date.now() })
  }
}

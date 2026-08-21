// Runs one immediate research scan for a single, just-onboarded customer, so
// they land on their dashboard with real signals already waiting instead of
// staring at an empty page until the next cron tick (which loops every
// customer and can be hours away). Fired once, without being awaited, right
// after onboarding finishes — the customer moves straight on to the
// LinkedIn import step while this keeps running server-side, and is very
// often done before they get through it.
//
// This is THE first-impression moment for a brand new customer, so unlike
// the recurring cron this one is deliberately over-resourced: instead of
// one AI call trying to cover every sector and function a customer picked
// with a shared search budget, it runs several calls in parallel (one per
// sector group), each with its own generous search budget, then merges the
// results. If that still comes up thin, it runs one more, deliberately
// broader pass before giving up. It only runs once per signup, never on a
// schedule, so the extra Anthropic/Apollo spend here is small in absolute
// terms.
//
// Shares pure logic (dedup keys, JSON extraction, Apollo/Adzuna/Companies
// House calls) with intelligence-scan.js via lib/scanShared.js, so a fix
// made once applies to both — but keeps its own orchestration (parallel
// sector groups, the broaden pass, model/budget choices) separate on
// purpose, since this is a background function (different runtime
// contract, 15-minute wall clock budget, no response body) and changes made
// for the one-off onboarding scan should never risk the cron that already
// runs reliably in production. Netlify requires the "-background" filename
// suffix to run it this way.
import { createClient } from '@supabase/supabase-js'
import { getStore } from '@netlify/blobs'
import { reportServerError } from './lib/reportError.js'
import {
  SIGNAL_TYPES, SIGNAL_LOOKBACK_DAYS, normalizeKey, splitToKeywords, extractJson, toEventIso,
  resolveSignalType, discoverHotCompanies, discoverAdzunaJobs, verifyContact, enrichCompany,
  verifyLeadershipChange, fetchWithRetry, verifySourceUrl,
} from './lib/scanShared.js'

// How many sector groups to research in parallel, and the minimum number of
// unique signals we want back before we're willing to show a brand new
// customer their first dashboard without trying harder first.
const MAX_SECTOR_GROUPS = 4
const MIN_SIGNAL_TARGET = 3
const MAX_TOTAL_SIGNALS = 12

// A brand new customer landing on an empty dashboard for the full loading
// window even when the scan genuinely finished in 11 seconds (found nothing
// worth reporting, or hit an error) reads as broken, not slow. This status
// blob is how the frontend tells "still running" apart from "finished,
// here's what actually happened" — see scan-status.js (reads it) and
// Overview.jsx (polls scan-status.js instead of just guessing off a timer).
async function setStatus(userId, data) {
  try {
    const store = getStore({ name: 'annie-scan-status', consistency: 'strong' })
    await store.setJSON(userId, data)
  } catch (err) {
    console.error('[scan-now] failed to write status blob for', userId, err.message)
  }
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

function buildScanPrompt(onboarding, recentCompanies, opts = {}) {
  const functions = onboarding?.functions?.length ? onboarding.functions.join(', ') : null
  const sectorsForPrompt = opts.sectorsOverride?.length ? opts.sectorsOverride : onboarding?.sectors
  return `You are Annie, an expert BD researcher for a recruitment firm.
Sectors: ${sectorsForPrompt?.join(', ') || 'General recruitment'}.
Functions this recruiter places candidates into: ${functions || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `The recruiter's real writing style, follow this closely when writing the candidateAngle text:\n${onboarding.writing_style}\n` : ''}
Use web search to find genuine, timely BD-relevant signals in these sectors and markets from the last ${SIGNAL_LOOKBACK_DAYS} days: funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity. A signal from any point in the last ${SIGNAL_LOOKBACK_DAYS} days counts as timely, it does not need to have happened today or this specific hour.
Also actively look for layoffs, redundancies, or restructuring news. This cuts both ways and both are worth surfacing: a company doing layoffs sometimes still needs to quietly backfill specific roles (frame the signal around that need), and separately, a real layoff or redundancy event puts a pool of genuinely available, often strong candidates on the market at once, worth surfacing on its own even with no obvious open role at that company, in which case candidateAngle should describe that available talent pool specifically. Classify these as signalType "regulatory" and make the headline clearly say layoffs or redundancy so it's not confused with an ordinary hiring signal.
Search thoroughly before concluding there is nothing. Run multiple distinct searches, try each sector and each function by name, try combinations of sector + "funding" / "hiring" / "appoints" / "expansion" / "acquires", try the specified markets by name, and try recent news generally in these sectors before narrowing. Do not stop after one or two searches, a real, live-news industry genuinely has more happening in it than that.
${functions ? `This recruiter places into the functions listed above. When you find a strong, genuine signal, connect it to whichever of those functions it most plausibly affects, even if the reasoning takes a small logical step (e.g. a funding round signals Finance/Strategy hiring, a safety incident signals HSE hiring, a new market launch signals Government/Regulatory Affairs hiring, an M&A deal signals Corporate Development or Legal hiring). Make your best reasonable case for the closest function rather than discarding a real, well-sourced signal purely because the function match isn't perfect. Only leave a strong signal out entirely if you genuinely cannot connect it to any of the functions listed, even loosely.` : ''}
${opts.broaden ? `\nIMPORTANT: an earlier, narrower search pass came up thin. For this pass, widen your net further: look back up to the last 4 weeks (not just the last ${SIGNAL_LOOKBACK_DAYS} days), consider the parent industry category as well as the exact sub-sector, and count a signal even if the function connection takes a slightly longer logical chain, as long as it is still genuinely defensible. The bar is "real and sourced", not "perfect fit". Still never invent anything, and still cite a real source for every signal.\n` : ''}
${opts.apolloLeads?.length ? `\nApollo's own hiring database has independently confirmed these companies are actively posting jobs matching this recruiter's functions, within the last ${SIGNAL_LOOKBACK_DAYS} days, in these sectors and markets: ${opts.apolloLeads.map(l => `${l.name}${l.industry ? ` (${l.industry})` : ''}`).join(', ')}. Treat these as strong, confirmed leads, actively search for the real story behind each one (why they're hiring, any funding or expansion tied to it, the right person to approach, a real citable source) before deciding whether to include it. You are not limited to only these companies, keep searching broadly too, but do not ignore this list, Apollo already did real work to surface it.\n` : ''}
${opts.adzunaLeads?.length ? `\nAdzuna's live jobs board shows these real, recent job postings that may match this recruiter's sectors and functions: ${opts.adzunaLeads.map(l => `"${l.title}" at ${l.company}${l.location ? ` (${l.location})` : ''}${l.salary ? `, salary ~${l.salary}` : ''} — ${l.url}`).join(' | ')}. For any of these that reads as posted directly by the company itself (no recruitment agency name, no "on behalf of our client" language, no agency branding) rather than through a recruiter or agency, this is strong, verifiable evidence for signalType "job_posting_unclaimed", a company trying to fill this role itself right now with no recruiter attached, a genuine opportunity to pitch this recruiter's own candidates and service directly. Use the real posting URL as sourceUrl when you use one of these. Skip any that clearly look agency-posted.\n` : ''}

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
  // small in absolute terms. The recurring cron (intelligence-scan.js)
  // stays on the cheaper model to control cost at scale.
  // retries=1: this call already runs with a long timeout for multi-round
  // web search, and this file runs multiple sector-group calls per customer
  // (see below) — a full 2-retry budget per group could burn a large chunk
  // of the 15-minute wall-clock budget on one bad group. One retry still
  // absorbs a transient 429/5xx.
  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Scan for signals now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    }),
  }, 120000, 1) // web search runs multiple search round-trips, needs far more than the 12s default
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}`)
  const data = await resp.json()
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
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
  const companiesHouseKey = process.env.COMPANIES_HOUSE_API_KEY
  const adzunaAppId = process.env.ADZUNA_APP_ID
  const adzunaAppKey = process.env.ADZUNA_APP_KEY
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
      .select('user_id, sectors, functions, locations, tone, firm_name, writing_style, initial_scan_triggered_at')
      .eq('user_id', userId)
      .single()
    if (!ob) {
      console.error('[scan-now] no onboarding row yet for', userId)
      await setStatus(userId, { status: 'done', reason: 'no_onboarding', signalsFound: 0, startedAt, finishedAt: Date.now() })
      return
    }

    // Persistent guard, on top of the 10-minute recentBatch check above: that
    // check only catches a duplicate trigger arriving within a few minutes
    // (a double-click, a second tab). This one closes the gap the audit
    // flagged — a valid session token replayed hours or days later could
    // otherwise re-run this expensive, over-resourced first scan indefinitely
    // for the same customer. Set BEFORE the expensive work starts, not after,
    // so a second concurrent request can't slip through the same window.
    if (ob.initial_scan_triggered_at) {
      console.log('[scan-now] initial scan already triggered for', userId, 'at', ob.initial_scan_triggered_at, '- skipping')
      await setStatus(userId, { status: 'done', reason: 'already_scanned', signalsFound: 0, startedAt, finishedAt: Date.now() })
      return
    }
    await supabase.from('onboarding').update({ initial_scan_triggered_at: new Date().toISOString() }).eq('user_id', userId)

    // Pass 1: research each sector group in parallel, each with its own
    // full search budget, instead of one call rationing searches across
    // everything the customer picked. Each group first asks Apollo and
    // Adzuna what they can independently confirm is happening right now in
    // that slice, then hands that list to the AI as a head start.
    const groups = chunkSectors(ob.sectors, MAX_SECTOR_GROUPS)
    const groupResults = await Promise.all(groups.map(async (sectorGroup) => {
      const groupSectors = sectorGroup?.length ? sectorGroup : ob.sectors
      const [apolloLeads, adzunaLeads] = await Promise.all([
        discoverHotCompanies(apolloKey, { sectors: groupSectors, functions: ob.functions, locations: ob.locations }, supabase),
        discoverAdzunaJobs(adzunaAppId, adzunaAppKey, { sectors: groupSectors, functions: ob.functions, locations: ob.locations }),
      ])
      try {
        const text = await callAnthropic(anthropicKey, buildScanPrompt(ob, [], { sectorsOverride: sectorGroup, apolloLeads, adzunaLeads }))
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

      const [contact, companyInfo, chVerification, sourceVerified] = await Promise.all([
        verifyContact(apolloKey, s.company, s.titleKeywords, supabase),
        enrichCompany(apolloKey, s.company, supabase),
        s.signalType === 'leadership_change' ? verifyLeadershipChange(companiesHouseKey, s.company) : Promise.resolve(null),
        verifySourceUrl(s.sourceUrl),
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
        signal_type: resolveSignalType(s.signalType, '[scan-now]'),
        headline: s.headline,
        why_it_matters: s.whyItMatters || '',
        source_url: s.sourceUrl || '',
        source_label: s.sourceLabel || '',
        source_verified: sourceVerified,
        event_at: toEventIso(s.eventDate),
        who_to_approach: s.whoToApproach || '',
        candidate_angle: s.candidateAngle || '',
        contact_name: contact?.name || null,
        contact_title: contact?.title || null,
        contact_linkedin_url: contact?.linkedin_url || null,
        contact_verified: !!contact,
        title_keywords: Array.isArray(s.titleKeywords) ? s.titleKeywords.slice(0, 6) : [],
        ch_verified: !!chVerification,
        ch_verified_detail: chVerification?.detail || null,
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
    await reportServerError('scan-now-background', err, { userId })
    await setStatus(userId, { status: 'done', reason: 'error', errorMessage: err.message, signalsFound: 0, startedAt, finishedAt: Date.now() })
  }
}

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
import { getAuthedUser } from './lib/auth.js'
import { reserveAnthropicTokens } from './lib/aiUsage.js'
import {
  SIGNAL_TYPES, SIGNAL_LOOKBACK_DAYS, normalizeKey, splitToKeywords, extractJson,
  discoverHotCompanies, discoverAdzunaJobs, fetchWithRetry,
  dropGenericHiringWhereLiveJobsExist, buildEnrichedSignalRows,
} from './lib/scanShared.js'

// How many sector groups to research in parallel, and the minimum number of
// unique signals we want back before we're willing to show a brand new
// customer their first dashboard without trying harder first.
const MAX_SECTOR_GROUPS = 4
const MIN_SIGNAL_TARGET = 3
// Was 12 — an arbitrary number that had nothing to do with how many genuine
// signals a first scan can actually find, and was silently dropping real,
// already-found signals with zero logging of how many or which ones. Up to
// 4 sector-group calls plus a broaden pass can return up to 8 signals each
// (see buildScanPrompt's "Return up to 8 signals"), so 40 is comfortably
// above the realistic ceiling of a single run rather than a second hidden
// cap wearing the first one's clothes. Every signal that makes it past this
// still gets full Apollo/Companies House/source-verification enrichment,
// same as before — this only changes how many get the chance.
const MAX_TOTAL_SIGNALS = 40

// This pass is deliberately the expensive one (stronger model, up to 4
// parallel sector-group calls plus a broaden pass) — see the file header.
// One hour balances "a customer who got nothing shouldn't have to wait
// long" against "this shouldn't be trivially spammable from Settings."
const RESCAN_COOLDOWN_MS = 60 * 60 * 1000

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
${onboarding?.writing_style ? `The recruiter's real writing style, follow this closely when writing the introMessage, candidateAngle, and benchStrengthAngle text:\n${onboarding.writing_style}\n` : ''}
Use web search to find genuine, timely BD-relevant signals in these sectors and markets from the last ${SIGNAL_LOOKBACK_DAYS} days: funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity. A signal from any point in the last ${SIGNAL_LOOKBACK_DAYS} days counts as timely, it does not need to have happened today or this specific hour.
Also actively look for layoffs, redundancies, or restructuring news. This cuts both ways and both are worth surfacing: a company doing layoffs sometimes still needs to quietly backfill specific roles (frame the signal around that need), and separately, a real layoff or redundancy event puts a pool of genuinely available, often strong candidates on the market at once, worth surfacing on its own even with no obvious open role at that company, in which case candidateAngle should describe that available talent pool. Classify these as signalType "regulatory" and make the headline clearly say layoffs or redundancy so it's not confused with an ordinary hiring signal.
Search thoroughly before concluding there is nothing. Run multiple distinct searches, try each sector and each function by name, try combinations of sector + "funding" / "hiring" / "appoints" / "expansion" / "acquires", try the specified markets by name, and try recent news generally in these sectors before narrowing. Do not stop after one or two searches, a real, live-news industry genuinely has more happening in it than that.
${functions ? `This recruiter places into the functions listed above. When you find a strong, genuine signal, connect it to whichever of those functions it most plausibly affects, even if the reasoning takes a small logical step (e.g. a funding round signals Finance/Strategy hiring, a safety incident signals HSE hiring, a new market launch signals Government/Regulatory Affairs hiring, an M&A deal signals Corporate Development or Legal hiring). Make your best reasonable case for the closest function rather than discarding a real, well-sourced signal purely because the function match isn't perfect. Only leave a strong signal out entirely if you genuinely cannot connect it to any of the functions listed, even loosely.` : ''}
${opts.broaden ? `\nIMPORTANT: an earlier, narrower search pass came up thin. For this pass, widen your net further: look back up to the last 4 weeks (not just the last ${SIGNAL_LOOKBACK_DAYS} days), consider the parent industry category as well as the exact sub-sector, and count a signal even if the function connection takes a slightly longer logical chain, as long as it is still genuinely defensible. The bar is "real and sourced", not "perfect fit". Still never invent anything, and still cite a real source for every signal.\n` : ''}
${opts.apolloLeads?.length ? `\nApollo's own hiring database has independently confirmed these companies are actively posting jobs matching this recruiter's functions, within the last ${SIGNAL_LOOKBACK_DAYS} days, in these sectors and markets: ${opts.apolloLeads.map(l => `${l.name}${l.industry ? ` (${l.industry})` : ''}`).join(', ')}. Treat these as strong, confirmed leads, actively search for the real story behind each one (why they're hiring, any funding or expansion tied to it, the right person to approach, a real citable source) before deciding whether to include it. You are not limited to only these companies, keep searching broadly too, but do not ignore this list, Apollo already did real work to surface it.\n` : ''}
${opts.adzunaLeads?.length ? `\nAdzuna's live jobs board shows these real, recent job postings that may match this recruiter's sectors and functions: ${opts.adzunaLeads.map(l => `"${l.title}" at ${l.company}${l.location ? ` (${l.location})` : ''}${l.salary ? `, salary ~${l.salary}` : ''} — ${l.url}`).join(' | ')}. For any of these that reads as posted directly by the company itself (no recruitment agency name, no "on behalf of our client" language, no agency branding) rather than through a recruiter or agency, this is a genuine open role with no recruiter attached — do NOT write this up as a generic "signal" entry. Instead, write it as its own "live_job" entry (see the separate live_job field list below), one per specific role, with the real posting URL as sourceUrl. Skip any that clearly look agency-posted. If a company has one or more of these live_job entries, do not also write a separate hiring_activity or job_posting_unclaimed signal entry about that same company being on a hiring push in general — the specific role entries replace that, they don't sit alongside it.\n` : ''}

This is a brand new account with no history yet, so there is nothing to avoid repeating: ${recentCompanies.join(', ') || 'None yet'}.

Every signal must have a real, citable source you actually found via search. Do not invent anything. Return up to 8 signals, fewer if you can't find genuinely good ones after searching thoroughly, never pad with weak filler.

For each signal, determine:
- entryType: "signal"
- company: the company name
- signalType: one of ${SIGNAL_TYPES.join(', ')}
- headline: max 10 words
- whyItMatters: 1-2 sentences on why this is a genuine BD opportunity right now
- sourceUrl: the real URL you found this from
- sourceLabel: short label, e.g. techcrunch.com
- eventDate: your best estimate of when this actually happened or was posted, as YYYY-MM-DD, based on the source
- whoToApproach: the specific person or role to approach and why, bypass generic HR/Head of Talent unless they're genuinely the right door, and keep them within this recruiter's target functions above
- titleKeywords: 2-4 likely job title strings for the right decision-maker, used afterwards to look up a real verified contact
- introMessage: a ready-to-send opening outreach message (3-5 sentences) the recruiter can copy and send as-is to the person in whoToApproach, referencing this specific signal so it reads as informed rather than a cold generic pitch, written in the recruiter's communication tone above. Write finished, sendable text, not a template with placeholder brackets.
- candidateAngle: a specific, credible candidate pitch to lead with — background, seniority, source companies — matching the target functions above. Phrase it as an opening gambit, not an unconditional promise (e.g. "I'm working with a [seniority] who..." rather than "I have the perfect candidate"), so the recruiter still has room to say that exact person has just gone off-market if the hiring manager responds and it doesn't pan out — the point of this angle is opening the conversation, not guaranteeing one specific person. Leave blank if this signal isn't the kind that calls for a candidate pitch (e.g. a pure leadership-change or funding note with no obvious opening).
- benchStrengthAngle: a positioning pitch that does NOT name a single candidate — instead, say the recruiter works with several people who have direct, relevant experience in this exact niche, naming 1-2 real, specific companies that are genuine competitors or close peers to ${'`company`'} in this space (never vague phrasing like "similar companies"), so it reads as informed market knowledge rather than a generic claim. Leave blank if you cannot confidently name genuine, relevant peer companies.

For each genuine, directly-posted open role you found via the Adzuna list above, write a SEPARATE entry with these fields instead (do not mix these into a signal entry):
- entryType: "live_job"
- company: the company name, exactly as Adzuna gave it
- headline: the exact, specific role title (e.g. "Senior Finance Manager", not "Hiring across Finance") — this is what makes it a live job entry rather than a company-level narrative
- whyItMatters: 1 sentence on why this specific open role is a genuine BD opportunity right now (e.g. posted directly with no recruiter attached, matches this recruiter's placement functions)
- sourceUrl: the real Adzuna posting URL from the list above
- sourceLabel: short label, e.g. adzuna.com
- eventDate: the posting date if you can tell, else your best estimate, as YYYY-MM-DD
- whoToApproach: the specific person or role to approach about this exact opening
- titleKeywords: 2-4 likely job title strings for the right decision-maker, used afterwards to look up a real verified contact
- introMessage: a ready-to-send opening message referencing this exact open role, written in the recruiter's communication tone above
- candidateAngle: same as above, tailored to this exact role. Leave blank if it doesn't call for one.
- benchStrengthAngle: same as above, tailored to this exact role's niche. Leave blank if you cannot confidently name genuine peer companies.

Return a single JSON array mixing both kinds of entries, each tagged with its entryType. Only return the JSON array, nothing else. If nothing genuinely good was found, return an empty array.`
}

const DEFAULT_ANTHROPIC_DAILY_TOKEN_CAP = 2_000_000

async function callAnthropic(apiKey, systemPrompt, { maxUses = 8, maxTokens = 4096, supabase = null } = {}) {
  // Anthropic spend had no cap anywhere in this codebase — mirrors the
  // existing Apollo daily-credit-cap pattern (see reserveApolloCredits in
  // scanShared.js). Checked before the network call fires, same as Apollo's.
  const dailyTokenCap = parseInt(process.env.ANTHROPIC_DAILY_TOKEN_CAP, 10) || DEFAULT_ANTHROPIC_DAILY_TOKEN_CAP
  if (!(await reserveAnthropicTokens(supabase, maxTokens, dailyTokenCap))) {
    throw new Error('Anthropic daily token cap reached — skipping this call')
  }
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
  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) { console.error('[scan-now] auth failed:', authError); return }
  const userId = user.id

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
    // flagged — a valid session token replayed indefinitely could otherwise
    // re-run this expensive, over-resourced pass back-to-back for the same
    // customer. Set BEFORE the expensive work starts, not after, so a second
    // concurrent request can't slip through the same window.
    //
    // Was a one-time-ever flag (the column name is a holdover from that).
    // That made sense while the only caller was the onboarding "Launch
    // Annie" button, but it meant a customer whose first scan came back
    // empty — for any reason, including the silent AI-call failures fixed
    // alongside this change — had no way to ever ask Annie to try again
    // short of a developer resetting a column by hand. Settings' "Run a new
    // scan" button is a second, legitimate caller now, so this is a cooldown
    // instead: still blocks rapid re-fires, but doesn't lock a customer out
    // permanently. Tune RESCAN_COOLDOWN_MS if this cadence is wrong for your
    // Anthropic/Apollo budget.
    if (ob.initial_scan_triggered_at) {
      const sinceLast = Date.now() - new Date(ob.initial_scan_triggered_at).getTime()
      if (sinceLast < RESCAN_COOLDOWN_MS) {
        console.log('[scan-now] scan ran too recently for', userId, 'at', ob.initial_scan_triggered_at, '- skipping')
        await setStatus(userId, {
          status: 'done',
          reason: 'cooldown',
          retryAfter: new Date(new Date(ob.initial_scan_triggered_at).getTime() + RESCAN_COOLDOWN_MS).toISOString(),
          signalsFound: 0,
          startedAt,
          finishedAt: Date.now(),
        })
        return
      }
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
        const text = await callAnthropic(anthropicKey, buildScanPrompt(ob, [], { sectorsOverride: sectorGroup, apolloLeads, adzunaLeads }), { supabase })
        return { sectorGroup, found: extractJson(text), rawText: text }
      } catch (err) {
        console.error('[scan-now] group call failed for', userId, sectorGroup?.join('/') || 'general', err.message)
        // Unlike intelligence-scan.js (the cron, one Anthropic call per user,
        // whose single catch already reports here), this file runs several
        // sector-group calls per user in parallel — a failure here used to
        // vanish into Netlify's own ephemeral function logs with nothing
        // persisted, so a customer landing on an empty first dashboard because
        // every group call actually failed (bad key, rate limit, outage) was
        // indistinguishable from a genuine "nothing found" run. Report it the
        // same way the cron does, per group, so a real cause leaves a trace.
        await reportServerError('scan-now-background', err, { userId, stage: 'sector-group', sectors: sectorGroup?.join('/') || 'general' })
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
        const broadenText = await callAnthropic(anthropicKey, buildScanPrompt(ob, [], { broaden: true }), { maxUses: 10, supabase })
        const broadenFound = extractJson(broadenText)
        broadened = true
        if (!broadenFound.length) broadenPreview = (broadenText || '').trim().slice(0, 400)
        merged = mergeSignals([merged, broadenFound])
      } catch (err) {
        console.error('[scan-now] broaden pass failed for', userId, err.message)
        // Same gap as the sector-group catch above — this was the last
        // chance to explain a zero-signal first scan, and it was being
        // thrown away just as silently.
        await reportServerError('scan-now-background', err, { userId, stage: 'broaden-pass' })
        broadened = true
        broadenPreview = `broaden pass error: ${err.message}`
      }
    }

    // Enforce "replace, not supplement" deterministically in code, once, on
    // the final merged list — rather than trusting every individual AI call
    // (several parallel sector-group calls plus a possible broaden pass,
    // none of which see each other's output) to have each obeyed the
    // prompt's instruction not to double up.
    merged = dropGenericHiringWhereLiveJobsExist(merged)

    const capped = merged.slice(0, MAX_TOTAL_SIGNALS)
    if (merged.length > capped.length) {
      // No silent caps: if real, already-found signals are ever being
      // dropped here, that needs to be visible, not just quietly true.
      console.log(`[scan-now] truncated ${merged.length} genuine signals down to ${capped.length} for`, userId, '(MAX_TOTAL_SIGNALS cap)')
    }

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

    // Row-building itself (enrichCompany → verifyContact per entry, plus
    // Companies House/source-URL checks) now lives once in scanShared.js,
    // shared with intelligence-scan.js, and runs with bounded concurrency
    // across different companies instead of one entry at a time — see
    // buildEnrichedSignalRows's own comment for why that's safe even with
    // Live Jobs' multiple-entries-per-company case.
    const newEntries = capped.filter(s => s.company && s.headline && !existingKeys.has(normalizeKey(s.company, s.headline)))
    const rows = await buildEnrichedSignalRows(newEntries, { userId, apolloKey, companiesHouseKey, supabase, logPrefix: '[scan-now]' })

    // The exact bug that made a live customer's first scan report success
    // with zero signals actually written: the upsert's own `error` was
    // never checked. Two intelligence_signals columns this insert writes
    // (title_keywords, ch_verified/ch_verified_detail) existed only in
    // migration FILES, never actually applied to the live database — so
    // every write here was silently rejected by Postgres, every run, for
    // every customer, while this code cheerfully reported reason: 'ok' and
    // a signal count nothing backed up. Checking `error` here doesn't
    // prevent a schema drifting out from under the code again, but it means
    // that failure is now visibly logged instead of indistinguishable from
    // a genuinely quiet scan.
    let writeError = null
    if (rows.length) {
      const { error } = await supabase.from('intelligence_signals').upsert(rows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true })
      if (error) {
        writeError = error
        console.error(`[scan-now] upsert FAILED for`, userId, '-', error.message)
        await reportServerError('scan-now-background', new Error(error.message), { userId, stage: 'signal-upsert', attemptedRows: rows.length })
      } else {
        console.log(`[scan-now] wrote ${rows.length} signals for`, userId, '| groups:', groups.length, '| broadened:', broadened)
      }
    }
    await setStatus(userId, {
      status: 'done',
      reason: writeError ? 'error' : rows.length ? 'ok' : 'no_results',
      errorMessage: writeError?.message,
      signalsFound: writeError ? 0 : rows.length,
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

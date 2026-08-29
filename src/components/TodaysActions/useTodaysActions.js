import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import {
  buildDormantPool, buildMeetingPool, buildRelationshipPool, buildNewClientPool, buildSourcedPool,
  selectDailyItems, resolveTodaysActions, markActionDone,
} from '../../lib/todaysActions/index.js'
import { buildEnrichmentPrompt, buildCandidatePitchPrompt } from '../../lib/actionsCopy'
import { callChatStream } from '../../lib/callChat'
import { withTimeout } from '../../lib/withTimeout'
import { extractJson } from '../../lib/jsonExtract'
import { reportClientError } from '../../lib/errorReporting'
import { stripAiArtifacts } from '../../lib/textSanitize'
import { buildOutreachMessage, firstNameOf } from '../../lib/outreachMessage'
import { listCandidatesForMatching } from '../../lib/data/candidates'
import { prepareCandidatesForMatching, matchPreparedCandidatesToSignal } from '../../lib/candidateMatch'
import { createContact } from '../../lib/data/contacts'
import { findOrCreateCompany } from '../../lib/data/companies'
import { confirmContact } from '../../lib/confirmContact'

// 2026-08-29 audit fix: both AI copy calls below used to send EVERY
// qualifying item in ONE callChatStream call. selectDailyItems has no cap
// ("no ceiling on the total" — see its own header comment) so that prompt's
// size scales directly with the customer's own CRM: more contacts/deals
// clearing MIN_SCORE means a bigger prompt and more output the model has to
// generate before the stream can finish. Netlify's streaming-function
// execution cap (already root-caused for Ask Annie: 10s, see chat.js) makes
// that a real, reproducible hang for exactly the best-populated CRMs — the
// bug gets WORSE the more successfully someone uses the product, which is
// the worst possible failure shape and is a real, confirmed cause of "Today's
// Actions is still hanging" reports. Fixed by capping every individual call's
// prompt to a fixed batch of items — bounded regardless of how large a CRM
// grows — instead of capping how many cards are shown, so nothing is
// silently hidden; a batch that still fails only degrades its own items to
// fallback copy, not the whole page. BATCH_CONCURRENCY caps how many batches
// run at once so a pathologically large CRM can't fire dozens of parallel
// chat calls and blow through chat.js's own per-minute call cap
// (chat_reserve_call, 20/min by default) — normal-sized batches (a handful)
// all run in one group anyway.
const AI_BATCH_SIZE = 8
const BATCH_CONCURRENCY = 4
// Netlify kills a streaming function's connection at 10s; this is a
// defense-in-depth client-side ceiling above that so a batch that's merely
// slow (but would have finished) isn't cut off, while a connection that
// genuinely stalls with no more bytes and no close (exactly what "hanging"
// looks like from the browser) still resolves into a normal, catchable
// per-batch failure instead of waiting forever.
const AI_BATCH_TIMEOUT_MS = 15000

function chunk(items, size) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// Runs one async worker per batch, at most BATCH_CONCURRENCY at a time, and
// never lets one batch's rejection stop the others — Promise.allSettled's
// result array, one entry per batch, same order as `batches`.
async function runBatchesWithConcurrencyCap(batches, worker) {
  const settled = []
  for (const group of chunk(batches, BATCH_CONCURRENCY)) {
    settled.push(...(await Promise.allSettled(group.map(worker))))
  }
  return settled
}

// All of Today's Actions' data: what's currently visible, loading/error
// state, and the two mutations (mark done, add a verified contact to the
// CRM). Every card-open/copy-button/approach-chip bit of UI-only state
// stays in the components that render — this hook only ever holds real
// data and the calls that change it.
//
// The core difference from the old generate()/mergeActions design: nothing
// here ever caches a rendered card's content. Every call to refresh()
// recomputes the pools from live contacts/deals/intelligence_signals, and
// resolveTodaysActions (src/lib/todaysActions/resolve.js) does nothing more
// than ask "has the user already marked this done" — there's no snapshot
// to go stale, and no separate re-check of eligibility that could ever
// disagree with the pools that produced the list in the first place.
export function useTodaysActions({ user, profile }) {
  const [actions, setActions] = useState([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [error, setError] = useState('')
  const [onboarding, setOnboarding] = useState(null)
  const [crmAdded, setCrmAdded] = useState({})

  useEffect(() => {
    if (!user) return
    loadOnboarding()
    // Today's Actions is meant to always be there — this always loads and
    // shows whatever's currently eligible immediately, then a silent
    // background refresh isn't needed the way the old cache design needed
    // one, since there's no stale snapshot to reconcile. The first load is
    // simply not silent (shows the loading state) so a first-time visitor
    // sees something happening rather than a blank page.
    refresh({ silent: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  async function loadOnboarding() {
    const { data } = await supabase.from('onboarding').select('*').eq('user_id', user.id).single()
    setOnboarding(data)
  }

  async function refresh({ silent = false } = {}) {
    if (silent) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const [{ data: contacts }, { data: deals }, { data: intelSignals }, { data: freshOnboarding }, candidates] = await Promise.all([
        // 2026-08-24: contacts/deals are the shared CRM — team-scoped by
        // RLS, no client-side user_id filter on top of it, so Today's
        // Actions can match a signal against any teammate's contact, the
        // same way the rest of the shared CRM works.
        supabase.from('contacts').select('*').limit(500),
        supabase.from('deals').select('*').limit(200),
        // intelligence_signals is the opposite: PERSONAL, not team-scoped —
        // different recruiters on the same team can be working entirely
        // different markets, so this must stay this user's own signals only
        // (see lib/data/signals.js's header comment for the fuller
        // reasoning and the RLS migration that backs it). Reads what the
        // background scan already found, no search happens here.
        supabase.from('intelligence_signals').select('*').eq('user_id', user.id).neq('status', 'actioned').order('found_at', { ascending: false }).limit(300),
        supabase.from('onboarding').select('*').eq('user_id', user.id).single(),
        // Same lightweight pipeline-match check IntelligenceFeed.jsx already
        // does, computed once here, baked into each resolved action below
        // (see pipelineMatches).
        listCandidatesForMatching(user.id),
      ])

      const ob = freshOnboarding || onboarding

      // Step 1: deterministic pool building + selection, no AI involved.
      // Every pool is scored on the same scale and ranked by urgency first,
      // then value. No cap on how many show, no guaranteed slot per
      // category. A deleted or disqualified record simply isn't in these
      // live queries any more, so it can't appear here — no separate
      // "still exists" check is needed anywhere downstream.
      const pools = {
        dormant: buildDormantPool(contacts || []),
        meeting: buildMeetingPool(deals || [], contacts || []),
        relationship: buildRelationshipPool(intelSignals || [], contacts || []),
        new_client: buildNewClientPool(contacts || [], deals || []),
        sourced: buildSourcedPool(intelSignals || [], contacts || []),
      }
      const selected = selectDailyItems(pools)

      // Step 2: AI writes copy only for the CRM-derived items. Sourced items
      // already have their headline/why-it-matters/candidate angle written
      // by the scan that found them, no second AI call needed for those.
      const crmItems = selected.filter(i => i.category !== 'sourced')
      const enrichedByItem = new Map()
      let enrichmentFailed = false
      if (crmItems.length) {
        const batches = chunk(crmItems, AI_BATCH_SIZE)
        const settled = await runBatchesWithConcurrencyCap(batches, async (batchItems) => {
          const prompt = buildEnrichmentPrompt(batchItems, ob, profile)
          // callChatStream (not callChat) so a large batch doesn't buffer the
          // whole reply before returning anything — see chat.js's streaming
          // fix. withTimeout is the hard ceiling described in this file's
          // header comment: a batch that genuinely stalls fails cleanly
          // instead of hanging refresh() forever.
          const { text } = await withTimeout(
            callChatStream({
              messages: [{ role: 'user', content: 'Write the copy for these items.' }],
              systemOverride: prompt,
              maxTokens: 2500,
              model: 'claude-haiku-4-5-20251001',
            }),
            AI_BATCH_TIMEOUT_MS,
            'todays-actions-enrichment-batch',
          )
          return extractJson(text)
        })
        let anyBatchSucceeded = false
        settled.forEach((result, i) => {
          const batchItems = batches[i]
          if (result.status === 'fulfilled') {
            anyBatchSucceeded = true
            batchItems.forEach((item, j) => enrichedByItem.set(item, result.value[j] || null))
          } else {
            // 2026-08-29 audit fix: this used to swallow the failure into
            // `null` for every item with nothing logged anywhere — the only
            // visible symptom was a page full of cards reading "Follow up"
            // with no way to tell that from a real, if sparse, result. Now
            // logged to error_logs (same as every other tracked client
            // failure) so a recurrence shows up somewhere other than someone
            // noticing the page looks wrong. Scoped to just this batch's
            // items — a failure in one batch no longer costs every other
            // batch its real, successfully-generated copy.
            reportClientError("Today's Actions: CRM item enrichment batch failed", result.reason, { batchSize: batchItems.length })
            batchItems.forEach(item => enrichedByItem.set(item, null))
          }
        })
        // Only true when EVERY batch failed — a partial failure means most
        // cards still got real copy, so the degraded "couldn't load details"
        // fallback text below is reserved for the genuinely-all-down case.
        enrichmentFailed = !anyBatchSucceeded
      }

      // Pipeline matches computed once per sourced item here, up front —
      // reused by both the pitch-generation batch below and the final
      // reassembly, rather than calling matchCandidatesToSignal twice for
      // the same signal.
      const sourcedItems = selected.filter(i => i.category === 'sourced')
      // 2026-08-29 audit fix: matchCandidatesToSignal used to be called
      // once per sourced item, re-tokenizing this exact same candidate pool
      // from scratch every time — see candidateMatch.js's own header for
      // why that's a real, confirmed cause of "Today's Actions still
      // hanging" for well-populated CRMs (a synchronous main-thread freeze,
      // not a network timeout — nothing to catch, nothing in the logs).
      // Prepared once here, reused for every sourced item below.
      const preparedCandidates = prepareCandidatesForMatching(candidates)
      const matchesBySignal = new Map(sourcedItems.map(item => [item.signal, matchPreparedCandidatesToSignal(item.signal, preparedCandidates)]))

      // Step 2b: a short, real AI pitch for the single top pipeline match on
      // each sourced item that has one — grounded only in that candidate's
      // actual role/company/industry/notes, batched into one callChat call.
      // Rendered later as a visibly-labeled "Annie's read" pill, never
      // presented as a stored fact.
      const pitchTargets = sourcedItems
        .map(item => ({ item, topMatch: matchesBySignal.get(item.signal)?.[0] }))
        .filter(({ topMatch }) => topMatch)
      const pitchByItem = new Map()
      if (pitchTargets.length) {
        // Same scaling exposure as the enrichment call above (grows with how
        // many sourced signals have a top pipeline match), same fix: fixed-
        // size batches instead of one call for every target.
        const batches = chunk(pitchTargets, AI_BATCH_SIZE)
        const settled = await runBatchesWithConcurrencyCap(batches, async (batchTargets) => {
          const { text } = await withTimeout(
            callChatStream({
              messages: [{ role: 'user', content: 'Write the pitch for each pairing.' }],
              systemOverride: buildCandidatePitchPrompt(batchTargets.map(({ item, topMatch }) => ({ signal: { headline: item.signal.headline, industry: item.signal.company_industry }, candidate: topMatch }))),
              maxTokens: 1200,
              model: 'claude-haiku-4-5-20251001',
            }),
            AI_BATCH_TIMEOUT_MS,
            'todays-actions-pitch-batch',
          )
          return extractJson(text, { shape: 'string' })
        })
        settled.forEach((result, i) => {
          const batchTargets = batches[i]
          if (result.status === 'fulfilled') {
            batchTargets.forEach(({ item }, j) => pitchByItem.set(item, stripAiArtifacts(result.value[j]) || ''))
          } else {
            // A failed/malformed pitch batch just means no pill this time for
            // that batch's items — never worth failing the whole Today's
            // Actions load over. Still logged (not just swallowed) so a real
            // recurring problem here shows up somewhere rather than only as
            // "the pills don't show up much" that nobody thinks to investigate.
            reportClientError("Today's Actions: candidate pitch batch failed", result.reason, { batchSize: batchTargets.length })
          }
        })
      }

      // Step 3: reassemble in the ranked order decided in step 1, whether an
      // item is a CRM follow-up or a sourced lead makes no difference to
      // where it lands.
      const combined = selected.map(item => {
        if (item.category === 'sourced') {
          const s = item.signal
          const matches = matchesBySignal.get(s) || []
          const pitch = pitchByItem.get(item) || ''
          return {
            source: 'sourced',
            category: 'sourced',
            signalType: s.signal_type,
            urgency: item.urgency,
            score: item.score,
            headline: s.headline,
            detail: s.why_it_matters,
            company: s.company_name,
            companyLogo: s.company_logo_url,
            sourceUrl: s.source_url,
            sourceLabel: s.source_label,
            whoToApproach: s.who_to_approach,
            introMessage: s.intro_message,
            candidateAngle: s.candidate_angle,
            benchStrengthAngle: s.bench_strength_angle,
            candidateProfile: s.candidate_profile,
            verifiedContact: s.contact_verified ? { name: s.contact_name, title: s.contact_title, linkedin_url: s.contact_linkedin_url, email: s.contact_email } : null,
            // Mutually exclusive with verifiedContact — a signal has either
            // one verified contact or a multi-function panel, never both.
            contactCandidates: Array.isArray(s.contact_candidates) ? s.contact_candidates : [],
            likelyRoles: Array.isArray(s.likely_roles) ? s.likely_roles : [],
            pipelineMatches: matches.map((c, ci) => ({ name: c.name, role: c.role || '', company: c.company || '', industry: c.industry || '', status: c.status || '', whyPitch: ci === 0 ? pitch : '' })),
            signalIndustry: s.company_industry || '',
            signalId: s.id,
          }
        }
        const enriched = enrichedByItem.get(item)
        return {
          source: 'crm',
          category: item.category,
          urgency: item.urgency,
          score: item.score,
          // enrichmentFailed distinguishes "the AI call genuinely failed" —
          // now logged above — from any other reason a specific item might
          // lack copy, so a real failure reads as a visibly degraded state
          // instead of a plain category label indistinguishable from a
          // normal, if terse, card.
          headline: enriched?.headline || (enrichmentFailed ? "Follow up — couldn't load details" : 'Follow up'),
          detail: enriched?.detail || '',
          moveForward: enriched?.moveForward || [],
          signals: item.signals,
          company: item.contact?.company || item.deal?.company || item.signal?.company_name,
          contact: item.contact?.name || item.deal?.contact_name || '',
          title: item.contact?.title || '',
          signalId: item.category === 'relationship' ? item.signal?.id : null,
          // dormant/meeting/new_client have no signalId — resolveTodaysActions
          // needs a stable id for these too (see actionKey.js). keyContext is
          // the record's own last-touched timestamp: it's what makes a
          // contact that goes dormant, gets re-engaged, and later drifts
          // dormant again read as a new occurrence rather than one an old
          // "mark done" would suppress forever.
          contactId: item.contact?.id || null,
          dealId: item.deal?.id || null,
          keyContext: item.contact?.last_contacted || item.contact?.created_at || item.deal?.updated_at || '',
        }
      })

      // Step 4: the only persistence left — ask which of these the user has
      // already marked done, and record first-seen for anything new. No
      // merge, no snapshot, nothing to reconcile.
      const visible = await resolveTodaysActions({ supabase, userId: user.id, freshActions: combined })
      setActions(visible)
      setGenerated(true)
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  async function markDone(action) {
    // 2026-08-26 audit fix: this write's result was never checked — a
    // failed markActionDone (RLS denial, dropped connection) still removed
    // the card from the visible list, so it would silently reappear on the
    // next load with nothing telling the user their "done" didn't stick.
    const { error: err } = await markActionDone(supabase, user.id, action)
    if (err) { setError(err.message || 'Could not mark this done. Please try again.'); return }
    // 2nd-pass audit fix: nothing cleared `error` on a later success, so one
    // failed mark-done left the banner showing indefinitely even after a
    // different (or retried) action succeeded right after it.
    setError('')
    setActions(prev => prev.filter(a => a !== action))
  }

  // Only ever called from the verifiedContact block or the multi-contact
  // panel, both of which only render a button next to a real name — so
  // this never falls back to creating a "contact" that's just a company
  // name. crmKey lets the caller track more than one add-to-CRM button
  // independently on the same card (the multi-contact panel).
  async function addContactToCrm(action, contact, crmKey) {
    if (crmAdded[crmKey]) return
    // 2026-08-29 audit fix, flagged directly: this used to only ever write
    // the free-text `company` column — never found or created a real
    // companies row, so a contact added here never got a company_id.
    // Companies.jsx's own contact list only shows contacts that already
    // HAVE a company_id (see listContactsWithCompany's own comment in
    // contacts.js), so a contact added from Today's Actions was silently
    // invisible under its own company's tab, even though it showed up fine
    // in the plain Contacts list. Every other place a contact gets created
    // (ContactFormModal's CompanySelect, LinkedInImport's bulk import)
    // already finds-or-creates the real company first — this was the one
    // path that didn't.
    const companyId = await findOrCreateCompany(action.company, user.id)
    await createContact({
      name: contact.name,
      company: action.company,
      company_id: companyId,
      title: contact.title || null,
      linkedin_url: contact.linkedin_url || null,
      email: contact.email || null,
      status: 'warm',
      tags: ['from-todays-actions'],
    }, user.id)
    setCrmAdded(prev => ({ ...prev, [crmKey]: true }))
    // Same feedback loop as the Feed's own addToCrm — a human confirming
    // Apollo's guess was right bumps the shared company_contacts cache's
    // confidence for the next customer who hits this company + role.
    confirmContact({
      contact_name: contact.name,
      company_name: action.company,
      title_keywords: contact.title ? [contact.title] : [],
    })
  }

  // Safety net for signals written before introMessage existed — still
  // usable, so the copy button always has something worth copying, and
  // built to the same 3-part structure as the real AI-written field: a
  // warm opener, one paragraph naming the firm, the specific niche THIS
  // signal calls for, the real insight in plain language, relevant
  // regional experience, and the value-add close, then a short
  // call-to-action close.
  function fallbackIntroMessage(action) {
    const firmClause = profile?.firm_name ? `I work for a recruitment firm called ${profile.firm_name}` : 'I work for a recruitment firm'
    const functions = onboarding?.functions?.length ? onboarding.functions.join(', ') : 'this space'
    const locations = onboarding?.locations?.length ? onboarding.locations.join(', ') : 'the region'
    const insight = action.detail || 'it looks like a real opportunity worth exploring together'
    return `I hope you are doing well.\n\n${firmClause}, where I specialise in recruiting across ${functions}. ${insight} I'd expect this means genuine hiring needs on the horizon, and given our experience across ${locations}, I'm confident we can add value as a recruitment partner here through our relevant candidate network.\n\nWould you be open to a call to discuss in more detail?`
  }

  // The one message actually shown/copied: a real greeting addressed to the
  // contact by name, Annie's own body text for this signal, and a sign-off
  // that introduces the sender by name and firm — see outreachMessage.js
  // for why this is composed here rather than left to the AI prompt.
  function fullIntroMessage(action, contact) {
    const body = action.introMessage || fallbackIntroMessage(action)
    return buildOutreachMessage({
      body,
      contactFirstName: contact ? firstNameOf(contact.name) : '',
      senderFirstName: firstNameOf(profile?.full_name),
      firmName: profile?.firm_name || '',
    })
  }

  return {
    actions, loading, refreshing, generated, error, onboarding, crmAdded,
    refresh, markDone, addContactToCrm, fullIntroMessage,
  }
}

import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import {
  buildDormantPool, buildMeetingPool, buildRelationshipPool, buildNewClientPool, buildSourcedPool,
  selectDailyItems, resolveTodaysActions, markActionDone,
} from '../../lib/todaysActions/index.js'
import { buildEnrichmentPrompt, buildCandidatePitchPrompt } from '../../lib/actionsCopy'
import { callChat } from '../../lib/callChat'
import { extractJson } from '../../lib/jsonExtract'
import { stripAiArtifacts } from '../../lib/textSanitize'
import { buildOutreachMessage, firstNameOf } from '../../lib/outreachMessage'
import { listCandidatesForMatching } from '../../lib/data/candidates'
import { matchCandidatesToSignal } from '../../lib/candidateMatch'
import { createContact } from '../../lib/data/contacts'
import { confirmContact } from '../../lib/confirmContact'

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
      let enrichedList = []
      if (crmItems.length) {
        const prompt = buildEnrichmentPrompt(crmItems, ob, profile)
        const { text } = await callChat({
          messages: [{ role: 'user', content: 'Write the copy for these items.' }],
          systemOverride: prompt,
          maxTokens: 2500,
          model: 'claude-haiku-4-5-20251001',
        })
        try {
          enrichedList = extractJson(text)
        } catch {
          enrichedList = crmItems.map(() => null)
        }
      }
      const enrichedByItem = new Map(crmItems.map((item, i) => [item, enrichedList[i] || null]))

      // Pipeline matches computed once per sourced item here, up front —
      // reused by both the pitch-generation batch below and the final
      // reassembly, rather than calling matchCandidatesToSignal twice for
      // the same signal.
      const sourcedItems = selected.filter(i => i.category === 'sourced')
      const matchesBySignal = new Map(sourcedItems.map(item => [item.signal, matchCandidatesToSignal(item.signal, candidates)]))

      // Step 2b: a short, real AI pitch for the single top pipeline match on
      // each sourced item that has one — grounded only in that candidate's
      // actual role/company/industry/notes, batched into one callChat call.
      // Rendered later as a visibly-labeled "Annie's read" pill, never
      // presented as a stored fact.
      const pitchTargets = sourcedItems
        .map(item => ({ item, topMatch: matchesBySignal.get(item.signal)?.[0] }))
        .filter(({ topMatch }) => topMatch)
      let pitchByItem = new Map()
      if (pitchTargets.length) {
        try {
          const { text } = await callChat({
            messages: [{ role: 'user', content: 'Write the pitch for each pairing.' }],
            systemOverride: buildCandidatePitchPrompt(pitchTargets.map(({ item, topMatch }) => ({ signal: { headline: item.signal.headline, industry: item.signal.company_industry }, candidate: topMatch }))),
            maxTokens: 1200,
            model: 'claude-haiku-4-5-20251001',
          })
          const pitches = extractJson(text)
          pitchByItem = new Map(pitchTargets.map(({ item }, i) => [item, stripAiArtifacts(pitches[i]) || '']))
        } catch {
          // A failed/malformed pitch batch just means no pill this time —
          // never worth failing the whole Today's Actions load over.
          pitchByItem = new Map()
        }
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
          headline: enriched?.headline || 'Follow up',
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
    await markActionDone(supabase, user.id, action)
    setActions(prev => prev.filter(a => a !== action))
  }

  // Only ever called from the verifiedContact block or the multi-contact
  // panel, both of which only render a button next to a real name — so
  // this never falls back to creating a "contact" that's just a company
  // name. crmKey lets the caller track more than one add-to-CRM button
  // independently on the same card (the multi-contact panel).
  async function addContactToCrm(action, contact, crmKey) {
    if (crmAdded[crmKey]) return
    await createContact({
      name: contact.name,
      company: action.company,
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

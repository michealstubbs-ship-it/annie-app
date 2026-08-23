import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { buildDormantPool, buildMeetingPool, buildRelationshipPool, buildNewClientPool, buildSourcedPool, selectDailyItems } from '../lib/actionsEngine'
import { buildEnrichmentPrompt } from '../lib/actionsCopy'
import { callChat } from '../lib/callChat'
import { extractJson } from '../lib/jsonExtract'
import { buildOutreachMessage, firstNameOf } from '../lib/outreachMessage'
import { listCandidatesForMatching } from '../lib/data/candidates'
import { matchCandidatesToSignal } from '../lib/candidateMatch'
import { createContact } from '../lib/data/contacts'
import { confirmContact } from '../lib/confirmContact'
import ApproachPicker from './ApproachPicker'
import CompanyLogo from './CompanyLogo'
import CandidateProfileBox from './CandidateProfileBox'

// The candidate/bench-strength angles a sourced signal can lead with when
// there's no real pipeline match to show instead — a real match (see the
// dedicated pipeline-match box in the render below) always outranks these,
// same priority Intelligence Feed used to give it before its own copy of
// this moved here.
function buildApproaches(action) {
  const approaches = []
  if (action.candidateAngle) approaches.push({ key: 'candidate', icon: '🎯', label: 'Lead with a candidate', tone: 'default', content: action.candidateAngle })
  if (action.benchStrengthAngle) approaches.push({ key: 'bench', icon: '💪', label: 'Lead with our experience', tone: 'default', content: action.benchStrengthAngle })
  return approaches
}

// Today's BD Actions = anything driven by a real signal Annie found
// (sourced: a brand-new company; relationship: fresh news about a company
// already in the CRM). Worth your follow up = pure CRM housekeeping with no
// news behind it (dormant/meeting/new_client). See the mock discussion this
// session for why the split runs along "has a signal" rather than "is the
// company already known".
const BD_CATEGORIES = ['sourced', 'relationship']

// The mock never labels a sourced signal "sourced by annie" — that's implied
// by which tab it's in. Its BD-tab cards show at most one pill: "live role"
// for a live_job posting, or "time-sensitive" when the signal is urgent, and
// often no badge at all. `sourced` has no entry here on purpose — see badge
// selection below, which renders nothing for a plain (non-live_job) sourced
// item unless it's also urgent.
const BADGE = {
  dormant: { label: 're-engage', className: 'bg-amber-100 text-amber-700' },
  meeting: { label: 'meeting', className: 'bg-purple-100 text-purple-700' },
  relationship: { label: 'relationship', className: 'bg-purple-100 text-purple-700' },
  new_client: { label: 'new client', className: 'bg-blue-100 text-blue-700' },
  live_job: { label: 'live role', className: 'bg-green-100 text-green-700' },
}

// A cached action's pipelineMatches may be either the current shape (a
// {name, role, company, industry, status} object per candidate, added
// 2026-08-23) or the older plain-string-name shape it replaced —
// actions_cache rows already written before that change won't regenerate
// for up to 24h, so both need to render without crashing.
function normalizeMatch(m) {
  return typeof m === 'string' ? { name: m, role: '', company: '', industry: '', status: '' } : m
}

// The mock's per-candidate "why" pills (🏢/🎯/⭐) are demo copy invented for
// three specific fictional people — nothing upstream computes a bespoke
// reasoning sentence per real candidate. Rather than either fabricating one
// or dropping the pill treatment entirely, this builds the same pill UI from
// fields that are actually real: the candidate's current company (and
// whether it shares the signal's industry), their role, and their CRM
// status. Same visual language as the mock, honest content underneath.
function buildWhyChips(m, action) {
  const chips = []
  if (m.company) {
    const sameSector = action.signalIndustry && m.industry && m.industry.trim().toLowerCase() === action.signalIndustry.trim().toLowerCase()
    chips.push({ icon: '🏢', text: sameSector ? `${m.company}, same sector` : m.company })
  }
  if (m.role) chips.push({ icon: '🎯', text: m.role })
  if (m.status) {
    const label = { warm: 'Warm in your pipeline', active: 'Actively engaged', new: 'New to your pipeline' }[m.status.toLowerCase()] || `${m.status}, in your pipeline`
    chips.push({ icon: '⭐', text: label })
  }
  return chips
}

export default function TodaysActions() {
  const { user, profile } = useAuth()
  const [actions, setActions] = useState([])
  const [loading, setLoading] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [error, setError] = useState('')
  const [onboarding, setOnboarding] = useState(null)
  const [openIndex, setOpenIndex] = useState(null)
  const [copiedIndex, setCopiedIndex] = useState(null)
  const [approachChoice, setApproachChoice] = useState({})
  const [tab, setTab] = useState('bd')
  const [crmAdded, setCrmAdded] = useState({})

  useEffect(() => {
    loadCachedActions()
    loadOnboarding()
  }, [user])

  async function loadOnboarding() {
    const { data } = await supabase.from('onboarding').select('*').eq('user_id', user.id).single()
    setOnboarding(data)
  }

  async function loadCachedActions() {
    const { data } = await supabase
      .from('actions_cache')
      .select('*')
      .eq('user_id', user.id)
      .gt('expires_at', new Date().toISOString())
      .order('generated_at', { ascending: false })
      .limit(1)
      .single()

    if (data?.actions?.length) {
      setActions(data.actions)
      setGenerated(true)
    } else {
      // Nothing generated yet today (brand new account, or everything from
      // today's list was already actioned) — build it automatically instead
      // of making the person click a button before Annie shows them
      // anything. Matches the rest of the dashboard: they land straight
      // into value, not an empty state waiting on a click.
      generate()
    }
  }

  async function generate() {
    setLoading(true)
    setError('')
    try {
      const [{ data: contacts }, { data: deals }, { data: intelSignals }, { data: freshOnboarding }, candidates] = await Promise.all([
        supabase.from('contacts').select('*').eq('user_id', user.id).limit(500),
        supabase.from('deals').select('*').eq('user_id', user.id).limit(200),
        // Reads what the background scan already found, no search happens here.
        supabase.from('intelligence_signals').select('*').eq('user_id', user.id).neq('status', 'actioned').order('found_at', { ascending: false }).limit(300),
        supabase.from('onboarding').select('*').eq('user_id', user.id).single(),
        // Same lightweight pipeline-match check IntelligenceFeed.jsx already
        // does, computed once here at generate() time and baked into each
        // cached action below (see pipelineMatches), so a cache-hit read on
        // page load never needs the candidate list at all.
        listCandidatesForMatching(user.id),
      ])

      const ob = freshOnboarding || onboarding

      // Step 1: deterministic pool building + selection, no AI involved. Every pool,
      // including sourced leads, is scored on the same scale and ranked by urgency
      // first, then value. No cap on how many show, no guaranteed slot per category.
      const pools = {
        dormant: buildDormantPool(contacts || []),
        meeting: buildMeetingPool(deals || [], contacts || []),
        relationship: buildRelationshipPool(intelSignals || [], contacts || []),
        new_client: buildNewClientPool(contacts || [], deals || []),
        sourced: buildSourcedPool(intelSignals || [], contacts || []),
      }
      const selected = selectDailyItems(pools)

      // Step 2: AI writes copy only for the CRM-derived items. Sourced items already
      // have their headline/why-it-matters/candidate angle written by the scan that
      // found them, no second AI call needed for those.
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

      // Step 3: reassemble in the ranked order decided in step 1, whether an item is
      // a CRM follow-up or a sourced lead makes no difference to where it lands.
      const combined = selected.map(item => {
        if (item.category === 'sourced') {
          const s = item.signal
          return {
            source: 'sourced',
            category: 'sourced',
            signalType: s.signal_type,
            urgency: item.urgency,
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
            // Just name/role/company, not the full candidate row — this is
            // what actually gets stored in actions_cache's jsonb column, so
            // it stays small and serializes cleanly. Older cached rows may
            // still hold this as a plain array of name strings from before
            // 2026-08-23 — the render below handles both shapes, so an
            // existing cache doesn't need to expire before this works.
            pipelineMatches: matchCandidatesToSignal(s, candidates).map(c => ({ name: c.name, role: c.role || '', company: c.company || '', industry: c.industry || '', status: c.status || '' })),
            signalIndustry: s.company_industry || '',
            signalId: s.id,
          }
        }
        const enriched = enrichedByItem.get(item)
        return {
          source: 'crm',
          category: item.category,
          urgency: item.urgency,
          headline: enriched?.headline || 'Follow up',
          detail: enriched?.detail || '',
          moveForward: enriched?.moveForward || [],
          signals: item.signals,
          company: item.contact?.company || item.deal?.company || item.signal?.company_name,
          contact: item.contact?.name || item.deal?.contact_name || '',
          title: item.contact?.title || '',
          // Relationship-category items render through the generic
          // AI-enriched follow-up card below (moveForward), not the
          // ApproachPicker/pipeline-match UI sourced items use, so there's
          // nothing to compute a match for here yet — see the plan note on
          // this being a deliberate, separate follow-up rather than in
          // scope for this pass.
          signalId: item.category === 'relationship' ? item.signal?.id : null,
        }
      })

      setActions(combined)
      setGenerated(true)

      await supabase.from('actions_cache').upsert({
        user_id: user.id,
        actions: combined,
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: 'user_id' })

    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Safety net for signals written before introMessage existed — still
  // usable, so the copy button always has something worth copying. Body
  // text only, same contract as the AI-written field: buildOutreachMessage
  // adds the actual greeting and sign-off, this never should.
  function fallbackIntroMessage(action) {
    const firmLine = profile?.firm_name ? `I work for a recruitment firm called ${profile.firm_name}.` : `I work in recruitment.`
    const insight = action.detail || 'it looks like a real opportunity worth exploring together.'
    return `I hope you are doing well.\n\n${firmLine} I saw the news about ${action.headline} at ${action.company}. ${insight}\n\nWould you be open to a call to discuss in more detail?`
  }

  // The one message actually shown/copied: a real greeting addressed to the
  // verified contact by name when we have one, Annie's own body text for
  // this signal, and a sign-off that introduces the sender by name and firm
  // — see outreachMessage.js for why this is composed here rather than left
  // to the AI prompt.
  function fullIntroMessage(action) {
    const body = action.introMessage || fallbackIntroMessage(action)
    return buildOutreachMessage({
      body,
      contactFirstName: action.verifiedContact ? firstNameOf(action.verifiedContact.name) : '',
      senderFirstName: firstNameOf(profile?.full_name),
      firmName: profile?.firm_name || '',
    })
  }

  async function copyIntroMessage(action, index) {
    const text = fullIntroMessage(action)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard permission can fail quietly in some browsers/contexts —
      // the message is still shown right above the button either way.
    }
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(c => (c === index ? null : c)), 2000)
  }

  // Only ever called from the verifiedContact block below, which only
  // renders when a real name is present — so this never falls back to
  // creating a "contact" that's just a company name the way the Feed's old
  // unconditional Add to CRM button used to.
  async function addContactToCrm(action, index) {
    if (crmAdded[index]) return
    await createContact({
      name: action.verifiedContact.name,
      company: action.company,
      title: action.verifiedContact.title || null,
      linkedin_url: action.verifiedContact.linkedin_url || null,
      email: action.verifiedContact.email || null,
      status: 'warm',
      tags: ['from-todays-actions'],
    }, user.id)
    setCrmAdded(prev => ({ ...prev, [index]: true }))
    // Same feedback loop as the Feed's old addToCrm — a human confirming
    // Apollo's guess was right, bumps the shared company_contacts cache's
    // confidence for the next customer who hits this company + role.
    confirmContact({
      contact_name: action.verifiedContact.name,
      company_name: action.company,
      title_keywords: action.verifiedContact.title ? [action.verifiedContact.title] : [],
    })
  }

  async function markDone(action, index) {
    if (action.signalId) {
      await supabase.from('intelligence_signals').update({ status: 'actioned' }).eq('id', action.signalId)
    }
    const next = actions.filter((_, i) => i !== index)
    setActions(next)
    await supabase.from('actions_cache').upsert({
      user_id: user.id,
      actions: next,
      generated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'user_id' })
  }

  return (
    <div className="p-8 max-w-[900px]">
      <div className="mb-1">
        <h1 className="text-xl font-extrabold text-navy">Good morning, {profile?.full_name?.split(' ')[0] || 'there'}</h1>
        <p className="text-gray-500 text-[13px] mt-0.5">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {!generated && !loading && (
        <div className="card p-10 text-center mt-6">
          <div className="text-5xl mb-4">⚡</div>
          <h2 className="text-xl font-bold text-navy mb-2">Ready to see today's actions?</h2>
          <p className="text-gray-500 mb-6 max-w-sm mx-auto">Annie is already researching your market around the clock. This pulls together everything genuinely worth acting on today, sized by real opportunity, not a fixed number.</p>
          <button onClick={generate} className="btn-primary">Show Today's Actions</button>
        </div>
      )}

      {loading && (
        <div className="card p-10 text-center mt-6">
          <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-navy font-semibold">Annie is thinking...</p>
          <p className="text-gray-500 text-sm mt-1">Scoring your pipeline against what she's already found</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4 mt-6">{error}</div>
      )}

      {generated && actions.length > 0 && (() => {
        const rows = actions.map((action, i) => ({ action, i }))
        const bdRows = rows.filter(r => BD_CATEGORIES.includes(r.action.category))
        const followUpRows = rows.filter(r => !BD_CATEGORIES.includes(r.action.category))
        const activeRows = tab === 'bd' ? bdRows : followUpRows
        return (
        <div>
          <div className="flex gap-0 border-b-2 border-gray-200 mt-6">
            <button
              onClick={() => setTab('bd')}
              className={`px-1.5 py-2.5 mr-[22px] text-[13.5px] font-bold border-b-2 -mb-0.5 transition-colors ${tab === 'bd' ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'}`}
            >
              Today's BD actions {bdRows.length > 0 && <span className="text-xs font-semibold">({bdRows.length})</span>}
            </button>
            <button
              onClick={() => setTab('followup')}
              className={`px-1.5 py-2.5 text-[13.5px] font-bold border-b-2 -mb-0.5 transition-colors ${tab === 'followup' ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'}`}
            >
              Worth your follow up {followUpRows.length > 0 && <span className="text-xs font-semibold">({followUpRows.length})</span>}
            </button>
          </div>

          {activeRows.length === 0 ? (
            <div className="card p-8 text-center mt-5">
              <p className="text-gray-500 text-sm max-w-sm mx-auto">
                {tab === 'bd'
                  ? "No new BD signals right now, check Worth your follow up, or check back soon, Annie's still watching in the background."
                  : "Nothing needs following up right now, your pipeline is current."}
              </p>
            </div>
          ) : (
          <>
          <p className="text-[12.5px] text-gray-500 leading-relaxed mt-5 mb-4 max-w-[600px]">
            {tab === 'bd'
              ? <>Annie found <span className="font-semibold text-navy">{activeRows.length} new signal{activeRows.length === 1 ? '' : 's'} worth acting on</span>, ranked by what's most time-sensitive first.</>
              : <><span className="font-semibold text-navy">{activeRows.length} thing{activeRows.length === 1 ? '' : 's'}</span> worth a routine follow-up, no new research behind these.</>}
          </p>

          <div className={tab === 'followup' ? 'space-y-2' : 'space-y-3'}>
          {activeRows.map(({ action, i }) => {
            const isOpen = openIndex === i
            const isSourced = action.source === 'sourced'
            // A plain sourced signal (not live_job) carries no category badge
            // at all, matching the mock — it's only ever flagged via the
            // separate time-sensitive pill just below when it's urgent.
            const badge = action.signalType === 'live_job' ? BADGE.live_job : (isSourced ? null : (BADGE[action.category] || BADGE.new_client))
            const matches = (action.pipelineMatches || []).map(normalizeMatch)
            return (
              <div
                key={i}
                onClick={() => setOpenIndex(isOpen ? null : i)}
                className={`bg-white rounded-xl shadow-[0_1px_2px_rgba(13,27,62,0.06),0_1px_6px_rgba(13,27,62,0.04)] cursor-pointer hover:shadow-md transition-shadow ${tab === 'followup' ? 'px-3.5 py-3' : 'p-4'}`}
              >
                <div className="flex items-start gap-3">
                  {tab === 'bd' && (
                    <div className="w-7 h-7 rounded-full bg-navy text-gold flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">
                      {i + 1}
                    </div>
                  )}
                  {action.company && <CompanyLogo name={action.company} logoUrl={action.companyLogo} size={tab === 'followup' ? 'w-6 h-6' : 'w-8 h-8'} textSize={tab === 'followup' ? 'text-[9px]' : 'text-[11px]'} />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={`font-bold text-navy ${tab === 'followup' ? 'text-[13px]' : 'text-sm'}`}>{action.headline}</h3>
                      {badge && <span className={`text-[9.5px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${badge.className}`}>{badge.label}</span>}
                      {isSourced && action.signalType !== 'live_job' && action.urgency >= 2 && <span className="text-[9.5px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-gold text-navy">time-sensitive</span>}
                    </div>
                    {(action.contact || action.company) && (
                      <p className="text-[12px] text-gold-ink font-semibold mt-1">
                        {[action.contact, action.title, action.company].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    <p className={isSourced ? 'text-gray-600 text-[13px] italic border-l-2 border-gold pl-2.5 mt-1.5 leading-relaxed' : `text-gray-600 ${tab === 'followup' ? 'text-[12.5px] mt-0.5' : 'text-sm mt-1.5'}`}>{action.detail}</p>

                    {isOpen && (
                      <div className="mt-3 pt-3 border-t border-gray-100" onClick={e => e.stopPropagation()}>
                        {isSourced ? (
                          <>
                            <div className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">What Annie found</div>
                            {action.sourceUrl && (
                              <a href={action.sourceUrl} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline block mb-3">
                                🔗 {action.sourceLabel || action.sourceUrl}
                              </a>
                            )}
                            <div className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Who to approach, and why</div>
                            {action.verifiedContact ? (
                              <div className="bg-green-50 border border-green-200 rounded-[10px] px-3 py-2.5 mb-2.5">
                                <div className="flex items-center justify-between gap-2 mb-1">
                                  <span className="text-[9px] font-bold text-green-700 uppercase tracking-wider">Verified via Apollo</span>
                                  {/* Only rendered here, where a real name and (usually) email actually
                                      exist — the Feed's old unconditional Add to CRM button used to fall
                                      back to just the company name when there was no real contact, which
                                      created junk CRM entries. This can't do that: no verifiedContact,
                                      no button. */}
                                  <button
                                    onClick={() => addContactToCrm(action, i)}
                                    disabled={crmAdded[i]}
                                    className={`text-[10.5px] font-bold px-2.5 py-1 rounded-full border transition-colors flex-shrink-0 ${crmAdded[i] ? 'text-gray-400 border-gray-200 bg-white cursor-default' : 'text-green-700 border-green-300 bg-white hover:bg-green-50'}`}
                                  >
                                    {crmAdded[i] ? `✓ Added to CRM` : `＋ Add ${firstNameOf(action.verifiedContact.name)} to CRM`}
                                  </button>
                                </div>
                                <p className="text-[12.5px] font-bold text-navy mt-0.5">{action.verifiedContact.name}{action.verifiedContact.title ? `, ${action.verifiedContact.title}` : ''}</p>
                                <div className="flex items-center gap-2.5 mt-0.5 flex-wrap">
                                  {action.verifiedContact.email && (
                                    <a href={`mailto:${action.verifiedContact.email}`} className="text-[11px] text-blue-600 hover:underline">{action.verifiedContact.email}</a>
                                  )}
                                  {action.verifiedContact.linkedin_url && (
                                    <a href={action.verifiedContact.linkedin_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline">View LinkedIn profile</a>
                                  )}
                                </div>
                                <p className="text-xs text-gray-600 mt-1.5">{action.whoToApproach}</p>
                              </div>
                            ) : (
                              <p className="text-xs text-gray-600 mb-2.5">{action.whoToApproach} <span className="text-gray-400">(no verified contact found yet, approach by role)</span></p>
                            )}

                            {/* Rich per-candidate pipeline match, mirroring the mock's
                                cand-row layout — real name, role and current company
                                for each match, never invented "why" reasoning the way
                                the mock's own demo data did, since nothing upstream
                                actually computes that per candidate. */}
                            {matches.length > 0 ? (
                              <div className="bg-green-50 border border-green-200 rounded-[10px] px-3 py-2.5 mb-2.5">
                                <div className="text-[9px] font-bold text-green-700 uppercase tracking-wider">✓ Annie checked your pipeline</div>
                                <p className="text-[12.5px] font-bold text-green-700 mt-0.5 mb-0.5">{matches.length} candidate{matches.length === 1 ? '' : 's'} already in your pipeline could fit this</p>
                                <p className="text-[10.5px] italic text-[#4d7c5f]">Matched on role and industry overlap with this signal</p>
                                {matches.map((m, mi) => {
                                  const chips = buildWhyChips(m, action)
                                  return (
                                    <div key={mi} className="mt-2 pt-2 border-t border-green-700/15">
                                      <p className="text-xs font-bold text-navy">
                                        {m.name}
                                        {(m.role || m.company) && <span className="font-medium text-[#166534] text-[11.5px]"> · {[m.role, m.company].filter(Boolean).join(', ')}</span>}
                                      </p>
                                      {chips.length > 0 && (
                                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                                          {chips.map((c, ci) => (
                                            <span key={ci} className="text-[10.5px] font-semibold px-2.5 py-[3px] rounded-full bg-white border border-green-200 text-[#166534] whitespace-nowrap">
                                              {c.icon} {c.text}
                                            </span>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            ) : (
                              <div className="bg-page-bg border border-dashed border-[#d7dceb] rounded-[10px] px-3 py-2.5 mb-2.5">
                                <div className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">🔍 Annie checked your pipeline</div>
                                <p className="text-xs text-gray-500 mt-0.5">No current candidates match this spec yet, worth sourcing fresh rather than a dead end.</p>
                              </div>
                            )}

                            <CandidateProfileBox profile={action.candidateProfile} />
                            {matches.length === 0 && (
                              <ApproachPicker
                                approaches={buildApproaches(action)}
                                selectedKey={approachChoice[i]}
                                onSelect={key => setApproachChoice(prev => ({ ...prev, [i]: key }))}
                              />
                            )}
                            {/* The one thing here meant to be used as-is, not
                                just read — a distinct navy block with a bold
                                gold action button so it reads as "push this"
                                rather than blending into the text above it. */}
                            <div className="bg-navy rounded-[10px] px-3.5 py-3 mb-1">
                              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                                <span className="text-[9.5px] font-bold text-gold uppercase tracking-wider">✉️ Ready-to-send message</span>
                                <button
                                  onClick={() => copyIntroMessage(action, i)}
                                  title="Copies this message to your clipboard, ready to paste into an email or LinkedIn message: nothing to draft, nothing to leave this page for."
                                  className="text-xs font-bold px-4 py-2 rounded-md bg-gold text-navy hover:bg-gold/90 flex-shrink-0 transition-colors"
                                >
                                  {copiedIndex === i ? '✓ Copied!' : '📋 Copy message'}
                                </button>
                              </div>
                              <p className="text-white/90 text-[11.5px] leading-relaxed whitespace-pre-line">{fullIntroMessage(action)}</p>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Why this made the list</div>
                            <div className="space-y-1 mb-3">
                              {Object.entries(action.signals || {}).map(([k, v]) => (
                                <div key={k} className="flex justify-between text-xs">
                                  <span className="text-gray-400">{k}</span>
                                  <span className="text-navy font-semibold">{v}</span>
                                </div>
                              ))}
                            </div>
                            {action.moveForward?.length > 0 && (
                              <>
                                <div className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Ways to move this forward</div>
                                <div className="space-y-1.5 mb-3">
                                  {action.moveForward.map((m, mi) => (
                                    <div key={mi} className="bg-page-bg rounded-lg px-3 py-2 text-xs text-gray-600">{m}</div>
                                  ))}
                                </div>
                              </>
                            )}
                          </>
                        )}
                        <button onClick={() => markDone(action, i)} className="text-xs font-semibold text-gray-400 hover:text-navy">Mark done</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          </div>

          <button onClick={generate} disabled={loading} className="btn-ghost text-sm mt-3">
            Refresh
          </button>
          </>
          )}
        </div>
        )
      })()}

      {generated && actions.length === 0 && !loading && (
        <div className="card p-10 text-center mt-6">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-bold text-navy mb-1">Nothing urgent today</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">Your pipeline is quiet and Annie's ongoing scan hasn't turned up anything strong enough yet. Check back later, she's still watching in the background.</p>
        </div>
      )}
    </div>
  )
}

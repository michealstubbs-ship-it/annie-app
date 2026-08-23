import React, { useState, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useSupabaseQuery } from '../lib/useSupabaseQuery'
import { listActiveSignals, markSignalSeen, markSignalActioned } from '../lib/data/signals'
import { listCandidatesForMatching } from '../lib/data/candidates'
import { listContactsForMatching, createContact } from '../lib/data/contacts'
import InfoTip from './InfoTip'
import ApproachPicker from './ApproachPicker'
import { matchCandidatesToSignal } from '../lib/candidateMatch'
import { findWarmContacts } from '../lib/companyMatch'
import { logSignalOutcome } from '../lib/signalOutcomes'
import { confirmContact } from '../lib/confirmContact'
import { trackEvent } from '../lib/analytics'
import { SIGNAL_TYPE_META as TYPE_META, RACY_SIGNAL_TYPES as RACY_TYPES } from '../lib/signalTypes'
import { buildOutreachMessage, firstNameOf } from '../lib/outreachMessage'

function timeAgo(dateStr) {
  if (!dateStr) return null
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

function logoColor(name) {
  const colors = ['#0d1b3e', '#b45309', '#1d4ed8', '#15803d', '#a21caf', '#6d28d9']
  let hash = 0
  for (const ch of (name || '')) hash = (hash * 31 + ch.charCodeAt(0)) % colors.length
  return colors[Math.abs(hash) % colors.length]
}

// The "recommended approach" options for one signal, in priority order —
// see ApproachPicker for how these render. A real pipeline match always
// takes the candidate slot over the AI's speculative candidate_angle pitch,
// same priority the card already gave it before this was a picker.
function buildApproaches(s, matches) {
  const approaches = []
  if (matches.length > 0) {
    approaches.push({
      key: 'pipeline',
      icon: '✓',
      label: `${matches.length} in your pipeline`,
      tone: 'match',
      content: `You already have ${matches.length} candidate${matches.length === 1 ? '' : 's'} in your pipeline who could fit this: ${matches.map(c => c.name).join(', ')}`,
    })
  } else if (s.candidate_angle) {
    approaches.push({ key: 'candidate', icon: '🎯', label: 'Lead with a candidate', tone: 'default', content: s.candidate_angle })
  }
  if (s.bench_strength_angle) {
    approaches.push({ key: 'bench', icon: '💪', label: 'Lead with our experience', tone: 'default', content: s.bench_strength_angle })
  }
  return approaches
}

// live_job rows are excluded from `signals` by listActiveSignals itself —
// they're specific open roles behind a hiring push, Today's Actions only,
// per the product decision: they replace the generic hiring_activity
// narrative signal there rather than appearing in both places.
async function loadFeedPageData(userId) {
  const [signals, candidates, contacts] = await Promise.all([
    listActiveSignals(userId),
    // Lightweight, just enough to match against, not the full candidate
    // record. This is what lets a signal say "you already have someone
    // for this" instead of only ever pointing outward for a fresh source.
    listCandidatesForMatching(userId),
    // Same idea for contacts, a warm door beats a cold one every time.
    listContactsForMatching(userId),
  ])
  return { signals, candidates, contacts }
}

export default function IntelligenceFeed() {
  const { user, profile } = useAuth()
  const { data: { signals, candidates, contacts }, loading, setData: setFeedPageData } = useSupabaseQuery(
    () => loadFeedPageData(user.id), [user], { signals: [], candidates: [], contacts: [] },
  )
  const [typeFilter, setTypeFilter] = useState('all')
  const [copiedId, setCopiedId] = useState(null)
  const [approachChoice, setApproachChoice] = useState({})

  function setSignals(updater) {
    setFeedPageData(prev => ({ ...prev, signals: updater(prev.signals) }))
  }

  const newCount = useMemo(() => signals.filter(s => s.status === 'new').length, [signals])
  const visible = useMemo(() => typeFilter === 'all' ? signals : signals.filter(s => s.signal_type === typeFilter), [signals, typeFilter])
  const presentTypes = useMemo(() => [...new Set(signals.map(s => s.signal_type))], [signals])

  // Was computed inline inside the .map() below, for every visible signal,
  // on every render — including a render triggered by clicking "Mark seen"
  // on a single card, which re-ran matchCandidatesToSignal/findWarmContacts
  // (O(signals × candidates) and O(signals × contacts)) for every OTHER
  // card too, not just the one that changed. Memoized here so it only
  // recomputes when the actual inputs change.
  const matchesById = useMemo(() => {
    const map = new Map()
    for (const s of visible) map.set(s.id, matchCandidatesToSignal(s, candidates))
    return map
  }, [visible, candidates])
  const warmContactsById = useMemo(() => {
    const map = new Map()
    for (const s of visible) map.set(s.id, findWarmContacts(s.company_name, contacts))
    return map
  }, [visible, contacts])

  async function markSeen(s) {
    if (s.status !== 'new') return
    await markSignalSeen(s.id)
    setSignals(prev => prev.map(x => x.id === s.id ? { ...x, status: 'seen' } : x))
    logSignalOutcome(user, s, 'seen')
  }

  async function markActioned(s) {
    await markSignalActioned(s.id)
    setSignals(prev => prev.filter(x => x.id !== s.id))
    trackEvent('signal_actioned', { signal_type: s.signal_type, source_verified: !!s.source_verified })
  }

  // The "Mark seen" button is really a dismiss, "not for me", distinct from
  // markActioned's other caller (addToCrm), which means "I acted on this".
  // Logging them differently is exactly the kind of signal a future
  // weighting model needs, a dismissed funding signal in one sector says
  // something different than a contact successfully added from one.
  async function dismiss(s) {
    await markActioned(s)
    logSignalOutcome(user, s, 'dismissed')
  }

  async function addToCrm(s) {
    await createContact({
      name: s.contact_name || s.company_name,
      company: s.company_name,
      title: s.contact_title || null,
      linkedin_url: s.contact_linkedin_url || null,
      email: s.contact_email || null,
      status: 'warm',
      tags: ['from-intelligence-feed'],
    }, user.id)
    await markActioned(s)
    logSignalOutcome(user, s, 'added_to_crm')
    // A customer accepting this contact into their own CRM is a real human
    // confirming Apollo's guess was right — feed that back into the shared
    // cache so it's both cheaper and more trustworthy for the next customer
    // who hits this same company + role.
    confirmContact(s)
  }

  // Safety net for signals written before introMessage existed (or on the
  // rare case the AI left it blank) — not as good as a real one, but still
  // usable, so "Copy message" always has something worth copying. Body text
  // only, same contract as the AI-written field: buildOutreachMessage adds
  // the actual greeting and sign-off, this never should.
  function fallbackIntroMessage(s, matches, warmContacts) {
    const matchLine = matches?.length ? ` I'm currently working with candidates who'd be a strong fit for this.` : ''
    const warmLine = warmContacts?.length ? ` We're already connected, so I wanted to reach out directly rather than cold.` : ''
    const firmLine = profile?.firm_name ? `I work for a recruitment firm called ${profile.firm_name}.` : `I work in recruitment.`
    const insight = s.why_it_matters || 'it looks like a real opportunity worth exploring together.'
    return `I hope you are doing well.\n\n${firmLine} I saw the news about ${s.headline} at ${s.company_name}. ${insight}${matchLine}${warmLine}\n\nWould you be open to a call to discuss in more detail?`
  }

  // The one message actually shown/copied: a real greeting addressed to the
  // verified contact by name when we have one, Annie's own body text for
  // this signal, and a sign-off that introduces the sender by name and firm
  // — see outreachMessage.js for why this is composed here rather than left
  // to the AI prompt.
  function fullIntroMessage(s, matches, warmContacts) {
    const body = s.intro_message || fallbackIntroMessage(s, matches, warmContacts)
    return buildOutreachMessage({
      body,
      contactFirstName: s.contact_verified ? firstNameOf(s.contact_name) : '',
      senderFirstName: firstNameOf(profile?.full_name),
      firmName: profile?.firm_name || '',
    })
  }

  // Copies the ready-to-send message to the clipboard right where the
  // recruiter is reading it — this used to hand off to the chat assistant
  // on a different page to draft something from scratch, but now that
  // Annie already writes a finished message as part of the signal itself,
  // there's nothing left to draft, just something to send.
  async function copyIntroMessage(s, matches, warmContacts) {
    const text = fullIntroMessage(s, matches, warmContacts)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard permission can fail quietly in some browsers/contexts —
      // the message is still shown on the card either way, so it can
      // always be selected and copied by hand even if the button can't.
    }
    setCopiedId(s.id)
    logSignalOutcome(user, s, 'outreach_drafted')
    setTimeout(() => setCopiedId(c => (c === s.id ? null : c)), 2000)
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            Intelligence Feed
            <InfoTip text="Annie researches your sectors and markets in the background every few hours, this is everything she's found, newest first. Today's Actions pulls its best picks from the same list." />
          </h1>
          <p className="text-gray-500 mt-1">Newest first, exactly when it happened. Annie's already watching, even when you're not looking.</p>
        </div>
        {newCount > 0 && <span className="bg-navy text-gold text-xs font-bold px-3.5 py-2 rounded-full whitespace-nowrap">{newCount} new</span>}
      </div>

      {/* A row of one pill per signal type got crowded and wrapped onto a
          second line once a customer's feed had enough variety in it (8+
          types) — a single compact dropdown stays one line and scales to
          however many types show up, present or future, without needing a
          redesign at some new count. */}
      {presentTypes.length > 1 && (
        <div className="flex items-center gap-2 mb-5">
          <label htmlFor="signal-type-filter" className="text-xs font-semibold text-gray-500">Filter by type</label>
          <select
            id="signal-type-filter"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            className="text-xs font-semibold border-2 border-gray-200 rounded-lg pl-3 pr-8 py-2 text-navy bg-white hover:border-gray-300 focus:outline-none focus:border-navy cursor-pointer"
          >
            <option value="all">All ({signals.length})</option>
            {presentTypes.map(t => (
              <option key={t} value={t}>{(TYPE_META[t]?.icon ? TYPE_META[t].icon + ' ' : '') + (TYPE_META[t]?.label || t)}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" /></div>
      ) : visible.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-bold text-navy mb-1">Nothing here yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">Annie scans your sectors and markets every few hours in the background. Check back soon, or import your LinkedIn contacts so she has more to watch.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(s => {
            const meta = TYPE_META[s.signal_type] || { label: s.signal_type, icon: '📌', color: 'text-gray-700 bg-gray-100' }
            const unread = s.status === 'new'
            const timeSensitive = RACY_TYPES.includes(s.signal_type) && (Date.now() - new Date(s.found_at).getTime()) < 3 * 86400000
            const matches = matchesById.get(s.id) || []
            const warmContacts = warmContactsById.get(s.id) || []
            return (
              <div
                key={s.id}
                onClick={() => markSeen(s)}
                className={`card p-4 relative cursor-pointer ${unread ? 'bg-yellow-50/40 border-gold/40' : ''}`}
              >
                {unread && <div className="absolute left-0 top-3 bottom-3 w-[3px] bg-gold rounded-full" />}
                <div className="flex items-center gap-2.5 mb-2.5">
                  {s.company_logo_url ? (
                    <img src={s.company_logo_url} alt="" className="w-8 h-8 rounded-lg object-cover flex-shrink-0" onError={e => { e.target.style.display = 'none' }} />
                  ) : (
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-[11px] font-bold flex-shrink-0" style={{ backgroundColor: logoColor(s.company_name) }}>
                      {initials(s.company_name)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-navy text-sm font-bold">{s.company_name}</span>
                      {unread && <span className="text-[8px] font-bold text-white bg-gold rounded-full px-1.5 py-0.5 uppercase">New</span>}
                    </div>
                    {(s.company_industry || s.company_city || s.company_country) && (
                      <div className="text-[11px] text-gray-400">{[s.company_industry, [s.company_city, s.company_country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</div>
                    )}
                  </div>
                  <span className={`text-[9px] font-bold uppercase tracking-wide px-2 py-1 rounded-md flex-shrink-0 ${meta.color}`}>{meta.icon} {meta.label}</span>
                </div>

                <h3 className="text-navy text-[13px] font-semibold leading-snug mb-1.5 flex items-center gap-1.5 flex-wrap">
                  {s.headline}
                  {s.ch_verified && (
                    <span className="text-[9px] font-bold text-white bg-emerald-600 rounded-full px-2 py-0.5 uppercase tracking-wide" title={s.ch_verified_detail || ''}>
                      ✓ Verified, Companies House
                    </span>
                  )}
                </h3>
                {s.why_it_matters && <p className="text-gray-600 text-xs italic border-l-2 border-gold pl-2.5 mb-2.5 leading-relaxed">{s.why_it_matters}</p>}
                {s.ch_verified_detail && <p className="text-[10.5px] text-emerald-700 mb-2.5">🏛️ {s.ch_verified_detail}</p>}
                {timeSensitive && <p className="text-[10px] text-amber-700 font-semibold mb-2.5">⚡ Time-sensitive, worth acting on before someone else does</p>}

                {warmContacts.length > 0 && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-2 flex flex-wrap gap-x-1.5">
                    <p className="text-[11px] font-semibold text-blue-800">
                      🤝 Warm door: you already know {warmContacts.map(c => c.name).join(', ')} at {s.company_name}, {warmContacts.length === 1 ? 'a real connection' : 'real connections'} beats a cold approach.
                    </p>
                  </div>
                )}

                {s.contact_verified && (
                  <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-2.5">
                    <span className="text-[9px] font-bold text-green-700 uppercase tracking-wider">Verified via Apollo</span>
                    <p className="text-xs font-semibold text-navy mt-0.5">{s.contact_name}{s.contact_title ? `, ${s.contact_title}` : ''}</p>
                    <div className="flex items-center gap-2.5 mt-0.5 flex-wrap" onClick={e => e.stopPropagation()}>
                      {s.contact_email && <a href={`mailto:${s.contact_email}`} className="text-[11px] text-blue-600 hover:underline">{s.contact_email}</a>}
                      {s.contact_linkedin_url && <a href={s.contact_linkedin_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline">View LinkedIn profile</a>}
                    </div>
                  </div>
                )}

                <ApproachPicker
                  approaches={buildApproaches(s, matches)}
                  selectedKey={approachChoice[s.id]}
                  onSelect={key => setApproachChoice(prev => ({ ...prev, [s.id]: key }))}
                />

                {/* This is the one thing on the card meant to be used
                    as-is, not just read — a distinct navy block with a
                    bold gold action button so it reads as "push this",
                    not as another line among the small text links below. */}
                <div className="bg-navy rounded-lg px-4 py-3 mb-2.5" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                    <span className="text-[10px] font-bold text-gold uppercase tracking-wider">✉️ Ready-to-send message</span>
                    <button
                      onClick={() => copyIntroMessage(s, matches, warmContacts)}
                      title="Copies this message to your clipboard, ready to paste into an email or LinkedIn message — nothing to draft, nothing to leave this page for."
                      className="text-xs font-bold px-4 py-2 rounded-md bg-gold text-navy hover:bg-gold/90 flex-shrink-0 transition-colors"
                    >
                      {copiedId === s.id ? '✓ Copied!' : '📋 Copy message'}
                    </button>
                  </div>
                  <p className="text-white/90 text-[11.5px] leading-relaxed whitespace-pre-line">{fullIntroMessage(s, matches, warmContacts)}</p>
                </div>

                <div className="flex items-center gap-3 mb-2.5 flex-wrap">
                  <span className="text-[10px] text-gray-400 bg-page-bg rounded-md px-2 py-1">🔍 Annie found this {timeAgo(s.found_at)}</span>
                  {s.event_at && <span className="text-[10px] text-gray-400 bg-page-bg rounded-md px-2 py-1">📅 Actually happened {timeAgo(s.event_at)}</span>}
                  {/* Blocker #5 from the pre-launch audit: nothing distinguished an
                      independently-confirmed signal from pure AI self-report. This
                      reflects source_verified (the source link actually resolves,
                      checked server-side before the row was written) so that
                      distinction is visible per-signal instead of everything looking
                      equally trustworthy. */}
                  {s.source_verified ? (
                    <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1 font-medium">✓ Source verified</span>
                  ) : (
                    <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1 font-medium">AI-reported, unverified</span>
                  )}
                </div>

                <div className="flex items-center justify-between flex-wrap gap-2" onClick={e => e.stopPropagation()}>
                  {s.source_url ? (
                    <a href={s.source_url} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline">🔗 {s.source_label || s.source_url}</a>
                  ) : <span />}
                  <div className="flex gap-1.5">
                    <button onClick={() => dismiss(s)} className="text-[10px] font-semibold px-2.5 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50">Mark seen</button>
                    <button onClick={() => addToCrm(s)} className="text-[10px] font-semibold px-2.5 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50">Add to CRM</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

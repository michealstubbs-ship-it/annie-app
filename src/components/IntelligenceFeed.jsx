import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import InfoTip from './InfoTip'
import { matchCandidatesToSignal } from '../lib/candidateMatch'
import { findWarmContacts } from '../lib/companyMatch'
import { logSignalOutcome } from '../lib/signalOutcomes'

const TYPE_META = {
  funding: { label: 'Funding', icon: '💰', color: 'text-amber-700 bg-amber-100' },
  leadership_change: { label: 'Leadership change', icon: '👤', color: 'text-blue-700 bg-blue-100' },
  hiring_activity: { label: 'Hiring activity', icon: '📈', color: 'text-green-700 bg-green-100' },
  expansion: { label: 'Expansion', icon: '🌍', color: 'text-teal-700 bg-teal-100' },
  team_building: { label: 'Team building', icon: '💬', color: 'text-fuchsia-700 bg-fuchsia-100' },
  public_commentary: { label: 'Public commentary', icon: '🎙️', color: 'text-purple-700 bg-purple-100' },
  job_posting_unclaimed: { label: 'Unclaimed role', icon: '📋', color: 'text-orange-700 bg-orange-100' },
  m_and_a: { label: 'M&A', icon: '🤝', color: 'text-indigo-700 bg-indigo-100' },
  regulatory: { label: 'Regulatory', icon: '📜', color: 'text-slate-700 bg-slate-100' },
}

const RACY_TYPES = ['job_posting_unclaimed', 'team_building', 'hiring_activity', 'expansion']

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

export default function IntelligenceFeed() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [signals, setSignals] = useState([])
  const [candidates, setCandidates] = useState([])
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('all')

  useEffect(() => { load() }, [user])

  async function load() {
    setLoading(true)
    const [{ data }, { data: cands }, { data: conts }] = await Promise.all([
      supabase
        .from('intelligence_signals')
        .select('*')
        .eq('user_id', user.id)
        .neq('status', 'actioned')
        .order('found_at', { ascending: false })
        .limit(200),
      // Lightweight, just enough to match against, not the full candidate
      // record. This is what lets a signal say "you already have someone
      // for this" instead of only ever pointing outward for a fresh source.
      supabase.from('candidates').select('id, name, role, industry, status').eq('user_id', user.id),
      // Same idea for contacts, a warm door beats a cold one every time.
      supabase.from('contacts').select('id, name, title, company, linkedin_url').eq('user_id', user.id),
    ])
    setSignals(data || [])
    setCandidates(cands || [])
    setContacts(conts || [])
    setLoading(false)
  }

  const newCount = useMemo(() => signals.filter(s => s.status === 'new').length, [signals])
  const visible = useMemo(() => typeFilter === 'all' ? signals : signals.filter(s => s.signal_type === typeFilter), [signals, typeFilter])
  const presentTypes = useMemo(() => [...new Set(signals.map(s => s.signal_type))], [signals])

  async function markSeen(s) {
    if (s.status !== 'new') return
    await supabase.from('intelligence_signals').update({ status: 'seen' }).eq('id', s.id)
    setSignals(prev => prev.map(x => x.id === s.id ? { ...x, status: 'seen' } : x))
    logSignalOutcome(user, s, 'seen')
  }

  async function markActioned(s) {
    await supabase.from('intelligence_signals').update({ status: 'actioned' }).eq('id', s.id)
    setSignals(prev => prev.filter(x => x.id !== s.id))
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
    await supabase.from('contacts').insert({
      user_id: user.id,
      name: s.contact_name || s.company_name,
      company: s.company_name,
      title: s.contact_title || null,
      linkedin_url: s.contact_linkedin_url || null,
      status: 'warm',
      tags: ['from-intelligence-feed'],
    })
    await markActioned(s)
    logSignalOutcome(user, s, 'added_to_crm')
  }

  function draftOutreach(s, matches, warmContacts) {
    const matchLine = matches?.length
      ? ` I already have these candidates in my pipeline who could fit: ${matches.map(c => c.name).join(', ')}, lead with whichever fits best.`
      : ''
    const warmLine = warmContacts?.length
      ? ` I already know ${warmContacts.map(c => c.name).join(', ')} at ${s.company_name}, help me draft a warm intro-style message to them instead of a cold one.`
      : ''
    const prefill = `Help me draft outreach about this: ${s.headline} at ${s.company_name}. ${s.why_it_matters || ''} ${s.who_to_approach ? 'Who to approach: ' + s.who_to_approach : ''}${warmLine}${matchLine}`.trim()
    logSignalOutcome(user, s, 'outreach_drafted')
    navigate('/dashboard/chat', { state: { prefill } })
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

      {presentTypes.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-5">
          <button onClick={() => setTypeFilter('all')} className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${typeFilter === 'all' ? 'bg-navy border-navy text-white' : 'border-gray-200 text-gray-600'}`}>All</button>
          {presentTypes.map(t => (
            <button key={t} onClick={() => setTypeFilter(t)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${typeFilter === t ? 'bg-navy border-navy text-white' : 'border-gray-200 text-gray-600'}`}>
              {TYPE_META[t]?.label || t}
            </button>
          ))}
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
            const matches = matchCandidatesToSignal(s, candidates)
            const warmContacts = findWarmContacts(s.company_name, contacts)
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

                {matches.length > 0 ? (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-2.5">
                    <p className="text-[11px] font-semibold text-emerald-800">
                      ✓ You already have {matches.length} candidate{matches.length === 1 ? '' : 's'} in your pipeline who could fit this: {matches.map(c => c.name).join(', ')}
                    </p>
                  </div>
                ) : s.candidate_angle && (
                  <div className="bg-page-bg rounded-lg px-3 py-2 mb-2.5">
                    <p className="text-[11px] text-gray-500"><span className="font-semibold text-navy">Candidate angle to lead with:</span> {s.candidate_angle}</p>
                  </div>
                )}

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
                    <button onClick={() => draftOutreach(s, matches, warmContacts)} className="text-[10px] font-semibold px-2.5 py-1.5 rounded-md bg-navy text-white hover:bg-navy/90">Draft outreach</button>
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

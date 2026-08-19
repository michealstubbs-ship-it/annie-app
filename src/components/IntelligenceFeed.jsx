import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import InfoTip from './InfoTip'

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
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('all')

  useEffect(() => { load() }, [user])

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('intelligence_signals')
      .select('*')
      .eq('user_id', user.id)
      .neq('status', 'actioned')
      .order('found_at', { ascending: false })
      .limit(200)
    setSignals(data || [])
    setLoading(false)
  }

  const newCount = useMemo(() => signals.filter(s => s.status === 'new').length, [signals])
  const visible = useMemo(() => typeFilter === 'all' ? signals : signals.filter(s => s.signal_type === typeFilter), [signals, typeFilter])
  const presentTypes = useMemo(() => [...new Set(signals.map(s => s.signal_type))], [signals])

  async function markSeen(s) {
    if (s.status !== 'new') return
    await supabase.from('intelligence_signals').update({ status: 'seen' }).eq('id', s.id)
    setSignals(prev => prev.map(x => x.id === s.id ? { ...x, status: 'seen' } : x))
  }

  async function markActioned(s) {
    await supabase.from('intelligence_signals').update({ status: 'actioned' }).eq('id', s.id)
    setSignals(prev => prev.filter(x => x.id !== s.id))
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
  }

  function draftOutreach(s) {
    const prefill = `Help me draft outreach about this: ${s.headline} at ${s.company_name}. ${s.why_it_matters || ''} ${s.who_to_approach ? 'Who to approach: ' + s.who_to_approach : ''}`.trim()
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

                <h3 className="text-navy text-[13px] font-semibold leading-snug mb-1.5">{s.headline}</h3>
                {s.why_it_matters && <p className="text-gray-600 text-xs italic border-l-2 border-gold pl-2.5 mb-2.5 leading-relaxed">{s.why_it_matters}</p>}
                {timeSensitive && <p className="text-[10px] text-amber-700 font-semibold mb-2.5">⚡ Time-sensitive, worth acting on before someone else does</p>}

                <div className="flex items-center gap-3 mb-2.5 flex-wrap">
                  <span className="text-[10px] text-gray-400 bg-page-bg rounded-md px-2 py-1">🔍 Annie found this {timeAgo(s.found_at)}</span>
                  {s.event_at && <span className="text-[10px] text-gray-400 bg-page-bg rounded-md px-2 py-1">📅 Actually happened {timeAgo(s.event_at)}</span>}
                </div>

                <div className="flex items-center justify-between flex-wrap gap-2" onClick={e => e.stopPropagation()}>
                  {s.source_url ? (
                    <a href={s.source_url} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline">🔗 {s.source_label || s.source_url}</a>
                  ) : <span />}
                  <div className="flex gap-1.5">
                    <button onClick={() => markActioned(s)} className="text-[10px] font-semibold px-2.5 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50">Mark seen</button>
                    <button onClick={() => addToCrm(s)} className="text-[10px] font-semibold px-2.5 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50">Add to CRM</button>
                    <button onClick={() => draftOutreach(s)} className="text-[10px] font-semibold px-2.5 py-1.5 rounded-md bg-navy text-white hover:bg-navy/90">Draft outreach</button>
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

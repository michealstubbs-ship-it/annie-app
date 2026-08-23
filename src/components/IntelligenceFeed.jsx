import React, { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useSupabaseQuery } from '../lib/useSupabaseQuery'
import { listActiveSignals, markSignalSeen, markSignalActioned, markSignalManuallyAdded } from '../lib/data/signals'
import InfoTip from './InfoTip'
import CompanyLogo from './CompanyLogo'
import { logSignalOutcome } from '../lib/signalOutcomes'
import { trackEvent } from '../lib/analytics'
import { SIGNAL_TYPE_META as TYPE_META, RACY_SIGNAL_TYPES as RACY_TYPES } from '../lib/signalTypes'

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

// live_job rows are excluded from `signals` by listActiveSignals itself —
// they're specific open roles behind a hiring push, Today's Actions only,
// per the product decision: they replace the generic hiring_activity
// narrative signal there rather than appearing in both places.
async function loadFeedPageData(userId) {
  const signals = await listActiveSignals(userId)
  return { signals }
}

export default function IntelligenceFeed() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { data: { signals }, loading, setData: setFeedPageData } = useSupabaseQuery(
    () => loadFeedPageData(user.id), [user], { signals: [] },
  )
  const [typeFilter, setTypeFilter] = useState('all')
  const [addedId, setAddedId] = useState(null)

  function setSignals(updater) {
    setFeedPageData(prev => ({ ...prev, signals: updater(prev.signals) }))
  }

  const newCount = useMemo(() => signals.filter(s => s.status === 'new').length, [signals])
  const visible = useMemo(() => typeFilter === 'all' ? signals : signals.filter(s => s.signal_type === typeFilter), [signals, typeFilter])
  const presentTypes = useMemo(() => [...new Set(signals.map(s => s.signal_type))], [signals])

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

  // "Mark seen" is really a dismiss, "not for me" — distinct from adding to
  // Today's BD Actions, which means "I want to act on this". Logging them
  // differently is exactly the kind of signal a future weighting model
  // needs: a dismissed funding signal in one sector says something
  // different than one a recruiter chose to pursue.
  async function dismiss(s) {
    await markActioned(s)
    logSignalOutcome(user, s, 'dismissed')
  }

  // The one thing this button does: flag the signal as manually added (see
  // markSignalManuallyAdded / actionsEngine.js's bypass rule) so it reliably
  // shows up in Today's BD Actions regardless of score or age, no AI call,
  // no waiting — the full recommendation (who to approach, candidate
  // profile, ready-to-send message) was already written by Annie's scan
  // when this signal was found. Doesn't mark it 'actioned', so it can still
  // be found and fully worked from Today's Actions.
  async function addToTodaysActions(s) {
    if (s.manually_added_at) return
    await markSignalManuallyAdded(s.id)
    setSignals(prev => prev.map(x => x.id === s.id ? { ...x, manually_added_at: new Date().toISOString() } : x))
    logSignalOutcome(user, s, 'added_to_bd_actions')
    trackEvent('signal_added_to_bd_actions', { signal_type: s.signal_type })
    setAddedId(s.id)
    setTimeout(() => navigate('/dashboard/actions'), 650)
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
            return (
              <div
                key={s.id}
                onClick={() => markSeen(s)}
                className={`card p-4 relative cursor-pointer ${unread ? 'bg-yellow-50/40 border-gold/40' : ''}`}
              >
                {unread && <div className="absolute left-0 top-3 bottom-3 w-[3px] bg-gold rounded-full" />}
                <div className="flex items-center gap-2.5 mb-2.5">
                  <CompanyLogo name={s.company_name} logoUrl={s.company_logo_url} />
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

                {/* Pure news from here down — no contact box, no candidate
                    profile, no ready-to-send message. Those only live in
                    Today's BD Actions now, once a signal actually moves
                    there, so nothing here duplicates what that page shows. */}
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
                    {s.manually_added_at ? (
                      <span className="text-[10px] font-semibold px-2.5 py-1.5 rounded-md border border-green-200 bg-green-50 text-green-700">✓ In Today's BD Actions</span>
                    ) : (
                      <button
                        onClick={() => addToTodaysActions(s)}
                        title="Moves this into Today's BD Actions with the full recommendation already prepared: who to approach, a candidate profile to search for, and a ready-to-send message."
                        className={`text-[10px] font-bold px-2.5 py-1.5 rounded-md border transition-colors ${addedId === s.id ? 'border-green-200 bg-green-50 text-green-700' : 'border-gold/40 bg-yellow-50 text-gold-ink hover:bg-yellow-100'}`}
                      >
                        {addedId === s.id ? '✓ Added, nothing to generate' : '＋ Add to Today\'s BD Actions'}
                      </button>
                    )}
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

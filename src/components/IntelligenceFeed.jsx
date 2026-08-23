import React, { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useSupabaseQuery } from '../lib/useSupabaseQuery'
import { listActiveSignals, markSignalSeen, markSignalActioned, markSignalManuallyAdded } from '../lib/data/signals'
import InfoTip from './InfoTip'
import CompanyLogo from './CompanyLogo'
import { logSignalOutcome } from '../lib/signalOutcomes'
import { trackEvent } from '../lib/analytics'
import { SIGNAL_TYPE_META as TYPE_META, RACY_SIGNAL_TYPES as RACY_TYPES, NEWS_SIGNAL_TYPES } from '../lib/signalTypes'

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
  // M&A, regulatory, and public commentary are market intel, not something
  // to act on — they never belonged mixed into the same scrollable timeline
  // as everything else worth pursuing. Split client-side, same underlying
  // fetch (listActiveSignals): no separate query, no separate loading state,
  // just two different slices of the one signals array already in memory.
  const [mainTab, setMainTab] = useState('signals')
  const [typeFilter, setTypeFilter] = useState('all')
  const [addedId, setAddedId] = useState(null)

  function setSignals(updater) {
    setFeedPageData(prev => ({ ...prev, signals: updater(prev.signals) }))
  }

  const newCount = useMemo(() => signals.filter(s => s.status === 'new').length, [signals])
  const tabSignals = useMemo(
    () => signals.filter(s => mainTab === 'news' ? NEWS_SIGNAL_TYPES.includes(s.signal_type) : !NEWS_SIGNAL_TYPES.includes(s.signal_type)),
    [signals, mainTab],
  )
  const visible = useMemo(() => typeFilter === 'all' ? tabSignals : tabSignals.filter(s => s.signal_type === typeFilter), [tabSignals, typeFilter])
  const presentTypes = useMemo(() => [...new Set(tabSignals.map(s => s.signal_type))], [tabSignals])
  const newsCount = useMemo(() => signals.filter(s => NEWS_SIGNAL_TYPES.includes(s.signal_type)).length, [signals])

  // The type-filter chip only ever makes sense scoped to whichever tab is
  // active (no point offering an "M&A" chip while looking at the Signals
  // tab) — switching tabs resets it back to "all" rather than carrying over
  // a filter that might not even apply to the new tab's types.
  function switchTab(tab) {
    setMainTab(tab)
    setTypeFilter('all')
  }

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
    if (s.manually_added_at || NEWS_SIGNAL_TYPES.includes(s.signal_type)) return
    await markSignalManuallyAdded(s.id)
    setSignals(prev => prev.map(x => x.id === s.id ? { ...x, manually_added_at: new Date().toISOString() } : x))
    logSignalOutcome(user, s, 'added_to_bd_actions')
    trackEvent('signal_added_to_bd_actions', { signal_type: s.signal_type })
    setAddedId(s.id)
    setTimeout(() => navigate('/dashboard/actions'), 650)
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-extrabold text-navy flex items-center">
            Intelligence Feed
            <InfoTip text="Annie researches your sectors and markets in the background every few hours, this is everything she's found, newest first. Today's Actions pulls its best picks from the same list." />
          </h1>
          <p className="text-gray-500 text-[13px] mt-0.5">Newest first, exactly when it happened. Annie's already watching, even when you're not looking.</p>
        </div>
        {newCount > 0 && <span className="bg-navy text-gold text-xs font-bold px-3.5 py-2 rounded-full whitespace-nowrap">{newCount} new</span>}
      </div>

      {/* The "this feed is just the news" explainer — matches Today's Actions
          having the same signal available manually, tells the person up
          front that nothing here demands a reply the way an action does. */}
      <div className="flex gap-3.5 items-center mb-4 px-5 py-4 rounded-2xl bg-gradient-to-br from-navy to-navy-light shadow-[0_6px_20px_rgba(13,27,62,0.22)]">
        <div className="w-10 h-10 rounded-full bg-gold flex items-center justify-center text-lg flex-shrink-0 shadow-[0_2px_8px_rgba(201,168,76,0.4)]">⚡</div>
        <div>
          <p className="text-white text-sm font-extrabold mb-0.5 tracking-tight">This feed is just the news, no prompts live here.</p>
          <p className="text-white/80 text-[12.5px] leading-relaxed max-w-[600px]">Found something worth pursuing? Tap <b className="text-gold font-bold">Add to Today's BD Actions</b> on any post, Annie already wrote the full recommendation when she found it, so it moves over instantly: who to approach, a candidate profile to search for, and a ready-to-send message.</p>
        </div>
      </div>

      {/* Signals vs News — the same split Today's Actions makes: M&A,
          regulatory, and public commentary are worth knowing, never worth
          acting on, so they get their own place to browse instead of
          diluting the timeline of things actually worth pursuing. */}
      <div className="flex gap-0 border-b-2 border-gray-200 mb-4">
        <button
          onClick={() => switchTab('signals')}
          className={`px-1.5 py-2.5 mr-[22px] text-[13.5px] font-bold border-b-2 -mb-0.5 transition-colors ${mainTab === 'signals' ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'}`}
        >
          Signals
        </button>
        <button
          onClick={() => switchTab('news')}
          className={`px-1.5 py-2.5 text-[13.5px] font-bold border-b-2 -mb-0.5 transition-colors ${mainTab === 'news' ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'}`}
        >
          News {newsCount > 0 && <span className="text-xs font-semibold">({newsCount})</span>}
        </button>
      </div>

      {/* A chip per signal type, same idea as a dropdown (scales to however
          many types show up, present or future) but scannable at a glance
          and matches the rest of this page's "scroll a timeline" feel
          better than a form control does. */}
      {presentTypes.length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 mb-4">
          <button
            onClick={() => setTypeFilter('all')}
            className={`flex-shrink-0 text-[12.5px] font-bold px-3.5 py-1.5 rounded-full border transition-colors whitespace-nowrap ${typeFilter === 'all' ? 'bg-navy text-gold border-navy' : 'bg-page-bg text-gray-600 border-gray-200 hover:border-gray-300'}`}
          >
            All
          </button>
          {presentTypes.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`flex-shrink-0 text-[12.5px] font-bold px-3.5 py-1.5 rounded-full border transition-colors whitespace-nowrap ${typeFilter === t ? 'bg-navy text-gold border-navy' : 'bg-page-bg text-gray-600 border-gray-200 hover:border-gray-300'}`}
            >
              {(TYPE_META[t]?.icon ? TYPE_META[t].icon + ' ' : '') + (TYPE_META[t]?.chipLabel || TYPE_META[t]?.label || t)}
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
        <div className="bg-white rounded-2xl shadow-[0_1px_2px_rgba(13,27,62,0.06),0_1px_6px_rgba(13,27,62,0.04)] overflow-hidden">
          {visible.map(s => {
            const meta = TYPE_META[s.signal_type] || { label: s.signal_type, icon: '📌', color: 'text-gray-700 bg-gray-100' }
            const unread = s.status === 'new'
            const timeSensitive = RACY_TYPES.includes(s.signal_type) && (Date.now() - new Date(s.found_at).getTime()) < 3 * 86400000
            return (
              <div
                key={s.id}
                onClick={() => markSeen(s)}
                className={`relative cursor-pointer px-4 py-3.5 border-b border-gray-200 last:border-b-0 ${unread ? 'bg-gold/[0.045]' : ''}`}
              >
                {unread && <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-gold" />}
                <div className="flex gap-3">
                  <CompanyLogo name={s.company_name} logoUrl={s.company_logo_url} size="w-[42px] h-[42px]" textSize="text-[13px]" rounded="rounded-full" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-navy text-sm font-extrabold">{s.company_name}</span>
                      {s.ch_verified && (
                        <span
                          className="w-[15px] h-[15px] rounded-full bg-gold text-navy text-[9px] font-extrabold flex items-center justify-center flex-shrink-0"
                          title={s.ch_verified_detail || 'Verified, Companies House'}
                        >✓</span>
                      )}
                      <span className="text-gray-400 text-sm">· {[s.company_industry, [s.company_city, s.company_country].filter(Boolean).join(', ')].filter(Boolean).join(', ') || 'Company'}</span>
                      {unread && <span className="text-[8px] font-bold text-white bg-gold rounded-full px-1.5 py-0.5 uppercase">New</span>}
                      <span className="text-gray-400 text-xs font-semibold ml-auto flex-shrink-0 whitespace-nowrap">Found {timeAgo(s.found_at)}</span>
                    </div>

                    <div className="mt-1.5">
                      <span className={`inline-block text-[10.5px] font-bold px-2 py-0.5 rounded-full mr-1.5 ${meta.feedTopicColor || 'bg-[#eef1fb] text-navy-light'}`}>{meta.icon} {meta.label}</span>
                      {s.event_at && <span className="text-[11px] font-semibold text-gray-400">📅 {timeSensitive ? 'Happened' : 'Happened'} {timeAgo(s.event_at)}</span>}
                    </div>

                    <p className="text-gray-800 text-[14.5px] leading-snug mt-1">{s.headline}</p>
                    {s.why_it_matters && <p className="text-gray-500 text-[13px] leading-relaxed mt-1">{s.why_it_matters}</p>}
                    {s.ch_verified_detail && <p className="text-[10.5px] text-emerald-700 mt-1.5">🏛️ {s.ch_verified_detail}</p>}
                    {timeSensitive && <p className="text-[10px] text-amber-700 font-semibold mt-1.5">⚡ Time-sensitive, worth acting on before someone else does</p>}

                    {/* Blocker #5 from the pre-launch audit: nothing distinguished an
                        independently-confirmed signal from pure AI self-report. This
                        reflects source_verified (the source link actually resolves,
                        checked server-side before the row was written) so that
                        distinction is visible per-signal instead of everything looking
                        equally trustworthy. */}
                    <div className="flex items-center gap-5 flex-wrap mt-2.5" onClick={e => e.stopPropagation()}>
                      {s.source_verified ? (
                        <span className="flex items-center gap-1.5 text-green-700 text-xs font-semibold">✓ Source verified</span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-gray-400 text-xs font-semibold">📰 AI-reported</span>
                      )}
                      {NEWS_SIGNAL_TYPES.includes(s.signal_type) ? (
                        // M&A/regulatory/public commentary are market intel by design,
                        // background awareness, never a BD trigger — actionsEngine.js
                        // excludes all of NEWS_SIGNAL_TYPES from Today's Actions outright,
                        // so offering this button here would just be a dead end. No
                        // button at all, rather than one that silently does nothing.
                        <span className="flex items-center gap-1.5 text-gray-400 text-xs font-semibold italic">Market intel, not a BD action</span>
                      ) : s.manually_added_at ? (
                        <span className="flex items-center gap-1.5 text-green-700 bg-green-50 border border-green-200 font-bold text-xs px-2.5 py-1.5 rounded-full">✓ In Today's BD Actions</span>
                      ) : (
                        <button
                          onClick={() => addToTodaysActions(s)}
                          title="Moves this into Today's BD Actions with the full recommendation already prepared: who to approach, a candidate profile to search for, and a ready-to-send message."
                          className={`flex items-center gap-1.5 font-bold text-xs px-2.5 py-1.5 rounded-full border transition-colors ${addedId === s.id ? 'border-green-200 bg-green-50 text-green-700' : 'border-transparent bg-[#fbf4e2] text-gold-ink hover:bg-[#f5e9c8]'}`}
                        >
                          {addedId === s.id ? '✓ Added, nothing to generate' : '＋ Add to Today\'s BD Actions'}
                        </button>
                      )}
                      {s.source_url && (
                        <a href={s.source_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-gray-400 text-xs font-semibold hover:underline">🔗 {s.source_label || 'Source'}</a>
                      )}
                      <button onClick={() => dismiss(s)} className="ml-auto flex items-center gap-1.5 text-gray-400 text-xs font-semibold hover:text-navy">Mark seen</button>
                    </div>
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

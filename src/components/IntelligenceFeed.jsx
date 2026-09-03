import React, { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useSupabaseQuery } from '../lib/useSupabaseQuery'
import { listActiveSignals, markSignalSeen, markSignalActioned, markSignalManuallyAdded } from '../lib/data/signals'
import InfoTip from './InfoTip'
import CompanyLogo from './CompanyLogo'
import { logSignalOutcome } from '../lib/signalOutcomes'
import { trackEvent } from '../lib/analytics'
import { resolveSignalContact } from '../lib/resolveSignalContact'
import { SIGNAL_TYPE_META as TYPE_META, RACY_SIGNAL_TYPES as RACY_TYPES, NEWS_SIGNAL_TYPES } from '../lib/signalTypes'
import { collapseFeedDuplicates } from '../lib/intelligenceFeedDedup'
import Spinner from './Spinner'
import ErrorBanner from './ErrorBanner'

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

// 2026-09-03, Michael: live_job used to only ever get a conditional filter
// chip inside the "Signals" tab (only appearing at all once presentTypes
// had more than one type present) — not what Michael actually asked for
// back on 2026-09-02 ("it should show up here as Live job in its own tab
// and always filter into today's actions", see this file's git history).
// A chip that only sometimes renders is not "its own tab": it doesn't
// exist when it's the only type present, it's not reachable by URL/deep
// link, and it disappears from view the instant you're looking at News.
// live_job now gets a real third tab, always visible (same pattern as
// News below: a persistent button, a count badge, never conditional on
// what else happens to be in the feed), and is excluded from the
// "Signals" tab's own list — moved, not duplicated, exactly like
// NEWS_SIGNAL_TYPES already is.
async function loadFeedPageData(userId) {
  const signals = await listActiveSignals(userId)
  return { signals }
}

export default function IntelligenceFeed() {
  const { user } = useAuth()
  const navigate = useNavigate()
  // 2026-08-26 audit fix: listActiveSignals now throws on a real Supabase
  // error instead of quietly returning [] — useSupabaseQuery already
  // catches that into its own `error` state, this just needed to actually
  // be surfaced (see the `error` state below, shared with the mark-seen/
  // mark-actioned/add-to-actions write failures).
  const { data: { signals }, loading, error: loadError, setData: setFeedPageData } = useSupabaseQuery(
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
  // 2026-08-26: the real flaw Michael flagged — a manual "Add to Today's BD
  // Actions" click on a signal with no contact used to silently do nothing
  // (isEligibleSourced/isEligibleRelationship never bypassed the
  // mandatory-contact requirement, only the type whitelist did). resolvingId
  // marks the one click currently trying a live, real Apollo re-search;
  // noContactId marks the one that just tried and genuinely found nobody, so
  // that's said honestly instead of the button just looking broken.
  const [resolvingId, setResolvingId] = useState(null)
  const [noContactId, setNoContactId] = useState(null)
  const [error, setError] = useState('')

  function setSignals(updater) {
    setFeedPageData(prev => ({ ...prev, signals: updater(prev.signals) }))
  }

  // 2026-09-02 audit fix, real report: "Intelligence feed is showing Fasset
  // 3 times" — this page rendered every row straight from `signals` with no
  // dedup of its own at all. scanShared.js's fundingFuzzyKey and
  // filterSemanticDuplicates stop new duplicates being WRITTEN; this is the
  // display-side backstop for what's already on file (or ever slips past
  // those, for a signal type neither one catches) — see
  // intelligenceFeedDedup.js's own header for the full reasoning. Every
  // count/list below is derived from this collapsed view, not raw
  // `signals`, so the "3 new" badge can never disagree with how many cards
  // actually show.
  const dedupedSignals = useMemo(() => collapseFeedDuplicates(signals), [signals])
  const newCount = useMemo(() => dedupedSignals.filter(s => s.status === 'new').length, [dedupedSignals])
  // Three mutually-exclusive slices of the one signals array: News
  // (m_and_a/regulatory/public_commentary), Live roles (live_job), and
  // everything else in "Signals". A row lives in exactly one tab — live_job
  // used to also show up in Signals via the chip filter below; now it only
  // shows in its own tab, same "move, not duplicate" rule News already
  // follows, so the two tabs never disagree with each other about the same
  // row's count.
  const tabSignals = useMemo(() => dedupedSignals.filter(s => {
    if (mainTab === 'news') return NEWS_SIGNAL_TYPES.includes(s.signal_type)
    if (mainTab === 'live_jobs') return s.signal_type === 'live_job'
    return !NEWS_SIGNAL_TYPES.includes(s.signal_type) && s.signal_type !== 'live_job'
  }), [dedupedSignals, mainTab])
  const visible = useMemo(() => typeFilter === 'all' ? tabSignals : tabSignals.filter(s => s.signal_type === typeFilter), [tabSignals, typeFilter])
  const presentTypes = useMemo(() => [...new Set(tabSignals.map(s => s.signal_type))], [tabSignals])
  const newsCount = useMemo(() => dedupedSignals.filter(s => NEWS_SIGNAL_TYPES.includes(s.signal_type)).length, [dedupedSignals])
  const liveJobsCount = useMemo(() => dedupedSignals.filter(s => s.signal_type === 'live_job').length, [dedupedSignals])

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
    // 2026-08-26 audit fix: this write's result was never checked — a
    // failed update (RLS denial, dropped connection) silently left the
    // signal marked 'new' server-side while the UI still said 'seen'.
    const { error: err } = await markSignalSeen(s.id)
    if (err) { setError(err.message || 'Could not update this signal. Please try again.'); return }
    setError('') // 2nd-pass audit fix: clear a stale error from an earlier failed action
    setSignals(prev => prev.map(x => x.id === s.id ? { ...x, status: 'seen' } : x))
    logSignalOutcome(user, s, 'seen')
  }

  async function markActioned(s) {
    // 2026-08-26 audit fix: same as markSeen above — an unchecked failure
    // here removed the card from view even though the row was never
    // actually marked 'actioned', so it would reappear (or be reported as
    // 'actioned' in analytics) out of sync with the database.
    const { error: err } = await markSignalActioned(s.id)
    if (err) { setError(err.message || 'Could not update this signal. Please try again.'); return }
    setError('') // 2nd-pass audit fix: clear a stale error from an earlier failed action
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
    const hasContact = s.contact_verified || (Array.isArray(s.contact_candidates) && s.contact_candidates.length > 0)
    // 2026-08-26: the real fix for the flaw above — before this, a signal
    // with no contact just quietly never showed up on Today's Actions after
    // this exact click, with nothing telling the customer why. Now it tries
    // a real, live Apollo re-search (forcing the widest fallback pass
    // regardless of tier, see resolve-signal-contact.js) before deciding
    // whether the add can actually go anywhere.
    if (!hasContact) {
      setNoContactId(null)
      setResolvingId(s.id)
      const result = await resolveSignalContact(s.id)
      setResolvingId(null)
      if (!result?.found) {
        setNoContactId(s.id)
        return // no silent failure — the button now says exactly what happened, and doesn't navigate to a list this signal won't appear on
      }
      const resolved = { contact_verified: !!result.contact, contact_candidates: result.contactCandidates || null }
      setSignals(prev => prev.map(x => x.id === s.id ? { ...x, ...resolved } : x))
      s = { ...s, ...resolved }
    }
    // 2026-08-26 audit fix: unchecked write — a failure here used to still
    // show the "Added!" confirmation and navigate to Today's Actions, where
    // the signal would then be missing since manually_added_at was never
    // actually set.
    const { error: err } = await markSignalManuallyAdded(s.id)
    if (err) { setError(err.message || 'Could not add this to Today\'s Actions. Please try again.'); return }
    setError('') // 2nd-pass audit fix: clear a stale error from an earlier failed action
    setSignals(prev => prev.map(x => x.id === s.id ? { ...x, manually_added_at: new Date().toISOString() } : x))
    logSignalOutcome(user, s, 'added_to_bd_actions')
    trackEvent('signal_added_to_bd_actions', { signal_type: s.signal_type })
    setAddedId(s.id)
    setTimeout(() => navigate('/dashboard/actions'), 650)
  }

  return (
    <div className="p-8 w-full">
      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-extrabold text-navy flex items-center">
            Intelligence Feed
            {/* 2026-08-26 audit fix: was "every few hours" — the actual
                cadence (intelligence-scan.js's cron, every 12 hours) is
                twice a day, plus on demand whenever the customer runs a
                manual scan. */}
            <InfoTip text="Annie researches your sectors and markets in the background twice a day, plus whenever you ask her to look again — this is everything she's found, newest first. Today's Actions pulls its best picks from the same list." />
          </h1>
          <p className="text-gray-500 text-[13px] mt-0.5">Newest first, exactly when it happened. Annie's already watching, even when you're not looking.</p>
        </div>
        {newCount > 0 && <span className="bg-navy text-gold text-xs font-bold px-3.5 py-2 rounded-full whitespace-nowrap">{newCount} new</span>}
      </div>

      <ErrorBanner>{error || (loadError && (loadError.message || 'Could not load your feed. Please try again.'))}</ErrorBanner>

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
          className={`px-1.5 py-2.5 mr-[22px] text-[13.5px] font-bold border-b-2 -mb-0.5 transition-colors ${mainTab === 'news' ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'}`}
        >
          News {newsCount > 0 && <span className="text-xs font-semibold">({newsCount})</span>}
        </button>
        <button
          onClick={() => switchTab('live_jobs')}
          className={`px-1.5 py-2.5 text-[13.5px] font-bold border-b-2 -mb-0.5 transition-colors ${mainTab === 'live_jobs' ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'}`}
        >
          💼 Live roles {liveJobsCount > 0 && <span className="text-xs font-semibold">({liveJobsCount})</span>}
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
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : visible.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-bold text-navy mb-1">Nothing here yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">Annie scans your sectors and markets twice a day in the background. Check back soon, or import your LinkedIn contacts so she has more to watch.</p>
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
                // 2026-08-24 Task 4: this was mouse-only — no way for a
                // keyboard user to trigger the same "viewing marks it seen"
                // behaviour every other interactive element on this card
                // already gets via real <button>/<a> tags. role="button" +
                // tabIndex + onKeyDown gives it an equivalent keyboard path;
                // the nested controls below already stopPropagation and
                // keep their own independent tab stops, so this doesn't
                // change how they're reached.
                role="button"
                tabIndex={0}
                aria-label={`${s.company_name}: ${s.headline}${unread ? ' (new, click to mark seen)' : ''}`}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    markSeen(s)
                  }
                }}
                className={`relative cursor-pointer px-4 py-3.5 border-b border-gray-200 last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold focus-visible:-outline-offset-2 ${unread ? 'bg-gold/[0.045]' : ''}`}
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
                      {/* 2026-08-26 audit fix: dead ternary — both branches said
                          'Happened', so whatever distinct wording this was meant
                          to carry for a time-sensitive signal never actually
                          existed. Left as one honest label rather than inventing
                          new copy; the amber "time-sensitive" callout right below
                          already carries the urgency distinction. */}
                      {s.event_at && <span className="text-[11px] font-semibold text-gray-400">📅 Happened {timeAgo(s.event_at)}</span>}
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
                      ) : resolvingId === s.id ? (
                        <span className="flex items-center gap-1.5 text-gray-500 font-bold text-xs px-2.5 py-1.5 rounded-full border border-transparent bg-gray-100">
                          <span className="w-3 h-3 border-2 border-gold border-t-transparent rounded-full animate-spin" /> Finding a contact…
                        </span>
                      ) : noContactId === s.id ? (
                        // Honest outcome, not a broken button: Annie really did
                        // try (a live, wider Apollo re-search, not just the
                        // original scan-time attempt) and genuinely found
                        // nobody findable. The signal stays right here in the
                        // Feed either way, and the recurring scan will pick a
                        // contact up automatically the moment one exists —
                        // this never silently drops the signal itself, only
                        // this one attempt to fast-track it into Today's Actions.
                        <span className="flex items-center gap-1.5 text-gray-500 text-xs font-semibold italic" title="Annie searched Apollo directly and couldn't confirm anyone at this company yet. It'll stay here, and Today's Actions will pick it up automatically the moment a contact's found.">
                          No verified contact found yet — still watching
                        </span>
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

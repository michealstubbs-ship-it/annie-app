import React, { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { useScanStatusPoll, triggerScanNow } from '../lib/useScanStatusPoll'
import { withTimeout } from '../lib/withTimeout'
import {
  IconZap, IconCalendar, IconRadio, IconBriefcase, IconSparkles, IconArrowRight, IconPlus, IconMessageCircle, IconBuilding, IconUsers,
} from './icons'
// 2026-08-25: Overview's "Needs your attention" card and urgentCount used to
// read the legacy actions_cache table, which Today's Actions itself stopped
// writing to when it moved to a live, always-recomputed model (see
// useTodaysActions.js's own header) — actions_cache is permanently empty
// for every account now, so this card silently said "generate today's
// actions" and the hero banner said "nothing urgent" even with real,
// visible items on the actual Today's Actions page. Reusing the exact same
// pool builders + resolveTodaysActions Today's Actions itself uses is what
// guarantees this card can never disagree with that page again — same
// eligibility rules, same signal-type whitelist (BD_ACTION_SIGNAL_TYPES),
// same "already marked done" check, computed once here without the AI-copy
// step (Overview only ever shows a headline/company preview, never the full
// card), not a second, hand-maintained opinion of what belongs here.
import {
  buildDormantPool, buildMeetingPool, buildRelationshipPool, buildNewClientPool, buildSourcedPool,
  selectDailyItems, resolveTodaysActions,
} from '../lib/todaysActions/index.js'
import { resolveMarketCurrencyCode, DEFAULT_CURRENCY_CODE } from '../lib/marketCurrency'
import { currencySymbol } from '../lib/invoiceCalc'

const JOB_STATUS_LABEL = { active: 'Active', onhold: 'On hold', filled: 'Filled', lost: 'Lost' }
const JOB_STATUS_COLOR = { active: '#2f9e5b', onhold: '#d99a2b', filled: '#c9a84c', lost: '#9ca0ac' }

// 2026-08-26: the localStorage scan-started flag itself is now owned by
// useScanStatusPoll.js (shared with Settings.jsx) — no longer read/written
// directly here.
// scan-now-background.js can now chain across several rounds for Growth/
// Team accounts (2026-08-25 — see that file's own header), up to that
// tier's own maxWallClockMs (20 minutes) before it stops. scan-status.js's
// own timeout matches that ceiling plus a margin (see its header) — this
// window has to be at least as generous, or the "researching" banner can
// vanish while a legitimately still-chaining scan is genuinely working,
// dropping a customer onto generic "nothing new yet" copy on the single
// highest-stakes trust moment in the product. Was 16 minutes, sized only
// for the old single-pass scan.
const SCAN_WINDOW_MS = 24 * 60 * 1000

// 2026-08-25: what a first scan's outcome actually means, and whether the
// customer can do anything about it right now. Centralised here instead of
// three separate copies of the same ternary chain (the hero banner, the
// "Needs your attention" card, and the "Latest intelligence" card all used
// to each guess independently, and only one of the three ever actually said
// anything honest — see the header comment on scanOutcome below for why
// that was the real bug behind "it loaded and came back with nothing, why?"
// even after the backend itself was already working correctly).
function scanOutcomeCopy(scanOutcome) {
  switch (scanOutcome?.reason) {
    case 'no_results':
      return {
        headline: "Annie's first pass through your market didn't turn up anything strong enough to flag yet.",
        // 2026-08-26 audit fix: was "every few hours" — the real cadence is
        // intelligence-scan.js's cron schedule, `0 */12 * * *` (twice a
        // day), confirmed against the live function config.
        detail: 'She checks again automatically twice a day — you can also ask her to look again right now.',
        canRetryNow: true,
      }
    case 'timed_out':
      return {
        headline: "Annie's first research pass is taking longer than usual for a market this size.",
        detail: "She's still working server-side. Refresh this page in a few minutes to see what she's found.",
        canRetryNow: false,
      }
    case 'error':
      return {
        headline: 'Annie hit a snag reaching her research tools on her last pass.',
        detail: "She'll retry automatically, or you can ask her to try again right now.",
        canRetryNow: true,
      }
    case 'cooldown':
      return {
        headline: 'Annie already ran a fresh scan for you recently.',
        detail: scanOutcome.retryAfter
          ? `You can ask her to look again after ${new Date(scanOutcome.retryAfter).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`
          : 'You can ask her to look again shortly.',
        canRetryNow: false,
      }
    // 2026-08-25: Annie now keeps researching on her own across several
    // rounds instead of stopping after one pass (see scan-now-background.js's
    // chaining) — this is what she reports when she genuinely ran out of
    // rounds/time for a real, narrow market rather than hitting the tier's
    // target. Deliberately honest rather than implying the dashboard is
    // fully populated: never padded to hit a number — real signals only.
    case 'partial_ceiling':
      return {
        headline: `Annie found ${scanOutcome.signalsFound || 'some'} real signal${scanOutcome.signalsFound === 1 ? '' : 's'} so far — still building out your first week of intelligence.`,
        detail: 'Some markets and niches genuinely have less breaking news than others on any given day. She keeps checking automatically, and you can ask her to look again any time.',
        canRetryNow: true,
      }
    default:
      return null
  }
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
function fmtTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d }
function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d }

const TAG_STYLE = {
  urgent: 'bg-red-50 text-red-700',
  stale: 'bg-amber-50 text-amber-700',
  note: 'bg-blue-50 text-blue-700',
  quiet: 'bg-gray-100 text-gray-500',
}
function Tag({ kind, children }) {
  return <span className={`text-[10.5px] font-semibold px-2.5 py-1 rounded-md whitespace-nowrap ${TAG_STYLE[kind]}`}>{children}</span>
}

export default function Overview() {
  const { user, profile } = useAuth()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // 2nd-pass audit fix (2026-08-26): onDone below can now call load() a
  // second time, mid-session, in the background — not just the one
  // mount-triggered call this used to be limited to. Two overlapping
  // load() calls (a slow mount-load still in flight when a scan finishes,
  // or the reverse) had no ordering guarantee: whichever resolved last won,
  // which could let a stale, in-flight response overwrite fresher
  // post-scan data. This token is the same "only the latest call may write
  // state" guard useScanStatusPoll.js already uses for polling.
  const loadTokenRef = useRef(0)
  const [topActions, setTopActions] = useState([])
  const [totalActions, setTotalActions] = useState(0)
  const [jobs, setJobs] = useState([])
  const [candidates, setCandidates] = useState([])
  const [signals, setSignals] = useState([])
  const [newSignalsCount, setNewSignalsCount] = useState(0)
  const [meetings, setMeetings] = useState([])
  const [tasks, setTasks] = useState([])
  const [contactsCount, setContactsCount] = useState(null) // null = not checked yet, avoids a flash of the reminder
  // 2026-08-29 audit fix: the pipeline-value stat used to hardcode "AED" —
  // Annie's own home market, not necessarily this account's. Resolved from
  // the account's own onboarding market instead, same source Pipeline.jsx's
  // currency display already uses.
  const [marketCurrency, setMarketCurrency] = useState(DEFAULT_CURRENCY_CODE)
  const [scanOutcome, setScanOutcome] = useState(null) // set once scan-status.js reports the scan is actually done, tells us WHY there's nothing (or something) to show
  const [chainProgress, setChainProgress] = useState(null) // live counts while a chained scan is still running — updated on every poll tick via useScanStatusPoll's onTick
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  // Starter-only upgrade nudge (2026-08-25, confirmed with Michael): shown
  // once this account's own first scan has actually finished, so it reads
  // as a real contrast the customer can feel ("here's what you got"), not a
  // sales pitch shown before they've seen anything. Never shown to Growth/
  // Team — there's nothing to upgrade to that changes this. Defaults to
  // 'starter' the same way getEntitlements does server-side (see
  // entitlements.js) — an unrecognised or missing subscription degrades to
  // Starter-level rather than hiding the nudge incorrectly.
  const [tier, setTier] = useState('starter')
  const [upgradeNudgeDismissed, setUpgradeNudgeDismissed] = useState(false)

  useEffect(() => { load() }, [user])

  // 2026-08-26 audit fix: this used to hand-roll its own copy of the exact
  // fetch + localStorage-flag + recursive-setTimeout + "supersede a stale
  // poll" logic useScanStatusPoll.js already existed to share with
  // Settings.jsx — routed through the real hook now instead of a second,
  // drifting copy. The hook's `autoDetectExisting` covers what the old
  // manual useEffect below did (resume watching a scan onboarding already
  // started, via the same localStorage flag), its token-superseding
  // (generalized into the hook itself) covers what pollTokenRef did by
  // hand, and its `onTick` covers the live "N found so far" progress this
  // page specifically needs while a chained scan is still running.
  const { polling: researching, start: startResearchPoll } = useScanStatusPoll({
    user,
    windowMs: SCAN_WINDOW_MS,
    autoDetectExisting: true,
    onTick: (result) => setChainProgress(result),
    onDone: (result) => {
      setScanOutcome(result)
      // 2026-08-26 audit fix: this used to call the narrower pollSignals()
      // (just the "Latest intelligence" signal list + 7-day count), which
      // left "Needs your attention" (topActions/totalActions) stuck showing
      // whatever it computed on the last full load — a newly-found signal
      // that should now show up there didn't, until the customer manually
      // reloaded the page. load() reruns the exact same pools ->
      // selectDailyItems -> resolveTodaysActions pipeline pollSignals never
      // touched, so a fresh scan result now refreshes everything this page
      // shows, not just the signal list.
      if (result.signalsFound > 0) load()
    },
  })

  // 2026-08-25: the dashboard-native counterpart to Settings' "Run a new
  // scan" button. That button fixed the underlying "no way to ever retry"
  // gap, but it lived on a page away from the exact moment a customer
  // notices their dashboard is empty — every time this got reported, the
  // fix Michael actually needed was to go find Settings and click a button
  // by hand, which is the opposite of "loads automatically." This calls the
  // same backend endpoint, but from directly inside the empty-state copy
  // that explains why it's empty in the first place, and immediately
  // resumes the same polling UI so the customer sees it pick back up right
  // here without navigating anywhere.
  async function runAnotherScanNow() {
    if (!user) return
    setRetrying(true)
    setRetryError('')
    setScanOutcome(null)
    try {
      // 2026-08-29 audit fix: same unwrapped getSession() hang fixed on
      // this exact button's twin in Settings.jsx — an unsettled promise
      // here left "Run a new scan" spinning forever with no error.
      const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000, 'overview-rescan-session')
      if (!session?.access_token) throw new Error('Your session has expired. Please log in again.')

      // 2026-08-27 audit fix: was a bare fire-and-forget fetch — see
      // triggerScanNow's own header (useScanStatusPoll.js) for why that
      // silently hid a rejected trigger as if the scan had actually started.
      const started = await triggerScanNow(session.access_token)
      if (!started) {
        setRetryError("Couldn't start a new scan just now. Please try again.")
        return
      }

      startResearchPoll()
    } catch (err) {
      setRetryError(err.message || 'Could not start a new scan. Please try again.')
    } finally {
      setRetrying(false)
    }
  }


  // 2nd-pass audit fix (2026-08-26): this had no try/catch at all — fine
  // when it only ever ran once on mount (a throw there would have been
  // obvious and immediately visible), but onDone above can now also call
  // it from a background scan-poll callback with nobody watching. An
  // uncaught throw here (e.g. resolveTodaysActions -> loadActionState
  // throwing on a real Supabase error, per this same session's own audit
  // fix) used to mean setLoading(false) never ran — the "Needs your
  // attention" card would silently freeze on "Loading..." forever, mid
  // session, with no error anywhere. Now caught, surfaced, and the loading
  // flag is always released via finally.
  async function load() {
    const token = ++loadTokenRef.current
    setLoading(true)
    setLoadError('')
    try {
    const todayStart = startOfToday().toISOString()
    const todayEnd = endOfToday().toISOString()
    const todayDateStr = new Date().toISOString().slice(0, 10)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [
      { data: fullContacts },
      { data: deals },
      { data: jobRows },
      { data: candRows },
      { data: allSignalRows },
      { data: signalCountRows },
      { data: meetingRows },
      { data: taskRows },
      { count: contactsCountResult },
      { data: onboardingRow },
    ] = await Promise.all([
      // jobs/candidates/meetings/bd_tasks/contacts are the shared CRM —
      // team-scoped by RLS, dropping the user_id filter is what makes the
      // dashboard reflect the whole team's pipeline, not just this user's
      // slice of it. intelligence_signals is the opposite (see
      // lib/data/signals.js) and keeps its own explicit user_id filter
      // below so the dashboard's signal widget stays personal too.
      // fullContacts/deals are what the pool builders below need — same
      // shape and same limit as useTodaysActions.js uses, so this can
      // never disagree with what Today's Actions itself computes.
      supabase.from('contacts').select('*').limit(500),
      supabase.from('deals').select('*').limit(200),
      supabase.from('jobs').select('id, status, fee_value'),
      supabase.from('candidates').select('id, status'),
      // Uncapped (well, 300 — same cap useTodaysActions.js uses) rather
      // than the old limit(3): the pool builders need every eligible
      // signal to score/rank correctly, not just the newest few. The
      // "Latest intelligence" panel below takes its own top-3 slice of
      // this same result instead of running a second, separate query.
      supabase.from('intelligence_signals').select('*').eq('user_id', user.id).neq('status', 'actioned').order('found_at', { ascending: false }).limit(300),
      supabase.from('intelligence_signals').select('id').eq('user_id', user.id).gte('found_at', sevenDaysAgo),
      supabase.from('meetings').select('id, title, meeting_type, meeting_date').gte('meeting_date', todayStart).lte('meeting_date', todayEnd).order('meeting_date', { ascending: true }),
      supabase.from('bd_tasks').select('id, title, due_date').eq('status', 'open').lte('due_date', todayDateStr).order('due_date', { ascending: true }).limit(5),
      // head:true — just the count, no rows. Zero contacts is the signal that LinkedIn
      // import hasn't happened yet (whether skipped or never started), independent of
      // profiles.linkedin_import_completed which gets set true on skip too. This banner
      // self-clears the moment a real import lands, no extra state to keep in sync.
      supabase.from('contacts').select('id', { count: 'exact', head: true }),
      supabase.from('onboarding').select('locations').eq('user_id', user.id).single(),
    ])
    setMarketCurrency(resolveMarketCurrencyCode(onboardingRow?.locations))

    // Same pools -> selectDailyItems -> resolveTodaysActions pipeline
    // useTodaysActions.js runs, minus the AI-copy-writing step (Overview
    // never shows the full card, just a headline/company preview) — see
    // the import comment above for why this replaces the old actions_cache
    // read.
    const pools = {
      dormant: buildDormantPool(fullContacts || []),
      meeting: buildMeetingPool(deals || [], fullContacts || []),
      relationship: buildRelationshipPool(allSignalRows || [], fullContacts || []),
      new_client: buildNewClientPool(fullContacts || [], deals || []),
      sourced: buildSourcedPool(allSignalRows || [], fullContacts || []),
    }
    const selected = selectDailyItems(pools)
    const shaped = selected.map(item => {
      if (item.category === 'sourced') {
        const s = item.signal
        return { category: 'sourced', urgency: item.urgency, score: item.score, headline: s.headline, company: s.company_name, signalId: s.id }
      }
      return {
        category: item.category,
        urgency: item.urgency,
        score: item.score,
        headline: item.contact?.name || item.deal?.company || item.signal?.company_name || 'Follow up',
        company: item.contact?.company || item.deal?.company || item.signal?.company_name,
        signalId: item.category === 'relationship' ? item.signal?.id : null,
        contactId: item.contact?.id || null,
        dealId: item.deal?.id || null,
        keyContext: item.contact?.last_contacted || item.contact?.created_at || item.deal?.updated_at || '',
      }
    })
    const resolvedActions = await resolveTodaysActions({ supabase, userId: user.id, freshActions: shaped })

    // A newer load() already started (or finished) while this one was still
    // in flight — its results are stale, don't let them clobber fresher
    // state. (Deliberately checked here, right before the writes, rather
    // than only in finally — this is the point a slow, superseded response
    // would otherwise overwrite what a faster, newer one already set.)
    if (loadTokenRef.current !== token) return

    setTopActions(resolvedActions.slice(0, 3))
    setTotalActions(resolvedActions.length)
    setJobs(jobRows || [])
    setCandidates(candRows || [])
    setSignals((allSignalRows || []).slice(0, 3))
    setNewSignalsCount(signalCountRows?.length || 0)
    setMeetings(meetingRows || [])
    setTasks(taskRows || [])
    setContactsCount(contactsCountResult ?? 0)
    } catch (err) {
      if (loadTokenRef.current !== token) return
      console.error('[Overview] failed to load dashboard data', err)
      setLoadError(err.message || 'Could not load your dashboard. Please try again.')
    } finally {
      if (loadTokenRef.current === token) setLoading(false)
    }
  }

  // A whole-number KPI tile (Pipeline Value), not an invoice line amount —
  // deliberately not routed through formatMoney(), which forces two decimal
  // places for invoice precision; this wants the same no-decimal convention
  // Pipeline.jsx's own currency prefix already uses for the same kind of
  // stat. currencySymbol() is still the single shared source for the symbol
  // itself, so this can't drift from invoiceCalc.js's own currency list.
  const pipelineCurrencyPrefix = useMemo(() => {
    const symbol = currencySymbol(marketCurrency)
    return symbol.length > 1 ? `${symbol} ` : symbol
  }, [marketCurrency])

  const jobStats = useMemo(() => {
    const active = jobs.filter(j => j.status === 'active')
    const onhold = jobs.filter(j => j.status === 'onhold')
    const filled = jobs.filter(j => j.status === 'filled')
    const lost = jobs.filter(j => j.status === 'lost')
    const pipelineValue = active.reduce((sum, j) => sum + (Number(j.fee_value) || 0), 0)
    const max = Math.max(active.length, onhold.length, filled.length, 1)
    return { active, onhold, filled, lost, pipelineValue, max }
  }, [jobs])

  const candidateStats = useMemo(() => {
    const inPlay = candidates.filter(c => !['placed', 'rejected', 'withdrawn'].includes(c.status))
    const interviewing = candidates.filter(c => ['interviewing', 'offer'].includes(c.status))
    return { inPlay: inPlay.length, interviewing: interviewing.length }
  }, [candidates])

  const urgentCount = topActions.filter(a => a.urgency >= 1).length
  const scanCopy = scanOutcomeCopy(scanOutcome)
  // Only worth surfacing a scan explanation on an otherwise-quiet dashboard
  // — a customer with real actions, meetings or signals already showing
  // doesn't need to be told about the scan that ran hours ago, that would
  // just be noise competing with what's actually there for them today.
  const dashboardIsQuiet = urgentCount === 0 && totalActions === 0 && meetings.length === 0 && tasks.length === 0 && signals.length === 0

  const briefing = useMemo(() => {
    const parts = []
    if (urgentCount > 0) parts.push(`${urgentCount} signal${urgentCount === 1 ? '' : 's'} need a response today`)
    else if (totalActions > 0) parts.push(`${totalActions} thing${totalActions === 1 ? '' : 's'} worth a look today`)
    if (meetings.length > 0) parts.push(`${meetings.length} meeting${meetings.length === 1 ? '' : 's'} today`)
    if (tasks.length > 0) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} due`)
    if (parts.length) return parts.join(', ') + '.'
    if (researching) return "Annie is researching your market right now, first results usually land within a few minutes."
    if (dashboardIsQuiet && scanCopy) return scanCopy.headline
    return 'Nothing urgent right now. Good time to work through your pipeline.'
  }, [urgentCount, totalActions, meetings.length, tasks.length, researching, dashboardIsQuiet, scanCopy])

  function quickAdd(path) {
    navigate(path, { state: { autoOpenAdd: true } })
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h1 className="text-[27px] font-bold text-navy tracking-tight">
            {(() => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening' })()}, {profile?.full_name?.split(' ')[0] || 'there'}
          </h1>
          <p className="text-gray-400 text-sm mt-1">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <div className="w-9 h-9 rounded-full bg-navy text-gold flex items-center justify-center font-bold text-[13px] flex-shrink-0">
          {initials(profile?.full_name)}
        </div>
      </div>

      <div className="bg-navy rounded-2xl px-5 py-4 my-5 flex items-center gap-3">
        <IconSparkles className="w-[18px] h-[18px] text-gold flex-shrink-0" />
        <p className="text-[13.5px] text-gray-200 leading-relaxed">{briefing} <span className="text-gold font-semibold">Here's the shape of your day.</span></p>
      </div>

      {researching && (
        <div className="rounded-2xl px-5 py-4 mb-5 flex items-center gap-3.5 border-2 border-gold bg-gradient-to-r from-navy to-[#1a2d5c]">
          <div className="relative w-10 h-10 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
            <span className="absolute inset-0 rounded-full bg-gold/30 animate-ping" />
            <div className="relative w-4 h-4 border-2 border-gold border-t-transparent rounded-full animate-spin" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white">Annie is researching your market right now</p>
            {/* 2026-08-26 audit fix: was "usually land within a couple of
                minutes" — entitlements.js's SCAN_TIER_CONFIG budgets 10-20
                minutes of wall-clock scan time depending on tier, and this
                page's own poll window (below) is sized at 24 minutes
                specifically because a scan can legitimately still be
                running that long. A customer taking the "couple of
                minutes" line literally and refreshing at the 3-minute mark
                would see nothing and reasonably conclude it was broken. */}
            <p className="text-[12.5px] text-gray-300 mt-0.5 leading-relaxed">Live funding rounds, leadership changes and hiring signals in your sectors. A full pass can take several minutes for a market this size — this page updates itself the moment results land, no need to refresh.</p>
          </div>
        </div>
      )}

      {!researching && dashboardIsQuiet && scanCopy && (
        <div className="bg-white border border-gray-200 rounded-2xl px-5 py-4 mb-5 flex items-center gap-3.5">
          <div className="w-9 h-9 rounded-full bg-navy/5 flex items-center justify-center flex-shrink-0">
            <IconSparkles className="w-[18px] h-[18px] text-navy" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13.5px] font-semibold text-navy">{scanCopy.headline}</p>
            <p className="text-[12.5px] text-gray-500 mt-0.5 leading-relaxed">{scanCopy.detail}</p>
            {retryError && <p className="text-[12px] text-red-600 mt-1">{retryError}</p>}
          </div>
          {scanCopy.canRetryNow && (
            <button
              onClick={runAnotherScanNow}
              disabled={retrying}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold border border-gray-200 text-navy whitespace-nowrap disabled:opacity-60"
            >
              {retrying ? 'Starting…' : 'Ask Annie to look again'}
            </button>
          )}
        </div>
      )}

      {!loading && contactsCount === 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-2xl px-5 py-4 mb-5 flex items-center gap-3.5">
          <div className="w-9 h-9 rounded-full bg-white flex items-center justify-center flex-shrink-0">
            <IconUsers className="w-[18px] h-[18px] text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13.5px] font-semibold text-amber-900">Import your LinkedIn contacts to unlock Annie's full intelligence</p>
            <p className="text-[12.5px] text-amber-700 mt-0.5 leading-relaxed">
              If you've requested your LinkedIn export, come back here once the email arrives (can take up to 24 hours) and upload the CSV. Haven't requested it yet? Do that first, it's the slow step.
            </p>
          </div>
          <button
            onClick={() => navigate('/dashboard/import-linkedin')}
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold bg-amber-600 text-white whitespace-nowrap"
          >
            Import contacts <IconArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 2026-08-31 audit fix, "the dashboard shows £0 before it shows the
          truth": these four tiles used to render unconditionally straight
          off jobs/candidates/signals state, which all start at []/0 before
          load() below ever resolves — so a brand-new customer's very first
          look at the product was a finished-looking dashboard confidently
          reporting £0, 0 jobs, 0 candidates, with no spinner or any other
          sign it was still loading. First paint at ~800ms, real numbers not
          in until 1.4-1.8s — plenty long enough to read as "this product
          has nothing in it" rather than "this is still loading". Gated on
          `loading` now, same as "Needs your attention" just below already
          was — a pulsing placeholder bar in place of each number, rather
          than a number that's simply wrong for a second. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs text-gray-400 font-medium mb-1.5">Active pipeline</div>
          {loading ? (
            <>
              <div className="h-[22px] w-20 bg-gray-100 rounded animate-pulse" />
              <div className="h-[11px] w-24 bg-gray-100 rounded animate-pulse mt-2" />
            </>
          ) : (
            <>
              <div className="text-[22px] font-bold text-navy tracking-tight">{pipelineCurrencyPrefix}{jobStats.pipelineValue.toLocaleString()}</div>
              <div className="text-[11px] text-gray-400 mt-1">{jobStats.active.length} active mandate{jobStats.active.length === 1 ? '' : 's'}</div>
            </>
          )}
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs text-gray-400 font-medium mb-1.5">Open jobs</div>
          {loading ? (
            <>
              <div className="h-[22px] w-10 bg-gray-100 rounded animate-pulse" />
              <div className="h-[11px] w-28 bg-gray-100 rounded animate-pulse mt-2" />
            </>
          ) : (
            <>
              <div className="text-[22px] font-bold text-navy tracking-tight">{jobStats.active.length + jobStats.onhold.length}</div>
              <div className="text-[11px] text-gray-400 mt-1">{jobStats.active.length} active &middot; {jobStats.onhold.length} on hold</div>
            </>
          )}
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs text-gray-400 font-medium mb-1.5">Candidates in play</div>
          {loading ? (
            <>
              <div className="h-[22px] w-10 bg-gray-100 rounded animate-pulse" />
              <div className="h-[11px] w-20 bg-gray-100 rounded animate-pulse mt-2" />
            </>
          ) : (
            <>
              <div className="text-[22px] font-bold text-navy tracking-tight">{candidateStats.inPlay}</div>
              <div className="text-[11px] text-gray-400 mt-1">{candidateStats.interviewing} interviewing</div>
            </>
          )}
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          {/* 2026-08-26 audit fix: label was "New signals" but newSignalsCount
              (below) has no status filter — it counts every signal found in
              7 days, including ones already dismissed — while the Feed's
              own "N new" badge means status === 'new' only. Same word,
              different definition, one click apart. Relabelling to what the
              number actually is rather than changing what it counts, since
              the count itself (total found this week) is a reasonable,
              useful stat on its own — it just isn't "new" in the Feed's
              sense. */}
          <div className="text-xs text-gray-400 font-medium mb-1.5">Signals found, 7 days</div>
          {loading ? (
            <>
              <div className="h-[22px] w-10 bg-gray-100 rounded animate-pulse" />
              <div className="h-[11px] w-24 bg-gray-100 rounded animate-pulse mt-2" />
            </>
          ) : (
            <>
              <div className="text-[22px] font-bold text-navy tracking-tight">{newSignalsCount}</div>
              <div className="text-[11px] text-gray-400 mt-1">{urgentCount} need action</div>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-4">
        <div>
          <div className="card p-5 mb-3.5">
            <div className="flex items-center gap-2 mb-3">
              <IconZap className="w-4 h-4 text-gold" />
              <p className="text-[15px] font-bold text-navy">Needs your attention</p>
            </div>
            {loading ? (
              <p className="text-sm text-gray-400">Loading...</p>
            ) : loadError ? (
              <div className="py-2">
                <p className="text-sm text-red-600 mb-3">{loadError}</p>
                <button onClick={load} className="text-xs font-semibold text-navy">Try again</button>
              </div>
            ) : topActions.length === 0 ? (
              <div className="py-2">
                {researching ? (
                  <p className="text-sm text-gray-400 mb-3">Annie is still researching your market, check back in a few minutes.</p>
                ) : scanCopy ? (
                  <>
                    <p className="text-sm text-gray-400 mb-1">{scanCopy.headline}</p>
                    <p className="text-[12.5px] text-gray-400 mb-3">{scanCopy.detail}</p>
                  </>
                ) : (
                  <p className="text-sm text-gray-400 mb-3">Generate today's actions to see your top items here.</p>
                )}
                <div className="flex items-center gap-4 flex-wrap">
                  <button onClick={() => navigate('/dashboard/actions')} className="text-xs font-semibold text-navy">Go to Today's Actions →</button>
                  {!researching && scanCopy?.canRetryNow && (
                    <button onClick={runAnotherScanNow} disabled={retrying} className="text-xs font-semibold text-navy disabled:opacity-60">
                      {retrying ? 'Starting…' : 'Ask Annie to look again'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {topActions.map((a, i) => (
                  <div key={i} className={`flex items-center justify-between gap-3 py-2.5 ${i > 0 ? 'border-t border-gray-50' : ''}`}>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-gray-800 truncate">{a.headline}</p>
                      {a.company && <p className="text-[11.5px] text-gray-400 mt-0.5 truncate">{a.company}</p>}
                    </div>
                    <Tag kind={a.urgency >= 2 ? 'urgent' : a.urgency === 1 ? 'stale' : 'note'}>
                      {a.urgency >= 2 ? 'urgent' : a.urgency === 1 ? 'time-sensitive' : a.category === 'dormant' ? 're-engage' : 'follow up'}
                    </Tag>
                  </div>
                ))}
                <a onClick={() => navigate('/dashboard/actions')} className="inline-flex items-center gap-1 text-xs font-semibold text-navy mt-2.5 cursor-pointer">
                  View all {totalActions} today's actions <IconArrowRight className="w-3.5 h-3.5" />
                </a>
              </>
            )}
          </div>

          <div className="card p-5">
            <div className="flex items-center gap-2 mb-3">
              <IconCalendar className="w-4 h-4 text-gold" />
              <p className="text-[15px] font-bold text-navy">Today's schedule</p>
            </div>
            {meetings.length === 0 && tasks.length === 0 ? (
              <p className="text-sm text-gray-400">Nothing on the calendar today.</p>
            ) : (
              <>
                {meetings.map((m, i) => (
                  <div key={'m' + m.id} className={`flex items-center justify-between gap-3 py-2.5 ${i > 0 ? 'border-t border-gray-50' : ''}`}>
                    <p className="text-[13px] font-medium text-gray-800">{fmtTime(m.meeting_date)} &middot; {m.title}</p>
                    <Tag kind="quiet">{m.meeting_type}</Tag>
                  </div>
                ))}
                {tasks.map((t, i) => (
                  <div key={'t' + t.id} className={`flex items-center justify-between gap-3 py-2.5 ${(meetings.length + i) > 0 ? 'border-t border-gray-50' : ''}`}>
                    <p className="text-[13px] font-medium text-gray-800">Task &middot; {t.title}</p>
                    <Tag kind={t.due_date < startOfToday().toISOString().slice(0, 10) ? 'urgent' : 'quiet'}>
                      {t.due_date < startOfToday().toISOString().slice(0, 10) ? 'overdue' : 'due today'}
                    </Tag>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div>
          <div className="card p-5 mb-3.5">
            <div className="flex items-center gap-2 mb-3">
              <IconRadio className="w-4 h-4 text-gold" />
              <p className="text-[15px] font-bold text-navy">Latest intelligence</p>
            </div>
            {signals.length === 0 ? (
              <div>
                <p className="text-sm text-gray-400">
                  {researching
                    ? "Annie's on it, see the banner above."
                    : scanCopy
                      ? scanCopy.headline + ' ' + scanCopy.detail
                      : "Annie hasn't found anything new yet."}
                </p>
                {!researching && scanCopy?.canRetryNow && (
                  <button onClick={runAnotherScanNow} disabled={retrying} className="text-xs font-semibold text-navy mt-2.5">
                    {retrying ? 'Starting…' : 'Ask Annie to look again →'}
                  </button>
                )}
              </div>
            ) : (
              <>
                {signals.map((s, i) => (
                  <div key={s.id} className={`flex items-center gap-2.5 py-2.5 ${i > 0 ? 'border-t border-gray-50' : ''}`}>
                    {s.company_logo_url ? (
                      <img src={s.company_logo_url} alt="" className="w-6 h-6 rounded-md object-cover flex-shrink-0" onError={e => { e.target.style.display = 'none' }} />
                    ) : (
                      <div className="w-6 h-6 rounded-md flex items-center justify-center text-[9.5px] font-bold text-white flex-shrink-0" style={{ background: logoColor(s.company_name) }}>
                        {initials(s.company_name)}
                      </div>
                    )}
                    <p className="text-[12px] font-medium text-gray-700 leading-tight">{s.headline}</p>
                  </div>
                ))}
                <a onClick={() => navigate('/dashboard/intelligence-feed')} className="inline-flex items-center gap-1 text-xs font-semibold text-navy mt-2.5 cursor-pointer">
                  View intelligence feed <IconArrowRight className="w-3.5 h-3.5" />
                </a>
              </>
            )}
          </div>

          <div className="card p-5">
            <div className="flex items-center gap-2 mb-3.5">
              <IconBriefcase className="w-4 h-4 text-gold" />
              <p className="text-[15px] font-bold text-navy">Jobs by status</p>
            </div>
            {/* 2026-08-29 audit fix: this used to check jobs.length === 0
                with no `loading` gate — jobs starts as [] before the page's
                own data load resolves, so every visit briefly (real,
                measured: ~900ms-2s) showed "No jobs added yet" before
                correcting itself once the real jobs arrived. The only
                section on this page that did that — "Needs your attention"
                right above already gates on `loading` correctly. A paying
                customer's dashboard telling them their pipeline is empty,
                even briefly, is the one thing worth never getting wrong. */}
            {loading ? (
              <p className="text-sm text-gray-400">Loading...</p>
            ) : jobs.length === 0 ? (
              <p className="text-sm text-gray-400">No jobs added yet.</p>
            ) : (
              ['active', 'onhold', 'filled'].map(status => {
                const count = jobStats[status].length
                return (
                  <div key={status} className="flex items-center gap-2.5 mb-2 last:mb-0">
                    <span className="text-[11.5px] text-gray-400 font-medium w-14 flex-shrink-0">{JOB_STATUS_LABEL[status]}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                      <div className="h-1.5 rounded-full" style={{ width: `${(count / jobStats.max) * 100}%`, background: JOB_STATUS_COLOR[status] }} />
                    </div>
                    <span className="text-xs font-semibold text-gray-700 w-4 text-right flex-shrink-0">{count}</span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-5">
        <button onClick={() => quickAdd('/dashboard/jobs')} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold bg-gold text-navy">
          <IconPlus className="w-3.5 h-3.5" /> Add job
        </button>
        <button onClick={() => quickAdd('/dashboard/contacts')} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold border border-gray-200 text-gray-600">
          <IconPlus className="w-3.5 h-3.5" /> Add contact
        </button>
        <button onClick={() => quickAdd('/dashboard/companies')} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold border border-gray-200 text-gray-600">
          <IconBuilding className="w-3.5 h-3.5" /> Add company
        </button>
        <button onClick={() => quickAdd('/dashboard/meetings')} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold border border-gray-200 text-gray-600">
          <IconPlus className="w-3.5 h-3.5" /> Log meeting
        </button>
        <button onClick={() => navigate('/dashboard/chat')} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold border border-gray-200 text-gray-600">
          <IconMessageCircle className="w-3.5 h-3.5" /> Ask Annie
        </button>
      </div>
    </div>
  )
}

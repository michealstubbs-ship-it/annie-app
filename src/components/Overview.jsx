import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import {
  IconZap, IconCalendar, IconRadio, IconBriefcase, IconSparkles, IconArrowRight, IconPlus, IconMessageCircle, IconBuilding, IconUsers,
} from './icons'

const JOB_STATUS_LABEL = { active: 'Active', onhold: 'On hold', filled: 'Filled', lost: 'Lost' }
const JOB_STATUS_COLOR = { active: '#2f9e5b', onhold: '#d99a2b', filled: '#c9a84c', lost: '#9ca0ac' }

const SCAN_FLAG_PREFIX = 'annie_scan_started_'
const SCAN_WINDOW_MS = 6 * 60 * 1000 // give up on "researching" messaging after 6 minutes either way

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
  const [topActions, setTopActions] = useState([])
  const [totalActions, setTotalActions] = useState(0)
  const [jobs, setJobs] = useState([])
  const [candidates, setCandidates] = useState([])
  const [signals, setSignals] = useState([])
  const [newSignalsCount, setNewSignalsCount] = useState(0)
  const [meetings, setMeetings] = useState([])
  const [tasks, setTasks] = useState([])
  const [contactsCount, setContactsCount] = useState(null) // null = not checked yet, avoids a flash of the reminder
  const [researching, setResearching] = useState(false)
  const [scanOutcome, setScanOutcome] = useState(null) // set once scan-status.js reports the scan is actually done, tells us WHY there's nothing (or something) to show

  useEffect(() => { load() }, [user])

  // Onboarding fires a background research scan for the account and stamps
  // this flag (see Onboarding.jsx). Rather than just waiting out a fixed
  // window and hoping, we poll scan-status.js for the real state — the scan
  // itself often finishes in well under a minute (sometimes finding
  // nothing, which is a legitimate outcome, not a failure), and a spinner
  // that keeps saying "researching" for minutes after it already finished
  // reads as broken. The fixed window is now only a last-resort cutoff in
  // case the status check itself never resolves.
  useEffect(() => {
    if (!user) return
    let startedAt = 0
    try { startedAt = Number(localStorage.getItem(SCAN_FLAG_PREFIX + user.id)) || 0 } catch {}
    if (!startedAt || Date.now() - startedAt > SCAN_WINDOW_MS) return

    setResearching(true)
    let cancelled = false
    let timer

    async function tick() {
      const result = await checkScanStatus()
      if (cancelled) return

      if (result?.status === 'done') {
        setResearching(false)
        setScanOutcome(result)
        try { localStorage.removeItem(SCAN_FLAG_PREFIX + user.id) } catch {}
        if (result.signalsFound > 0) await pollSignals()
        return
      }

      if (Date.now() - startedAt > SCAN_WINDOW_MS) {
        setResearching(false)
        return
      }
      timer = setTimeout(tick, 5000)
    }

    timer = setTimeout(tick, 3000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [user])

  async function checkScanStatus() {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return { status: 'unknown' }
      const resp = await fetch('/.netlify/functions/scan-status', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      return await resp.json().catch(() => ({ status: 'unknown' }))
    } catch {
      return { status: 'unknown' }
    }
  }

  async function pollSignals() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const [{ data: signalRows }, { data: signalCountRows }] = await Promise.all([
      supabase.from('intelligence_signals').select('id, company_name, company_logo_url, headline, found_at').eq('user_id', user.id).neq('status', 'actioned').order('found_at', { ascending: false }).limit(3),
      supabase.from('intelligence_signals').select('id').eq('user_id', user.id).gte('found_at', sevenDaysAgo),
    ])
    setSignals(signalRows || [])
    setNewSignalsCount(signalCountRows?.length || 0)
  }

  async function load() {
    setLoading(true)
    const todayStart = startOfToday().toISOString()
    const todayEnd = endOfToday().toISOString()
    const todayDateStr = new Date().toISOString().slice(0, 10)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [
      { data: cache },
      { data: jobRows },
      { data: candRows },
      { data: signalRows },
      { data: signalCountRows },
      { data: meetingRows },
      { data: taskRows },
      { count: contactsCountResult },
    ] = await Promise.all([
      supabase.from('actions_cache').select('*').eq('user_id', user.id).gt('expires_at', new Date().toISOString()).order('generated_at', { ascending: false }).limit(1).single(),
      supabase.from('jobs').select('id, status, fee_value').eq('user_id', user.id),
      supabase.from('candidates').select('id, status').eq('user_id', user.id),
      supabase.from('intelligence_signals').select('id, company_name, company_logo_url, headline, found_at').eq('user_id', user.id).neq('status', 'actioned').order('found_at', { ascending: false }).limit(3),
      supabase.from('intelligence_signals').select('id').eq('user_id', user.id).gte('found_at', sevenDaysAgo),
      supabase.from('meetings').select('id, title, meeting_type, meeting_date').eq('user_id', user.id).gte('meeting_date', todayStart).lte('meeting_date', todayEnd).order('meeting_date', { ascending: true }),
      supabase.from('bd_tasks').select('id, title, due_date').eq('user_id', user.id).eq('status', 'open').lte('due_date', todayDateStr).order('due_date', { ascending: true }).limit(5),
      // head:true — just the count, no rows. Zero contacts is the signal that LinkedIn
      // import hasn't happened yet (whether skipped or never started), independent of
      // profiles.linkedin_import_completed which gets set true on skip too. This banner
      // self-clears the moment a real import lands, no extra state to keep in sync.
      supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
    ])

    if (cache?.actions?.length) {
      setTopActions(cache.actions.slice(0, 3))
      setTotalActions(cache.actions.length)
    } else {
      setTopActions([])
      setTotalActions(0)
    }
    setJobs(jobRows || [])
    setCandidates(candRows || [])
    setSignals(signalRows || [])
    setNewSignalsCount(signalCountRows?.length || 0)
    setMeetings(meetingRows || [])
    setTasks(taskRows || [])
    setContactsCount(contactsCountResult ?? 0)
    setLoading(false)
  }

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

  const briefing = useMemo(() => {
    const parts = []
    if (urgentCount > 0) parts.push(`${urgentCount} signal${urgentCount === 1 ? '' : 's'} need a response today`)
    else if (totalActions > 0) parts.push(`${totalActions} thing${totalActions === 1 ? '' : 's'} worth a look today`)
    if (meetings.length > 0) parts.push(`${meetings.length} meeting${meetings.length === 1 ? '' : 's'} today`)
    if (tasks.length > 0) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'} due`)
    if (!parts.length) return "Nothing urgent right now. Good time to work through your pipeline."
    return parts.join(', ') + '.'
  }, [urgentCount, totalActions, meetings.length, tasks.length])

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
            <p className="text-[12.5px] text-gray-300 mt-0.5 leading-relaxed">Live funding rounds, leadership changes and hiring signals in your sectors. First results usually land within a couple of minutes, and this page updates itself, no need to refresh.</p>
          </div>
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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs text-gray-400 font-medium mb-1.5">Active pipeline</div>
          <div className="text-[22px] font-bold text-navy tracking-tight">AED {jobStats.pipelineValue.toLocaleString()}</div>
          <div className="text-[11px] text-gray-400 mt-1">{jobStats.active.length} active mandate{jobStats.active.length === 1 ? '' : 's'}</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs text-gray-400 font-medium mb-1.5">Open jobs</div>
          <div className="text-[22px] font-bold text-navy tracking-tight">{jobStats.active.length + jobStats.onhold.length}</div>
          <div className="text-[11px] text-gray-400 mt-1">{jobStats.active.length} active &middot; {jobStats.onhold.length} on hold</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs text-gray-400 font-medium mb-1.5">Candidates in play</div>
          <div className="text-[22px] font-bold text-navy tracking-tight">{candidateStats.inPlay}</div>
          <div className="text-[11px] text-gray-400 mt-1">{candidateStats.interviewing} interviewing</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="text-xs text-gray-400 font-medium mb-1.5">New signals, 7 days</div>
          <div className="text-[22px] font-bold text-navy tracking-tight">{newSignalsCount}</div>
          <div className="text-[11px] text-gray-400 mt-1">{urgentCount} need action</div>
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
            ) : topActions.length === 0 ? (
              <div className="py-2">
                <p className="text-sm text-gray-400 mb-3">Generate today's actions to see your top items here.</p>
                <button onClick={() => navigate('/dashboard/actions')} className="text-xs font-semibold text-navy">Go to Today's Actions →</button>
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
              <p className="text-sm text-gray-400">
                {researching
                  ? "Annie's on it, see the banner above."
                  : scanOutcome?.reason === 'no_results'
                    ? "Annie checked your market just now and didn't find anything strong enough to flag yet. She checks again automatically every few hours."
                    : scanOutcome?.reason === 'error'
                      ? "Annie hit a snag reaching her research tools just now. She'll retry automatically, no action needed from you."
                      : "Annie hasn't found anything new yet."}
              </p>
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
            {jobs.length === 0 ? (
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

import React, { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { listTeamMembers } from '../lib/data/teamMembers'
import { loadTeamPerformanceData } from '../lib/data/teamPerformance'
import { PERIOD_OPTIONS, DEFAULT_PERIOD, periodStart, computeTeamPerformance, summarizeTeam } from '../lib/teamPerformanceView'
import { formatMoney } from '../lib/invoiceCalc'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import { IconBarChart, IconBriefcase, IconCalendar, IconUsers } from './icons'

// 2026-09-06, Michael: "Performance per a recruiter... pipeline, how many
// meetings they have had and terms signed... make sure annie is pulling the
// data properly, especially when someone sets the timeline... make sure the
// back end is also solid."
//
// This page is the display layer only. The real work, what each metric
// means and how the period filter applies to it, lives in
// teamPerformanceView.js (the pure aggregation, unit tested on its own) and
// data/teamPerformance.js (the raw reads). Read those two files' header
// comments for the exact definitions before changing anything rendered
// here, so this stays in sync with what is actually tested.
//
// Owner-only, same reasoning Billing.jsx already applies to its own
// member-list view: a desk's individual pipeline activity and revenue split
// is manager-facing information, not something every seat should see about
// every other seat. Gated at the component level (not the route, like
// Dashboard.jsx's AdminRoute) because the role check needs an async
// listTeamMembers() call rather than a value already sitting on `profile`.

function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n) }
function initials(name) { return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() }
function avatarColor(name) {
  const colors = ['#c9a84c', '#0d1b3e', '#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed']
  let h = 0
  for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h)
  return colors[Math.abs(h) % colors.length]
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Revenue is kept strictly per currency (see teamPerformanceView.js's own
// reasoning). This renders every currency that appears as its own line
// rather than guessing at a single combined figure. In practice this reads
// as one line for almost every account, since the currency comes from
// what each invoice was actually issued in (InvoiceFormModal's own
// currency picker), which for a firm licensed in a given market is
// overwhelmingly that market's own currency already.
function RevenueLines({ revenueByCurrency, emptyLabel = 'No revenue yet' }) {
  const entries = Object.entries(revenueByCurrency || {})
  if (!entries.length) return <span className="text-gray-400">{emptyLabel}</span>
  return (
    <div className="space-y-0.5">
      {entries.map(([currency, amount]) => (
        <div key={currency} className="font-semibold text-navy tabular-nums">{formatMoney(amount, currency)}</div>
      ))}
    </div>
  )
}

function StatTile({ label, value, Icon }) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-navy/5 text-navy flex items-center justify-center flex-shrink-0">
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-bold text-navy tabular-nums leading-tight">{value}</div>
        <div className="text-xs text-gray-500 font-medium truncate">{label}</div>
      </div>
    </div>
  )
}

function PipelinePill({ label, count, tone }) {
  const TONE = {
    neutral: 'bg-gray-100 text-gray-600',
    warning: 'bg-amber-100 text-amber-700',
    good: 'bg-green-100 text-green-700',
    bad: 'bg-red-100 text-red-600',
  }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${TONE[tone] || TONE.neutral}`}>
      {count} {label}
    </span>
  )
}

export default function TeamPerformance() {
  const { user } = useAuth()
  const [teamMembers, setTeamMembers] = useState([])
  const [myRole, setMyRole] = useState(null)
  const [roleLoading, setRoleLoading] = useState(true)
  const [roleError, setRoleError] = useState('')

  const [period, setPeriod] = useState(DEFAULT_PERIOD)
  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState('')
  const [perfData, setPerfData] = useState(null)

  const [expandedId, setExpandedId] = useState(null)

  useEffect(() => { loadRole() }, [user])

  async function loadRole() {
    setRoleLoading(true)
    setRoleError('')
    try {
      const tm = await listTeamMembers()
      setTeamMembers(tm)
      setMyRole(tm.find(m => m.id === user.id)?.role || null)
    } catch (err) {
      setRoleError(err.message || 'Could not load your team.')
    } finally {
      setRoleLoading(false)
    }
  }

  useEffect(() => {
    if (myRole === 'owner') loadPerformance(period)
  }, [myRole, period])

  async function loadPerformance(periodKey) {
    setDataLoading(true)
    setDataError('')
    try {
      const startIso = periodStart(periodKey).toISOString()
      const data = await loadTeamPerformanceData(startIso)
      setPerfData(data)
    } catch (err) {
      setDataError(err.message || 'Could not load team performance data.')
    } finally {
      setDataLoading(false)
    }
  }

  const rows = useMemo(() => {
    if (!perfData) return []
    return computeTeamPerformance({ teamMembers, ...perfData })
      .sort((a, b) => b.pipeline.inPlay - a.pipeline.inPlay)
  }, [perfData, teamMembers])

  const totals = useMemo(() => summarizeTeam(rows), [rows])

  if (roleLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[50vh]">
        <Spinner />
      </div>
    )
  }

  if (roleError) {
    return (
      <div className="p-6 max-w-2xl">
        <ErrorBanner>{roleError}</ErrorBanner>
      </div>
    )
  }

  if (myRole !== 'owner') {
    return (
      <div className="p-6 max-w-2xl">
        <div className="card p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-navy/5 text-navy flex items-center justify-center mx-auto mb-3">
            <IconBarChart className="w-6 h-6" />
          </div>
          <h1 className="text-lg font-bold text-navy mb-1">Team Performance is for account owners</h1>
          <p className="text-sm text-gray-500">
            This page shows pipeline, meetings and revenue per recruiter across the whole license.
            Ask the account owner if you need something reviewed here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-navy">Team Performance</h1>
          <p className="text-sm text-gray-500 mt-0.5">Pipeline, meetings and revenue for every recruiter on the license.</p>
        </div>
        <div className="flex gap-1.5 bg-white border border-gray-100 rounded-lg p-1">
          {PERIOD_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => setPeriod(opt.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                period === opt.key ? 'bg-navy text-white' : 'text-gray-500 hover:text-navy hover:bg-gray-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <ErrorBanner>{dataError}</ErrorBanner>

      {dataLoading ? (
        <div className="flex items-center justify-center min-h-[30vh]"><Spinner /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatTile label="Live jobs" value={totals.liveJobs} Icon={IconBriefcase} />
            <StatTile label="Candidates in play" value={totals.pipelineInPlay} Icon={IconUsers} />
            <StatTile label="Meetings held" value={totals.meetingsCount} Icon={IconCalendar} />
            <StatTile label="Terms signed" value={totals.termsSignedCount} Icon={IconBarChart} />
          </div>

          {Object.keys(totals.revenueByCurrency).length > 0 && (
            <div className="card p-4 mb-6 flex flex-wrap items-center gap-x-6 gap-y-2">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Placement revenue, this period</span>
              <RevenueLines revenueByCurrency={totals.revenueByCurrency} />
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-3">Recruiter</th>
                    <th className="px-4 py-3">Live jobs</th>
                    <th className="px-4 py-3">Pipeline</th>
                    <th className="px-4 py-3">Meetings</th>
                    <th className="px-4 py-3">Terms signed</th>
                    <th className="px-4 py-3">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No team members found.</td></tr>
                  ) : (
                    rows.map(row => (
                      <React.Fragment key={row.id}>
                        <tr
                          onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                          className="border-b border-gray-50 last:border-0 cursor-pointer hover:bg-gray-50 transition-colors"
                        >
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <div
                                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                                style={{ background: avatarColor(row.name) }}
                              >
                                {initials(row.name)}
                              </div>
                              <span className="font-semibold text-navy">{row.name}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 font-semibold text-navy tabular-nums">{row.liveJobs.length}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1.5">
                              <PipelinePill label="in play" count={row.pipeline.inPlay} tone="neutral" />
                              <PipelinePill label="interviewing" count={row.pipeline.interviewing} tone="warning" />
                              <PipelinePill label="offer" count={row.pipeline.offer} tone="good" />
                              <PipelinePill label="rejected" count={row.pipeline.rejected} tone="bad" />
                            </div>
                          </td>
                          <td className="px-4 py-3 font-semibold text-navy tabular-nums">{row.meetingsCount}</td>
                          <td className="px-4 py-3 font-semibold text-navy tabular-nums">{row.termsSigned.length}</td>
                          <td className="px-4 py-3"><RevenueLines revenueByCurrency={row.revenueByCurrency} emptyLabel="-" /></td>
                        </tr>
                        {expandedId === row.id && (
                          <tr className="bg-page-bg/60">
                            <td colSpan={6} className="px-4 py-4">
                              <div className="grid md:grid-cols-3 gap-4">
                                <div>
                                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Live jobs ({row.liveJobs.length})</div>
                                  {row.liveJobs.length === 0 ? (
                                    <p className="text-xs text-gray-400">No live jobs right now.</p>
                                  ) : (
                                    <ul className="space-y-1.5">
                                      {row.liveJobs.map(j => (
                                        <li key={j.id} className="text-sm">
                                          <div className="font-medium text-navy">{j.title}</div>
                                          <div className="text-xs text-gray-500">
                                            {j.companies?.name || 'No company'} &middot; {stars(j.likelihood || 3)}
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                                <div>
                                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Terms signed ({row.termsSigned.length})</div>
                                  {row.termsSigned.length === 0 ? (
                                    <p className="text-xs text-gray-400">None credited to {row.name} this period.</p>
                                  ) : (
                                    <ul className="space-y-1.5">
                                      {row.termsSigned.map(d => (
                                        <li key={d.id} className="text-sm">
                                          <div className="font-medium text-navy truncate">{d.companies?.name || d.file_name}</div>
                                          <div className="text-xs text-gray-500">{formatDate(d.uploaded_at)}</div>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                                <div>
                                  <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Recent meetings ({row.meetings.length})</div>
                                  {row.meetings.length === 0 ? (
                                    <p className="text-xs text-gray-400">No meetings logged this period.</p>
                                  ) : (
                                    <ul className="space-y-1.5">
                                      {row.meetings.slice(0, 8).map((m, i) => (
                                        <li key={i} className="text-sm">
                                          <div className="font-medium text-navy truncate">{m.title || 'Meeting'}</div>
                                          <div className="text-xs text-gray-500">{formatDate(m.meeting_date)}</div>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

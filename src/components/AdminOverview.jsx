import React, { useState, useEffect } from 'react'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import { loadAdminOverview } from '../lib/data/adminDashboard'
import { TIERS, tierByKey } from '../lib/pricing'

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`
const TIER_SERIES = { starter: 'bg-series-1', growth: 'bg-series-2', team: 'bg-series-3' }

function Kpi({ label, value, sub, subClass = 'text-gray-400' }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-extrabold text-navy mt-1.5 tabular-nums">{value}</div>
      {sub && <div className={`text-xs font-medium mt-1.5 ${subClass}`}>{sub}</div>}
    </div>
  )
}

// A signup funnel is an ORDINAL sequence, not a set of categories — one
// hue, decreasing magnitude, direct labels. See the dataviz skill: color
// by category would miscode "this is one metric moving through ordered
// stages" as "these are five different things".
function FunnelStage({ name, count, total, isLast }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <div className="grid grid-cols-[140px_1fr_80px] items-center gap-3 py-1.5">
      <span className="text-[13px] font-semibold text-gray-700">{name}</span>
      <div className="bg-page-bg rounded-md h-6 overflow-hidden">
        <div
          className={`h-full rounded-md flex items-center justify-end pr-2.5 ${isLast ? 'bg-gold-ink' : 'bg-series-1'}`}
          style={{ width: `${Math.max(pct, 3)}%` }}
        >
          <span className="text-[11px] font-bold text-white">{count}</span>
        </div>
      </div>
      <span className="text-[11px] text-gray-400 text-right"><b className="text-gray-600">{pct}%</b> of total</span>
    </div>
  )
}

function RiskBadge({ reason }) {
  const serious = reason === 'Payment past due' || reason.includes('unpaid')
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded flex-shrink-0 w-[62px] text-center ${serious ? 'bg-status-serious text-white' : 'bg-status-warning text-navy'}`}>
      {serious ? 'Serious' : 'Warning'}
    </span>
  )
}

export default function AdminOverview({ onOpenErrors }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      setData(await loadAdminOverview())
    } catch (err) {
      setError(err.message || 'Could not load the overview.')
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (error) return <ErrorBanner>{error}</ErrorBanner>
  if (!data) return null

  const { accounts, funnel, signupTrend, teamSeats, dataQuality, errorHealth, opex } = data
  const errorDelta = errorHealth.last_24h - errorHealth.prior_24h
  const maxSignups = Math.max(1, ...signupTrend.map(d => Number(d.signups)))
  const funnelTotal = funnel?.total_signups || 0
  const opexToday = opex[opex.length - 1] || { apollo_credits: 0, anthropic_tokens: 0 }
  const APOLLO_DAILY_CAP = 500 // mirrors DEFAULT_APOLLO_DAILY_CAP in scanShared.js — display only, not enforcement
  const ANTHROPIC_DAILY_CAP = 2_000_000 // mirrors DEFAULT_ANTHROPIC_DAILY_TOKEN_CAP in chat.js/intelligence-scan.js/scan-now-background.js

  return (
    <div className="space-y-4">
      {accounts.activeAccounts === 0 && (
        <div className="card p-3.5 border-l-4 border-gold bg-yellow-50/40 text-xs text-gray-600">
          No paying accounts yet — every number below will read honestly low until real customers sign up. This page is built and ready for when they do.
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="MRR" value={money(accounts.mrr)} />
        <Kpi
          label="Active accounts"
          value={accounts.activeAccounts}
          sub={TIERS.map(t => `${accounts.tierCounts[t.key]} ${t.name}`).join(' · ')}
        />
        <Kpi label="Seats live" value={accounts.seatsLive} />
        <Kpi
          label="At-risk accounts"
          value={accounts.atRisk.length}
          sub={accounts.atRisk.length > 0 ? 'needs a look' : 'none right now'}
          subClass={accounts.atRisk.length > 0 ? 'text-status-serious' : 'text-status-good'}
        />
        <Kpi label="Canceled, last 30d" value={accounts.canceledLast30d} sub="raw count, not a rate" />
      </div>

      <div className="grid md:grid-cols-[1.4fr_1fr] gap-3">
        {/* growth */}
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy">New signups</h2>
          <p className="text-xs text-gray-400 mb-3">Daily, last 30 days</p>
          <div className="flex items-end gap-[3px] h-28">
            {signupTrend.map((d) => (
              <div
                key={d.day}
                title={`${d.signups} signup${Number(d.signups) === 1 ? '' : 's'} — ${d.day}`}
                className="flex-1 bg-series-1 rounded-t hover:opacity-75 transition-opacity"
                style={{ height: `${Math.max((Number(d.signups) / maxSignups) * 100, 3)}%` }}
              />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-gray-400 mt-1.5">
            <span>30 days ago</span><span>Today</span>
          </div>
        </div>

        {/* revenue by tier */}
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy">Revenue by tier</h2>
          <p className="text-xs text-gray-400 mb-3">Share of {money(accounts.mrr)} MRR</p>
          <div className="space-y-3">
            {TIERS.map(t => {
              const tierMrr = accounts.tierCounts[t.key] * (t.key === 'team'
                ? 0 // team is per-seat; approximated via mrr share below since seat counts vary per account
                : (t.monthly))
              const share = accounts.mrr > 0 ? Math.round((tierMrr / accounts.mrr) * 100) : 0
              return (
                <div key={t.key} className="flex items-center gap-2.5">
                  <span className={`w-2.5 h-2.5 rounded-sm flex-shrink-0 ${TIER_SERIES[t.key]}`} />
                  <span className="text-[13px] font-semibold w-16">{t.name}</span>
                  <div className="flex-1 bg-page-bg rounded-full h-2 overflow-hidden">
                    <div className={`h-full rounded-full ${TIER_SERIES[t.key]}`} style={{ width: `${Math.min(share, 100)}%` }} />
                  </div>
                  <span className="text-xs font-bold text-navy w-10 text-right">{accounts.tierCounts[t.key]}</span>
                </div>
              )
            })}
          </div>
          <p className="text-[10.5px] text-gray-400 mt-3">Team's share is approximate — MRR there depends on seats per account, not shown per-tier here.</p>
        </div>
      </div>

      {/* funnel */}
      <div className="card p-4">
        <h2 className="text-sm font-bold text-navy">Signup funnel</h2>
        <p className="text-xs text-gray-400 mb-2">Where new firms drop off — more useful than MRR alone this early</p>
        {funnel ? (
          <div>
            <FunnelStage name="Signed up" count={funnel.total_signups} total={funnelTotal} />
            <FunnelStage name="Onboarding done" count={funnel.onboarding_completed} total={funnelTotal} />
            <FunnelStage name="LinkedIn imported" count={funnel.linkedin_imported} total={funnelTotal} />
            <FunnelStage name="First scan run" count={funnel.first_scan_run} total={funnelTotal} />
            <FunnelStage name="First action taken" count={funnel.first_action_taken} total={funnelTotal} />
            <FunnelStage name="Live subscription" count={funnel.converted_to_paid} total={funnelTotal} isLast />
            <p className="text-[10.5px] text-gray-400 mt-1">"Live subscription" counts active + trialing together — it's whether they currently have a subscription relationship with Annie, not strictly "paying today".</p>
          </div>
        ) : <p className="text-sm text-gray-400">No signups yet.</p>}
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        {/* opex */}
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy">OpEx today</h2>
          <p className="text-xs text-gray-400 mb-3">Apollo &amp; Anthropic spend</p>
          <div className="mb-3">
            <div className="flex justify-between text-[13px] mb-1"><span className="font-semibold">Apollo credits</span><span className="font-bold text-navy tabular-nums">{opexToday.apollo_credits} / {APOLLO_DAILY_CAP}</span></div>
            <div className="bg-page-bg rounded-full h-1.5 overflow-hidden"><div className="h-full bg-series-1 rounded-full" style={{ width: `${Math.min((opexToday.apollo_credits / APOLLO_DAILY_CAP) * 100, 100)}%` }} /></div>
          </div>
          <div>
            <div className="flex justify-between text-[13px] mb-1"><span className="font-semibold">Anthropic tokens</span><span className="font-bold text-navy tabular-nums">{(opexToday.anthropic_tokens / 1e6).toFixed(2)}M / {(ANTHROPIC_DAILY_CAP / 1e6).toFixed(1)}M</span></div>
            <div className="bg-page-bg rounded-full h-1.5 overflow-hidden"><div className="h-full bg-series-1 rounded-full" style={{ width: `${Math.min((opexToday.anthropic_tokens / ANTHROPIC_DAILY_CAP) * 100, 100)}%` }} /></div>
          </div>
        </div>

        {/* platform health */}
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className={`w-2 h-2 rounded-full ${errorHealth.last_24h >= 5 ? 'bg-status-critical' : 'bg-status-good'}`} />
            <span className={`text-sm font-bold ${errorHealth.last_24h >= 5 ? 'text-status-critical' : 'text-status-good'}`}>
              {errorHealth.last_24h >= 5 ? 'Elevated errors' : 'All systems normal'}
            </span>
          </div>
          <p className="text-xs text-gray-500">
            <span className="font-bold text-navy tabular-nums">{errorHealth.last_24h}</span> errors, last 24h
            {errorDelta !== 0 && (
              <span className={errorDelta > 0 ? 'text-status-serious' : 'text-status-good'}> ({errorDelta > 0 ? '▲' : '▼'} from {errorHealth.prior_24h})</span>
            )}
          </p>
          {onOpenErrors && (
            <button onClick={onOpenErrors} className="inline-block mt-3 text-xs font-semibold text-gold-ink hover:underline">View full error log →</button>
          )}
        </div>

        {/* data quality */}
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy">Data quality</h2>
          <p className="text-xs text-gray-400 mb-3">Is the product actually delivering</p>
          {dataQuality ? (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-gray-500">Contacts verified</span><span className="font-bold text-navy tabular-nums">{dataQuality.signals_total > 0 ? Math.round((dataQuality.signals_contact_verified / dataQuality.signals_total) * 100) : 0}%</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Companies enriched</span><span className="font-bold text-navy tabular-nums">{dataQuality.companies_total > 0 ? Math.round((dataQuality.companies_matched / dataQuality.companies_total) * 100) : 0}%</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Signals stale (30d+, untouched)</span><span className="font-bold text-navy tabular-nums">{dataQuality.signals_stale}</span></div>
            </div>
          ) : <p className="text-sm text-gray-400">No signals yet.</p>}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {/* at-risk accounts */}
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy">At-risk accounts</h2>
          <p className="text-xs text-gray-400 mb-2">Concrete list, not just a percentage</p>
          {accounts.atRisk.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">None right now.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {accounts.atRisk.map(a => (
                <div key={a.user_id} className="flex items-center gap-2.5 py-2.5">
                  <RiskBadge reason={a.reason} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-navy truncate">{a.firm_name || a.email || 'Unknown firm'}</div>
                    <div className="text-[11px] text-gray-400">{a.reason}</div>
                  </div>
                  <span className="text-[10px] font-semibold text-gray-400 capitalize flex-shrink-0">{tierByKey(a.tier)?.name || a.tier || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* seat activation */}
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy">Team seat activation</h2>
          <p className="text-xs text-gray-400 mb-2">Invited vs. actually active, per team</p>
          {teamSeats.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">No teams yet.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {teamSeats.map(t => (
                <div key={t.team_id} className="py-2.5">
                  <div className="flex justify-between text-[13px] mb-1.5">
                    <span className="font-semibold text-navy">{t.team_name}</span>
                    <span className="font-bold text-navy tabular-nums">{t.active_members} / {t.total_members}</span>
                  </div>
                  <div className="flex gap-1">
                    {Array.from({ length: Number(t.total_members) }).map((_, i) => (
                      <div key={i} className={`w-4 h-2 rounded-sm ${i < Number(t.active_members) ? 'bg-series-3' : 'bg-page-bg'}`} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

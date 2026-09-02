import React, { useState, useEffect } from 'react'
import ErrorBanner from '../ErrorBanner'
import Spinner from '../Spinner'
import { loadAdminOverviewTab, reviewAiInsight } from '../../lib/data/adminDashboard'
import { trendDelta, bucketAtRiskReasons } from '../../lib/adminOverviewHelpers'
import { StatTile, SectionTitle, InsightCard, TrendChart } from './adminUi'

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`

export default function AdminOverviewTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      setData(await loadAdminOverviewTab())
    } catch (err) {
      setError(err.message || 'Could not load the overview.')
    } finally {
      setLoading(false)
    }
  }

  async function handleReview(id, status) {
    setBusyId(id)
    try {
      await reviewAiInsight(id, status)
      setData((prev) => ({ ...prev, aiInsights: prev.aiInsights.filter((i) => i.id !== id) }))
    } catch (err) {
      setError(err.message || 'Could not update that insight.')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (error) return <ErrorBanner>{error}</ErrorBanner>
  if (!data) return null

  const { accounts, escalationSummary, metricsTrend, aiInsights } = data
  const mrrDelta = trendDelta(metricsTrend, 'mrr')
  const accountsDelta = trendDelta(metricsTrend, 'active_accounts')
  const { billingFailed: pastDue, settingToCancel: cancelling } = bucketAtRiskReasons(accounts.atRisk)
  const pendingInsights = (aiInsights || []).filter((i) => i.status === 'new')

  return (
    <div className="space-y-5">
      {accounts.activeAccounts === 0 && (
        <div className="card p-3.5 border-l-4 border-gold bg-yellow-50/40 text-xs text-gray-600">
          No paying accounts yet, so every number below will read honestly low until real customers sign up.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          label="MRR"
          value={money(accounts.mrr)}
          sub={mrrDelta ? `${mrrDelta.diff >= 0 ? '▲' : '▼'} ${mrrDelta.pct !== null ? Math.abs(mrrDelta.pct).toFixed(1) + '%' : money(Math.abs(mrrDelta.diff))} vs 30d ago` : 'not enough history yet'}
          subClass={mrrDelta && mrrDelta.diff < 0 ? 'text-status-serious' : 'text-status-good'}
        />
        <StatTile
          label="Active accounts"
          value={accounts.activeAccounts}
          sub={accountsDelta ? `${accountsDelta.diff >= 0 ? '▲' : '▼'} ${Math.abs(accountsDelta.diff)} vs 30d ago` : 'not enough history yet'}
          subClass={accountsDelta && accountsDelta.diff < 0 ? 'text-status-serious' : 'text-status-good'}
        />
        <StatTile
          label="At risk"
          value={accounts.atRisk.length}
          valueClass={accounts.atRisk.length > 0 ? 'text-status-critical' : 'text-navy'}
          sub={accounts.atRisk.length > 0 ? `${pastDue} billing failed · ${cancelling} set to cancel` : 'none right now'}
          subClass={accounts.atRisk.length > 0 ? 'text-status-serious' : 'text-status-good'}
        />
        <StatTile
          label="Open escalations"
          value={escalationSummary.open_count}
          valueClass={escalationSummary.open_count > 0 ? 'text-status-warning' : 'text-navy'}
          sub={escalationSummary.avg_first_response_hours != null ? `avg. ${escalationSummary.avg_first_response_hours}h to first response` : 'no responses logged yet'}
        />
      </div>

      <div>
        <SectionTitle>Annie's read</SectionTitle>
        <div className="card p-4">
          {pendingInsights.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No new insights right now — Annie writes these once a day from real usage and revenue data.</p>
          ) : (
            pendingInsights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} onReview={handleReview} busy={busyId === insight.id} />
            ))
          )}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy mb-3">MRR, last 12 weeks</h2>
          <TrendChart
            labels={metricsTrend.length ? [metricsTrend[0].day, metricsTrend[metricsTrend.length - 1].day] : null}
            data={metricsTrend.map((r) => Number(r.mrr))}
            color="#c9a84c"
            format={(v) => money(v)}
          />
        </div>
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy mb-3">Signal quality trend <span className="text-xs font-normal text-gray-400">contact-verified rate</span></h2>
          <TrendChart
            labels={metricsTrend.length ? [metricsTrend[0].day, metricsTrend[metricsTrend.length - 1].day] : null}
            data={metricsTrend.filter((r) => r.contact_verified_rate != null).map((r) => Number(r.contact_verified_rate) * 100)}
            color="#2a78d6"
            format={(v) => `${Math.round(v)}%`}
          />
        </div>
      </div>
    </div>
  )
}

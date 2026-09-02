import React, { useState, useEffect, useMemo } from 'react'
import ErrorBanner from '../ErrorBanner'
import Spinner from '../Spinner'
import { loadAdminCustomersTab } from '../../lib/data/adminDashboard'
import { tierByKey } from '../../lib/pricing'
import { daysSince, initials, filterAccountRows, countChurnedWithinDays } from '../../lib/adminOverviewHelpers'
import { StatTile, SectionTitle, BarRow, Pill, NotTrackedCard } from './adminUi'

const STATUS_TONE = { active: 'good', trialing: 'neutral', past_due: 'crit', unpaid: 'crit', canceled: 'neutral' }
const STATUS_LABEL = { active: 'Active', trialing: 'Trialing', past_due: 'Past due', unpaid: 'Unpaid', canceled: 'Canceled' }

const INACTIVE_THRESHOLD_DAYS = 7

export default function AdminCustomersTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      setData(await loadAdminCustomersTab())
    } catch (err) {
      setError(err.message || 'Could not load Customers.')
    } finally {
      setLoading(false)
    }
  }

  const activityByUser = useMemo(() => {
    const map = new Map()
    for (const row of data?.activity || []) map.set(row.user_id, row.last_active_at)
    return map
  }, [data])

  const filteredRows = useMemo(() => filterAccountRows(data?.accountRows, search), [data, search])

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (error) return <ErrorBanner>{error}</ErrorBanner>
  if (!data) return null

  const { accountRows, funnel, teamSeats } = data
  const total = funnel?.total_signups || 0
  const churned90d = countChurnedWithinDays(accountRows, 90)
  const converted = funnel?.converted_to_paid || 0
  const onboarded = funnel?.onboarding_completed || 0

  const funnelStages = funnel ? [
    { name: 'Signed up', count: funnel.total_signups },
    { name: 'Onboarded', count: funnel.onboarding_completed },
    { name: 'LinkedIn imported', count: funnel.linkedin_imported },
    { name: 'First scan run', count: funnel.first_scan_run },
    { name: 'First action taken', count: funnel.first_action_taken },
    { name: 'Converted to paid', count: funnel.converted_to_paid },
  ] : []

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Total signups" value={total} sub="all-time" />
        <StatTile label="Onboarded" value={onboarded} sub={total > 0 ? `${Math.round((onboarded / total) * 100)}% of signups` : ''} />
        <StatTile label="Converted to paid" value={converted} sub={onboarded > 0 ? `${Math.round((converted / onboarded) * 100)}% of onboarded` : ''} />
        <StatTile label="Churned (90d)" value={churned90d} valueClass={churned90d > 0 ? 'text-status-critical' : 'text-navy'} sub="reason: not yet tracked" />
      </div>

      {funnel && (
        <div>
          <SectionTitle>Signup → paid funnel</SectionTitle>
          <div className="card p-4">
            {funnelStages.map((s) => (
              <BarRow key={s.name} label={s.name} pct={total > 0 ? Math.max((s.count / total) * 100, 3) : 3} value={s.count} color="bg-gold" />
            ))}
          </div>
        </div>
      )}

      {teamSeats.length > 0 && (
        <div>
          <SectionTitle>Team seat activation</SectionTitle>
          <div className="card p-4 grid md:grid-cols-2 gap-x-6 gap-y-3">
            {teamSeats.map((t) => (
              <div key={t.team_id}>
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
        </div>
      )}

      <div>
        <SectionTitle>Members</SectionTitle>
        <div className="card p-4">
          <input
            className="input max-w-xs mb-3.5 text-[12.5px] py-2"
            placeholder="Search by firm or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="pb-2 pr-3 font-bold">Account</th>
                  <th className="pb-2 pr-3 font-bold">Plan</th>
                  <th className="pb-2 pr-3 font-bold">Status</th>
                  <th className="pb-2 pr-3 font-bold">Seats</th>
                  <th className="pb-2 pr-3 font-bold">Subscribed</th>
                  <th className="pb-2 font-bold">Flag</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => {
                  const inactiveDays = daysSince(activityByUser.get(r.user_id))
                  const atRisk = r.status === 'past_due' || r.status === 'unpaid' || r.cancel_at_period_end
                  return (
                    <tr key={r.user_id} className="border-t border-gray-100">
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="w-7 h-7 rounded-full bg-page-bg text-gray-500 text-[11px] font-bold flex items-center justify-center flex-shrink-0">{initials(r.firm_name)}</span>
                          <div className="min-w-0">
                            <div className="font-semibold text-navy truncate">{r.firm_name || 'Unknown firm'}</div>
                            <div className="text-[11px] text-gray-400 truncate">{r.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">{tierByKey(r.tier)?.name || r.tier || '—'}</td>
                      <td className="py-2.5 pr-3"><Pill tone={STATUS_TONE[r.status] || 'neutral'}>{STATUS_LABEL[r.status] || r.status}</Pill></td>
                      <td className="py-2.5 pr-3 tabular-nums">{r.seats || 1}</td>
                      <td className="py-2.5 pr-3 text-gray-500">{r.subscription_created_at ? new Date(r.subscription_created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}</td>
                      <td className="py-2.5">
                        {atRisk ? <Pill tone="crit">At risk</Pill>
                          : inactiveDays !== null && inactiveDays >= INACTIVE_THRESHOLD_DAYS ? <Pill tone="warn">Inactive {inactiveDays}d</Pill>
                          : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {filteredRows.length === 0 && <p className="text-sm text-gray-400 py-6 text-center">No accounts match "{search}".</p>}
        </div>
      </div>

      <div>
        <SectionTitle>Not yet tracked</SectionTitle>
        <div className="grid md:grid-cols-3 gap-3">
          <NotTrackedCard title="Churn reason">Needs a Stripe portal cancellation survey wired up.</NotTrackedCard>
          <NotTrackedCard title="Signup source / attribution">Needs UTM capture added to the marketing site.</NotTrackedCard>
          <NotTrackedCard title="Satisfaction / NPS">Needs a new in-app prompt and table.</NotTrackedCard>
        </div>
      </div>
    </div>
  )
}

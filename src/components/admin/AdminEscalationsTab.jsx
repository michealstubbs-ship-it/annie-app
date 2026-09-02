import React, { useState, useEffect, useMemo } from 'react'
import ErrorBanner from '../ErrorBanner'
import Spinner from '../Spinner'
import { loadAdminEscalationsTab, reviewEscalation } from '../../lib/data/adminDashboard'
import { tierByKey } from '../../lib/pricing'
import { timeAgo, countEscalationsFromChurnedAccounts } from '../../lib/adminOverviewHelpers'
import { StatTile, Pill } from './adminUi'

const STATUS_TONE = { open: 'crit', in_progress: 'warn', resolved: 'good' }
const STATUS_LABEL = { open: 'Open — unassigned', in_progress: 'Open — in progress', resolved: 'Resolved' }
const CATEGORY_LABEL = {
  refund_billing: 'Refund/billing dispute', data_request: 'Data request', bug_report: 'Reproducible bug',
  human_requested: 'Asked for a human', unresolved: 'Unresolved conversation',
}

export default function AdminEscalationsTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      setData(await loadAdminEscalationsTab())
    } catch (err) {
      setError(err.message || 'Could not load Client Escalations.')
    } finally {
      setLoading(false)
    }
  }

  const tierByUser = useMemo(() => {
    const map = new Map()
    for (const r of data?.accountRows || []) map.set(r.user_id, r.tier)
    return map
  }, [data])

  async function advanceStatus(escalation) {
    const next = escalation.status === 'open' ? 'in_progress' : 'resolved'
    setBusyId(escalation.id)
    try {
      await reviewEscalation(escalation.id, next)
      setData((prev) => ({
        ...prev,
        escalations: prev.escalations.map((e) => (e.id === escalation.id ? { ...e, status: next } : e)),
      }))
    } catch (err) {
      setError(err.message || 'Could not update that escalation.')
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (error) return <ErrorBanner>{error}</ErrorBanner>
  if (!data) return null

  const { escalations, summary, accountRows } = data
  const churnedCount = countEscalationsFromChurnedAccounts(escalations, accountRows)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Open" value={summary.open_count} valueClass={summary.open_count > 0 ? 'text-status-critical' : 'text-navy'} sub={summary.open_count > 0 ? 'needs a human' : 'none right now'} />
        <StatTile label="Avg. time to first response" value={summary.avg_first_response_hours != null ? `${summary.avg_first_response_hours}h` : '—'} />
        <StatTile label="Resolved (30d)" value={summary.resolved_30d_count} sub="same single inbox, all tiers" />
        <StatTile label="Escalations → churned" value={escalations.length > 0 ? `${churnedCount} of ${escalations.length}` : '—'} sub="account since canceled" />
      </div>

      <div className="card p-4">
        {escalations.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">No escalations yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="pb-2 pr-3 font-bold">Account</th>
                  <th className="pb-2 pr-3 font-bold">Plan</th>
                  <th className="pb-2 pr-3 font-bold">Issue</th>
                  <th className="pb-2 pr-3 font-bold">Opened</th>
                  <th className="pb-2 font-bold">Status</th>
                </tr>
              </thead>
              <tbody>
                {escalations.map((e) => (
                  <tr key={e.id} className="border-t border-gray-100">
                    <td className="py-2.5 pr-3 font-semibold text-navy">{e.firm_name || e.customer_email || 'Unknown'}</td>
                    <td className="py-2.5 pr-3">{tierByKey(tierByUser.get(e.user_id))?.name || '—'}</td>
                    <td className="py-2.5 pr-3 text-gray-600 max-w-xs truncate" title={e.excerpt}>{CATEGORY_LABEL[e.category] || e.category || 'Unresolved'}</td>
                    <td className="py-2.5 pr-3 text-gray-500">{timeAgo(e.created_at)}</td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <Pill tone={STATUS_TONE[e.status] || 'neutral'}>{STATUS_LABEL[e.status] || e.status}</Pill>
                        {e.status !== 'resolved' && (
                          <button
                            disabled={busyId === e.id}
                            onClick={() => advanceStatus(e)}
                            className="text-[11px] font-semibold text-gold-ink hover:underline disabled:opacity-50"
                          >
                            {e.status === 'open' ? 'Start' : 'Resolve'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11.5px] text-gray-400 mt-3">Same single inbox for every tier today — no priority-support split (see src/lib/pricing.js).</p>
      </div>
    </div>
  )
}

import React, { useState, useEffect, useMemo } from 'react'
import ErrorBanner from '../ErrorBanner'
import Spinner from '../Spinner'
import { loadAdminProductTab } from '../../lib/data/adminDashboard'
import { groupErrorsBySource } from '../../lib/adminOverviewHelpers'
import { StatTile, SectionTitle, BarRow, Pill, NotTrackedCard } from './adminUi'

export default function AdminProductTab({ onOpenErrors }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      setData(await loadAdminProductTab())
    } catch (err) {
      setError(err.message || 'Could not load Product & Engineering.')
    } finally {
      setLoading(false)
    }
  }

  const errorsBySource = useMemo(() => groupErrorsBySource(data?.errorLogs || []), [data])

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (error) return <ErrorBanner>{error}</ErrorBanner>
  if (!data) return null

  const { accounts, errorHealth, dataQuality, marketCoverage, featureAdoption } = data
  const errorDelta = errorHealth.last_24h - errorHealth.prior_24h
  const contactVerifiedPct = dataQuality && dataQuality.signals_total > 0 ? Math.round((dataQuality.signals_contact_verified / dataQuality.signals_total) * 100) : null
  const companyMatchedPct = dataQuality && dataQuality.companies_total > 0 ? Math.round((dataQuality.companies_matched / dataQuality.companies_total) * 100) : null
  const thin = (marketCoverage || []).filter((p) => p.thin)

  const maxAdoptionUsers = Math.max(1, ...(featureAdoption?.pages || []).map((p) => p.usersLast30d))

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          label="Errors, last 24h"
          value={errorHealth.last_24h}
          valueClass={errorHealth.last_24h >= 5 ? 'text-status-critical' : 'text-navy'}
          sub={errorDelta !== 0 ? `${errorDelta > 0 ? '▲' : '▼'} vs ${errorHealth.prior_24h} prior 24h` : 'flat vs prior 24h'}
          subClass={errorDelta > 0 ? 'text-status-serious' : 'text-status-good'}
        />
        <StatTile label="Contact-verified rate" value={contactVerifiedPct !== null ? `${contactVerifiedPct}%` : '—'} sub="of intelligence signals" />
        <StatTile label="Company-matched rate" value={companyMatchedPct !== null ? `${companyMatchedPct}%` : '—'} sub="of company enrichment" />
        <StatTile label="Stale signals (30d+)" value={dataQuality?.signals_stale ?? 0} sub="untouched" />
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy mb-3">Feature adoption <span className="text-xs font-normal text-gray-400">users, last 30 days</span></h2>
          {!featureAdoption?.configured ? (
            <NotTrackedCard title="PostHog not connected">Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID in Netlify to see real feature usage here.</NotTrackedCard>
          ) : featureAdoption.pages.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No pageview data yet.</p>
          ) : (
            featureAdoption.pages.slice(0, 8).map((p) => (
              <BarRow
                key={p.path}
                label={p.label}
                pct={(p.usersLast30d / maxAdoptionUsers) * 100}
                value={`${p.usersLast30d} user${p.usersLast30d === 1 ? '' : 's'}`}
                color={accounts.activeAccounts > 0 && p.usersLast30d / accounts.activeAccounts >= 0.5 ? 'bg-status-good' : 'bg-status-warning'}
              />
            ))
          )}
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy mb-3">Errors by source <span className="text-xs font-normal text-gray-400">last 24h · {errorHealth.last_24h} total</span></h2>
          {errorsBySource.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No errors in the last 24h.</p>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {errorsBySource.slice(0, 8).map(([source, count]) => (
                  <tr key={source} className="border-t border-gray-100 first:border-t-0">
                    <td className="py-2 text-gray-600 font-mono text-[12px] truncate">{source}</td>
                    <td className="py-2 text-right font-bold text-navy tabular-nums">{count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {onOpenErrors && (
            <button onClick={onOpenErrors} className="inline-block mt-3 text-xs font-semibold text-gold-ink hover:underline">View full error log →</button>
          )}
        </div>
      </div>

      <div>
        <SectionTitle note="sectors/locations returning few or no signals">Market coverage gaps</SectionTitle>
        <div className="card p-4">
          {!marketCoverage || marketCoverage.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">No scan history yet.</p>
          ) : thin.length === 0 ? (
            <p className="text-sm text-status-good py-2">Nothing structurally thin right now.</p>
          ) : (
            <div className="divide-y divide-gray-100">
              {thin.map((p) => {
                const underInformed = p.likelyCause === 'annie_under_informed'
                return (
                  <div key={`${p.sector}|${p.location}`} className="flex items-center gap-2.5 py-2.5">
                    <Pill tone="warn">Thin</Pill>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-navy truncate">{p.sector} · {p.location}</div>
                      <div className="text-[11px] text-gray-400">{p.scans} scans across {p.distinctCustomers} customer{p.distinctCustomers === 1 ? '' : 's'}, 0 signals found</div>
                    </div>
                    <Pill tone={underInformed ? 'neutral' : 'neutral'}>{underInformed ? `Annie under-informed (${p.knownCompanies + p.knownSources} known)` : `Genuinely quiet (${p.knownCompanies + p.knownSources} known)`}</Pill>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

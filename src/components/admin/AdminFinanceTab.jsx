import React, { useState, useEffect } from 'react'
import ErrorBanner from '../ErrorBanner'
import Spinner from '../Spinner'
import { loadAdminFinanceTab } from '../../lib/data/adminDashboard'
import { TIERS } from '../../lib/pricing'
import { StatTile, SectionTitle, BarRow, Pill } from './adminUi'

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`

// The one real, confirmed $/credit rate in this codebase — Michael checked
// TheirStack's own pricing page directly (see Annie-Cost-Analysis-50-100-
// Clients.md, "Resolved this session: TheirStack is live"): the 20,000-
// credits/month tier costs $240/mo flat, i.e. $12/1,000 credits. Apollo and
// Anthropic have NO equally-confirmed $/unit rate anywhere in this codebase
// — the cost-analysis doc's Apollo/Anthropic figures are modeled call-
// volume estimates, not a clean per-credit/per-token rate that could be
// multiplied against a live usage count. Rather than guess at one (which
// would silently present an invented number as if it were live data), this
// tab shows Apollo/Anthropic usage in their own native units and only
// converts TheirStack to real dollars.
const THEIRSTACK_COST_PER_CREDIT = 0.012

// Modeled per-account unit economics from Annie-Cost-Analysis-50-100-
// Clients.md (dated 26 Aug 2026) — NOT live-tracked, because that would
// need the same missing Apollo/Anthropic $/unit rate above. Shown as a
// clearly-dated reference figure, never mixed into a number presented as
// live, so it can never be mistaken for real-time data.
const MODELED_UNIT_ECONOMICS = {
  starter: { costPerAccount: 20.60, marginPct: 74 },
  growth: { costPerAccount: 40.15, marginPct: 69 },
  team: { costPerAccount: 40.15, marginPct: 59 }, // per seat
}

export default function AdminFinanceTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      setData(await loadAdminFinanceTab())
    } catch (err) {
      setError(err.message || 'Could not load Finance.')
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>
  if (error) return <ErrorBanner>{error}</ErrorBanner>
  if (!data) return null

  const { accounts, opex, resourceCaps } = data
  const opexToday = opex[opex.length - 1] || { apollo_credits: 0, theirstack_credits: 0, anthropic_tokens: 0 }
  const opex30dTotals = opex.reduce((acc, d) => ({
    apollo: acc.apollo + (Number(d.apollo_credits) || 0),
    theirstack: acc.theirstack + (Number(d.theirstack_credits) || 0),
    anthropic: acc.anthropic + (Number(d.anthropic_tokens) || 0),
  }), { apollo: 0, theirstack: 0, anthropic: 0 })
  const theirStackSpend30d = opex30dTotals.theirstack * THEIRSTACK_COST_PER_CREDIT
  const caps = resourceCaps || { apollo: 1, theirStack: 1, anthropicTokens: 1 }
  const maxUsage = Math.max(opex30dTotals.apollo, opex30dTotals.theirstack, opex30dTotals.anthropic / 1000, 1)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="MRR" value={money(accounts.mrr)} />
        <StatTile label="Active accounts" value={accounts.activeAccounts} />
        <StatTile label="TheirStack spend (30d)" value={money(theirStackSpend30d)} sub="the one vendor with a confirmed $/credit rate" />
        <StatTile label="Seats live" value={accounts.seatsLive} />
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy mb-3">Vendor usage, last 30 days</h2>
          <BarRow label="Apollo" pct={Math.min((opex30dTotals.apollo / maxUsage) * 100, 100)} value={`${Math.round(opex30dTotals.apollo).toLocaleString()} cr`} color="bg-series-1" />
          <BarRow label="TheirStack" pct={Math.min((opex30dTotals.theirstack / maxUsage) * 100, 100)} value={`${money(theirStackSpend30d)}`} color="bg-gold" />
          <BarRow label="Anthropic" pct={Math.min(((opex30dTotals.anthropic / 1000) / maxUsage) * 100, 100)} value={`${(opex30dTotals.anthropic / 1e6).toFixed(2)}M tok`} color="bg-series-3" />
          <p className="text-[11.5px] text-gray-400 mt-2.5">Apollo and Anthropic shown in native usage units — no confirmed $/unit rate for either exists yet to convert them to real dollars (see this card's own note in code). Netlify &amp; Supabase plan fees aren't tracked here at all; they're flat monthly fees, not usage-metered.</p>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-bold text-navy mb-3">Cost-cap headroom <span className="text-xs font-normal text-gray-400">today, platform-wide</span></h2>
          <BarRow label="Apollo credits" pct={Math.min((opexToday.apollo_credits / caps.apollo) * 100, 100)} value={`${opexToday.apollo_credits}/${caps.apollo}`} color="bg-series-1" />
          <BarRow label="TheirStack" pct={Math.min((opexToday.theirstack_credits / caps.theirStack) * 100, 100)} value={`${opexToday.theirstack_credits}/${caps.theirStack}`} color="bg-series-2" />
          <BarRow label="Anthropic" pct={Math.min((opexToday.anthropic_tokens / caps.anthropicTokens) * 100, 100)} value={`${(opexToday.anthropic_tokens / 1e6).toFixed(2)}M/${(caps.anthropicTokens / 1e6).toFixed(1)}M`} color="bg-series-3" />
          <p className="text-[11.5px] text-gray-400 mt-2.5">This is runway before real scans start getting throttled today, not a cost figure.</p>
        </div>
      </div>

      <div>
        <SectionTitle>Unit economics by tier</SectionTitle>
        <div className="card p-4">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="pb-2 pr-3 font-bold">Tier</th>
                  <th className="pb-2 pr-3 font-bold">Accounts</th>
                  <th className="pb-2 pr-3 font-bold">Price</th>
                  <th className="pb-2 pr-3 font-bold">MRR</th>
                  <th className="pb-2 pr-3 font-bold">Modeled cost/acct*</th>
                  <th className="pb-2 font-bold">Modeled margin*</th>
                </tr>
              </thead>
              <tbody>
                {TIERS.map((t) => {
                  const modeled = MODELED_UNIT_ECONOMICS[t.key]
                  return (
                    <tr key={t.key} className="border-t border-gray-100">
                      <td className="py-2.5 pr-3 font-semibold text-navy">{t.name}{t.perSeat ? ' (per seat)' : ''}</td>
                      <td className="py-2.5 pr-3 tabular-nums">{accounts.tierCounts[t.key]}</td>
                      <td className="py-2.5 pr-3 tabular-nums">${t.monthly}</td>
                      <td className="py-2.5 pr-3 tabular-nums font-bold text-navy">{money(accounts.tierMrr[t.key])}</td>
                      <td className="py-2.5 pr-3 tabular-nums text-gray-500">${modeled.costPerAccount.toFixed(2)}</td>
                      <td className="py-2.5"><Pill tone={modeled.marginPct >= 60 ? 'good' : 'warn'}>{modeled.marginPct}%</Pill></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11.5px] text-gray-400 mt-2.5">*Modeled estimate from Annie-Cost-Analysis-50-100-Clients.md (26 Aug 2026), not live-tracked — Apollo/Anthropic have no confirmed $/unit rate yet to compute this in real time (see above). Accounts/Price/MRR columns are real, live data.</p>
        </div>
      </div>
    </div>
  )
}

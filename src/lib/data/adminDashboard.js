import { supabase } from '../supabase'
import { monthlyRevenueFor } from '../pricing'

// Every raw call the admin operator dashboard (Insights.jsx's Overview tab)
// makes, in one place — same reasoning as contacts.js/companies.js/etc.
// Every RPC here is admin-gated server-side (2026-08-24-admin-operator-
// dashboard.sql — the same is_admin-checking SECURITY DEFINER pattern as
// get_support_insights/get_error_logs/get_account_requests); a non-admin
// calling any of these gets a thrown "Not authorized" from Postgres itself,
// not just a client-side hide. Insights.jsx additionally only renders this
// tab for is_admin users, same belt-and-braces reasoning as the rest of
// this page.

const LIVE_STATUSES = new Set(['active', 'trialing'])
const AT_RISK_STATUSES = new Set(['past_due', 'unpaid'])

// Raw account rows -> everything the Overview tab's top section needs.
// Kept as one pass over the rows rather than several separate reduces, so
// there's exactly one place that decides what "active"/"at risk" means.
export function summarizeAccounts(rows) {
  const accounts = rows || []
  let mrr = 0
  let activeAccounts = 0
  let seatsLive = 0
  let canceledLast30d = 0
  const tierCounts = { starter: 0, growth: 0, team: 0 }
  // 2026-08-26 audit fix: AdminOverview.jsx's "Revenue by tier" chart used
  // to approximate each tier's revenue as `tierCounts[tier] * t.monthly` —
  // always the full, non-discounted monthly price, regardless of how many
  // of those accounts are actually on annual billing (cheaper per month,
  // see pricing.js's own header) or, for Team, how many seats each account
  // actually has. That inflated a tier's apparent share whenever any
  // account in it was on an annual or multi-seat plan. monthlyRevenueFor
  // already computes the real, billing_interval- and seat-aware $/month
  // per row for the overall `mrr` total below — summing it per tier here
  // gives the chart the same real number instead of a second, wrong guess.
  const tierMrr = { starter: 0, growth: 0, team: 0 }
  const atRisk = []
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

  for (const row of accounts) {
    const isLive = LIVE_STATUSES.has(row.status)
    if (isLive) {
      activeAccounts += 1
      const rowMrr = monthlyRevenueFor(row)
      mrr += rowMrr
      seatsLive += row.tier === 'team' ? Math.max(1, Number(row.seats) || 1) : 1
      if (row.tier && tierCounts[row.tier] !== undefined) {
        tierCounts[row.tier] += 1
        tierMrr[row.tier] += rowMrr
      }
    }

    if (AT_RISK_STATUSES.has(row.status)) {
      atRisk.push({ ...row, reason: row.status === 'past_due' ? 'Payment past due' : 'Payment method failed (unpaid)' })
    } else if (isLive && row.cancel_at_period_end) {
      atRisk.push({ ...row, reason: 'Set to cancel at period end' })
    }

    // A raw count, deliberately, not a percentage: a true churn *rate*
    // needs a stable "how many were active at the start of the period"
    // denominator, which nothing here snapshots — showing a fabricated %
    // would imply more precision than the data actually supports.
    // subscription_updated_at (not created_at) is what tells us when the
    // status last changed — stripe-webhook.js touches it on every status
    // transition including cancellation.
    if (row.status === 'canceled' && row.subscription_updated_at) {
      if (Date.parse(row.subscription_updated_at) >= thirtyDaysAgo) canceledLast30d += 1
    }
  }

  return { mrr, activeAccounts, seatsLive, canceledLast30d, tierCounts, tierMrr, atRisk }
}

export async function getAdminAccountSummary() {
  const { data, error } = await supabase.rpc('get_admin_account_summary')
  if (error) throw error
  return summarizeAccounts(data)
}

export async function getAdminFunnel() {
  const { data, error } = await supabase.rpc('get_admin_funnel')
  if (error) throw error
  return (data && data[0]) || null
}

export async function getAdminSignupTrend(days = 30) {
  const { data, error } = await supabase.rpc('get_admin_signup_trend', { p_days: days })
  if (error) throw error
  return data || []
}

export async function getAdminTeamSeats() {
  const { data, error } = await supabase.rpc('get_admin_team_seats')
  if (error) throw error
  return data || []
}

export async function getAdminDataQuality() {
  const { data, error } = await supabase.rpc('get_admin_data_quality')
  if (error) throw error
  return (data && data[0]) || null
}

export async function getAdminErrorHealth() {
  const { data, error } = await supabase.rpc('get_admin_error_health')
  if (error) throw error
  return (data && data[0]) || { last_24h: 0, prior_24h: 0 }
}

export async function getAdminOpex(days = 30) {
  const { data, error } = await supabase.rpc('get_admin_opex', { p_days: days })
  if (error) throw error
  return data || []
}

// Not a Postgres RPC like everything above — the daily caps the OpEx panel
// compares spend against live in application code (resolveResourceCaps()
// in netlify/functions/lib/entitlements.js) and Netlify env vars, not in
// the database, so this goes through the one endpoint that can actually
// read them: admin-resource-caps.js. Same is_admin gate as every RPC above,
// just enforced server-side in JS instead of inside a SECURITY DEFINER
// function, because that's where the data actually lives. Exists so the
// dashboard never holds its own separate copy of these numbers again (see
// that function's own header for the stale-hardcoded-constants bug this
// replaced).
export async function getAdminResourceCaps() {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Your session has expired. Please log in again.')
  const res = await fetch('/.netlify/functions/admin-resource-caps', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error || 'Could not load resource caps.')
  return body
}

// 2026-08-27: same shape and same reasoning as getAdminResourceCaps just
// above — this data lives in Postgres (market_coverage_log), so it COULD
// have been a SECURITY DEFINER RPC like most of the others, but the
// aggregation logic already exists, unit-tested, in scanShared.js
// (getMarketCoverageReport) — a JS endpoint reusing it directly avoids a
// second, separate implementation of the same aggregation drifting out of
// sync with the first.
export async function getAdminMarketCoverage() {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Your session has expired. Please log in again.')
  const res = await fetch('/.netlify/functions/admin-market-coverage', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error || 'Could not load market coverage.')
  return body.pairs || []
}

// Everything the Overview tab needs, fetched together. Any single failed
// call throws (Promise.all), same "fail loud, don't render a half-true
// dashboard" choice Insights.jsx's own load() already makes for its three
// existing RPCs.
export async function loadAdminOverview() {
  const [accounts, funnel, signupTrend, teamSeats, dataQuality, errorHealth, opex, resourceCaps, marketCoverage] = await Promise.all([
    getAdminAccountSummary(),
    getAdminFunnel(),
    getAdminSignupTrend(30),
    getAdminTeamSeats(),
    getAdminDataQuality(),
    getAdminErrorHealth(),
    getAdminOpex(30),
    getAdminResourceCaps(),
    getAdminMarketCoverage(),
  ])
  return { accounts, funnel, signupTrend, teamSeats, dataQuality, errorHealth, opex, resourceCaps, marketCoverage }
}

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

// The raw per-account rows behind getAdminAccountSummary's aggregate —
// needed wherever a tab renders one row per account (the Customers tab's
// Members table, the Escalations tab's plan-per-escalation lookup) rather
// than only a summarized total. Same RPC, no second implementation.
export async function getAdminAccountRows() {
  const { data, error } = await supabase.rpc('get_admin_account_summary')
  if (error) throw error
  return data || []
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

// ---------------------------------------------------------------------
// 2026-09-02: Annie Overview — the 5-tab rebuild. Each tab below fetches
// only what IT needs, independently of every other tab, on purpose: the
// single biggest lesson from this dashboard's first version was that one
// broken RPC (get_admin_opex's bigint-cast bug) blanked the ENTIRE page
// behind one error banner, including sections that had nothing to do with
// the broken query. Splitting the fetch per tab means a broken Finance
// query only ever blanks the Finance tab.
// ---------------------------------------------------------------------

export async function getAdminEscalations() {
  const { data, error } = await supabase.rpc('get_admin_escalations')
  if (error) throw error
  return data || []
}

export async function getAdminEscalationSummary() {
  const { data, error } = await supabase.rpc('get_admin_escalation_summary')
  if (error) throw error
  return (data && data[0]) || { open_count: 0, in_progress_count: 0, resolved_30d_count: 0, avg_first_response_hours: null }
}

export async function reviewEscalation(id, status) {
  const { error } = await supabase.rpc('admin_update_escalation_status', { p_id: id, p_status: status })
  if (error) throw error
}

export async function getAdminAccountActivity() {
  const { data, error } = await supabase.rpc('get_admin_account_activity')
  if (error) throw error
  return data || []
}

export async function getAdminMetricsTrend(days = 84) {
  const { data, error } = await supabase.rpc('get_admin_metrics_trend', { p_days: days })
  if (error) throw error
  return data || []
}

export async function getAdminAiInsights(days = 30) {
  const { data, error } = await supabase.rpc('get_admin_ai_insights', { p_days: days })
  if (error) throw error
  return data || []
}

export async function reviewAiInsight(id, status) {
  const { error } = await supabase.rpc('admin_review_insight', { p_id: id, p_status: status })
  if (error) throw error
}

// Same shape/reasoning as getAdminResourceCaps/getAdminMarketCoverage
// above — this data lives in PostHog, not Postgres, so it goes through the
// one Netlify function that can actually reach it (admin-feature-
// adoption.js). Returns { configured: false } as-is when PostHog isn't
// wired up yet, so the caller can render a "connect PostHog" prompt
// instead of treating an unconfigured integration as an error.
export async function getAdminFeatureAdoption() {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('Your session has expired. Please log in again.')
  // 2026-09-02 audit fix, real report ("Product & Engineering is still
  // broken"): admin-feature-adoption.js declares a custom Netlify
  // Functions path (config.path = '/api/admin-feature-adoption'), which
  // per Netlify's own routing rules means the default
  // '/.netlify/functions/admin-feature-adoption' alias no longer resolves
  // at all once a custom path is set — only '/api/admin-feature-adoption'
  // does. This was calling the default path, so every load hit Netlify's
  // SPA fallback (index.html) instead of the function, and res.json()
  // failed on the HTML with "Unexpected token '<'". Same class of bug
  // already fixed in callChat.js/Billing.jsx/LinkedInImport.jsx.
  const res = await fetch('/api/admin-feature-adoption', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error || 'Could not load feature adoption.')
  return body
}

// Overview tab: MRR/at-risk/escalations snapshot + trend charts + Annie's
// Read. Deliberately light — this is the tab open by default, so it should
// never wait on the heavier per-tab queries (funnel history, error logs,
// full member list) the other four tabs own instead.
export async function loadAdminOverviewTab() {
  const [accounts, escalationSummary, metricsTrend, aiInsights] = await Promise.all([
    getAdminAccountSummary(),
    getAdminEscalationSummary(),
    getAdminMetricsTrend(84),
    getAdminAiInsights(30),
  ])
  return { accounts, escalationSummary, metricsTrend, aiInsights }
}

// Finance tab: revenue, real vendor spend where a real $/unit rate is
// actually confirmed, and cost-cap headroom.
export async function loadAdminFinanceTab() {
  const [accounts, opex, resourceCaps] = await Promise.all([
    getAdminAccountSummary(),
    getAdminOpex(30),
    getAdminResourceCaps(),
  ])
  return { accounts, opex, resourceCaps }
}

// Customers tab: signup funnel, team seat activation, and the full member
// list (with real inactivity flags from profiles.last_active_at).
export async function loadAdminCustomersTab() {
  const [accountRows, funnel, signupTrend, teamSeats, activity] = await Promise.all([
    getAdminAccountRows(),
    getAdminFunnel(),
    getAdminSignupTrend(30),
    getAdminTeamSeats(),
    getAdminAccountActivity(),
  ])
  return { accountRows, funnel, signupTrend, teamSeats, activity }
}

// Product & Engineering tab: error health, signal/company data quality,
// market coverage gaps, and real feature adoption (from PostHog).
export async function loadAdminProductTab() {
  const [accounts, errorHealth, errorLogs, dataQuality, marketCoverage, featureAdoption] = await Promise.all([
    getAdminAccountSummary(),
    getAdminErrorHealth(),
    supabase.rpc('get_error_logs').then(({ data, error }) => { if (error) throw error; return data || [] }),
    getAdminDataQuality(),
    getAdminMarketCoverage(),
    getAdminFeatureAdoption(),
  ])
  return { accounts, errorHealth, errorLogs, dataQuality, marketCoverage, featureAdoption }
}

// Client Escalations tab: the full escalation list plus enough account
// context (tier, and whether that account has since churned) to answer
// "does this predict churn" honestly rather than just listing rows.
export async function loadAdminEscalationsTab() {
  const [escalations, summary, accountRows] = await Promise.all([
    getAdminEscalations(),
    getAdminEscalationSummary(),
    getAdminAccountRows(),
  ])
  return { escalations, summary, accountRows }
}

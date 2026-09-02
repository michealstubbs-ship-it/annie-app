// Pure logic behind the 5 Annie Overview tabs, pulled out of the
// components themselves so it's independently testable — same reasoning
// as summarizeAccounts living in adminDashboard.js rather than inline in
// AdminOverview.jsx: this codebase keeps business logic in src/lib/*.js
// and JSX components thin, everywhere else (pricing.js, signalOutcomes.js,
// candidateMatch.js), and there's no reason for the admin dashboard to be
// the one place that breaks that pattern.

// Vendor $/unit rates behind estimateVendorSpend below. Two different
// confidence levels, kept explicit rather than blurred into one column:
//
// - THEIRSTACK_COST_PER_CREDIT is CONFIRMED — Michael checked TheirStack's
//   own pricing page directly (Annie-Cost-Analysis-50-100-Clients.md,
//   "Resolved this session: TheirStack is live"): the 20,000-credits/month
//   tier costs $240/mo flat, i.e. $12/1,000 credits.
// - APOLLO_COST_PER_CREDIT and the two ANTHROPIC_COST_PER_MILLION_* rates
//   are PUBLISHED LIST rates, not confirmed against Michael's actual
//   invoice the way TheirStack's is — real numbers from the vendors' own
//   published pricing (checked 2026-09-02), but his actual negotiated/
//   effective rate could differ, same caveat the original cost-analysis
//   doc raised about TheirStack before it was confirmed.
//   - Apollo: no single published $/credit rate exists — apollo.io's own
//     pricing page doesn't disclose credit costs directly. Using the
//     Professional plan's effective rate (2,000 export credits included
//     in a $99/mo plan) as the representative self-serve figure: $99/2,000
//     = $0.0495/credit. Basic ($59/1,000 = $0.059) and Organization
//     ($149/4,000 = $0.03725) bracket this; Professional is the middle
//     estimate, not a confirmed number for Annie's specific plan.
//   - Anthropic: Claude Haiku 4.5's published API rate is $1/million input
//     tokens, $5/million output tokens (anthropic.com/claude/haiku,
//     checked 2026-09-02) — a real, current, asymmetric rate. The
//     anthropic_usage/anthropic_usage_platform tables only ever record a
//     single combined tokens_used figure, not input vs. output separately,
//     so there's no way to apply the exact split to real usage data. The
//     blended rate below assumes roughly an 85/15 input/output mix, typical
//     of this app's calls (a large system-prompt-plus-context input, a much
//     shorter structured JSON/text output) — an estimate, not a precise
//     conversion, and called out as such everywhere it's shown.
export const THEIRSTACK_COST_PER_CREDIT = 0.012
export const APOLLO_COST_PER_CREDIT = 0.0495
const ANTHROPIC_COST_PER_MILLION_INPUT = 1
const ANTHROPIC_COST_PER_MILLION_OUTPUT = 5
const ANTHROPIC_ASSUMED_INPUT_SHARE = 0.85
export const ANTHROPIC_BLENDED_COST_PER_MILLION_TOKENS =
  ANTHROPIC_ASSUMED_INPUT_SHARE * ANTHROPIC_COST_PER_MILLION_INPUT +
  (1 - ANTHROPIC_ASSUMED_INPUT_SHARE) * ANTHROPIC_COST_PER_MILLION_OUTPUT

// Real vendor usage totals (credits/tokens) -> a real dollar estimate for
// each. Every figure here is a genuine, cited rate — see the constants'
// own comments above for exactly which are confirmed vs. published-list —
// never an invented number. `confidence` lets the caller distinguish the
// one confirmed rate from the two estimated ones in how it's rendered.
export function estimateVendorSpend({ apolloCredits = 0, theirstackCredits = 0, anthropicTokens = 0 } = {}) {
  return {
    apollo: { amount: apolloCredits * APOLLO_COST_PER_CREDIT, confidence: 'estimated' },
    theirstack: { amount: theirstackCredits * THEIRSTACK_COST_PER_CREDIT, confidence: 'confirmed' },
    anthropic: { amount: (anthropicTokens / 1_000_000) * ANTHROPIC_BLENDED_COST_PER_MILLION_TOKENS, confidence: 'estimated' },
  }
}

// Real month-over-month delta from the daily metrics-snapshot history —
// "vs ~30 days ago" using the closest available real comparison point,
// never a fabricated "vs last calendar month" (nothing here tracks
// calendar-month boundaries).
export function trendDelta(rows, key, daysAgo = 30) {
  if (!rows || rows.length < 2) return null
  const latest = rows[rows.length - 1]
  const target = new Date(latest.day)
  target.setDate(target.getDate() - daysAgo)
  let comparison = rows[0]
  for (const row of rows) {
    if (new Date(row.day) <= target) comparison = row
  }
  if (comparison === latest) return null
  const from = Number(comparison[key])
  const to = Number(latest[key])
  if (!isFinite(from) || !isFinite(to)) return null
  return { from, to, diff: to - from, pct: from !== 0 ? ((to - from) / from) * 100 : null }
}

// Groups get_error_logs' raw rows into "errors by source" for the Product
// & Engineering tab, restricted to the last 24h — the same window
// get_admin_error_health already reports its headline count for, so the
// breakdown's total matches the KPI tile above it.
export function groupErrorsBySource(errorLogs, now = Date.now()) {
  const dayAgo = now - 24 * 60 * 60 * 1000
  const counts = new Map()
  for (const e of errorLogs || []) {
    if (Date.parse(e.created_at) < dayAgo) continue
    const key = e.source === 'function' ? (e.fn_name || 'function') : 'client'
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

export function daysSince(iso, now = Date.now()) {
  if (!iso) return null
  return Math.floor((now - new Date(iso).getTime()) / (24 * 60 * 60 * 1000))
}

export function initials(name) {
  if (!name) return '—'
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')
}

export function timeAgo(iso, now = Date.now()) {
  const ms = now - new Date(iso).getTime()
  const hours = Math.round(ms / (60 * 60 * 1000))
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

// Real accounts.atRisk items only ever carry one of two reason shapes
// (see summarizeAccounts in adminDashboard.js) — this just buckets them
// for the Overview tab's "N billing failed · M set to cancel" sub-label,
// rather than duplicating that string-matching inline in the component.
export function bucketAtRiskReasons(atRisk) {
  const billingFailed = (atRisk || []).filter((a) => a.reason === 'Payment past due' || a.reason.includes('unpaid')).length
  return { billingFailed, settingToCancel: (atRisk || []).length - billingFailed }
}

// How many of a tenant's escalations belong to an account that has since
// canceled — a real, computable "does this predict churn" cross-reference
// (join on user_id), not a modeled guess.
export function countEscalationsFromChurnedAccounts(escalations, accountRows) {
  const canceledUsers = new Set((accountRows || []).filter((r) => r.status === 'canceled').map((r) => r.user_id))
  return (escalations || []).filter((e) => canceledUsers.has(e.user_id)).length
}

// Raw account rows, minus any whose status changed to canceled outside
// the window — same recency rule as summarizeAccounts' canceledLast30d,
// generalized to an arbitrary window (the Customers tab needs 90d, not 30).
export function countChurnedWithinDays(accountRows, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  return (accountRows || []).filter((r) => r.status === 'canceled' && r.subscription_updated_at && Date.parse(r.subscription_updated_at) >= cutoff).length
}

// Client-side search for the Members table — matches firm name or email,
// case-insensitively, substring match (not a fuzzy search — this is a
// small admin list, not a customer-facing search box).
export function filterAccountRows(rows, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return rows || []
  return (rows || []).filter((r) => (r.firm_name || '').toLowerCase().includes(q) || (r.email || '').toLowerCase().includes(q))
}

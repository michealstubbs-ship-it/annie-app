// Small primitives shared across every pool file — moved out of the old
// single-file actionsEngine.js unchanged, so five files can share exactly
// one copy of "how old is this" and "how do I compare two company names"
// instead of each reinventing it slightly differently.

const DAY_MS = 24 * 60 * 60 * 1000

export function daysSince(dateStr) {
  if (!dateStr) return null
  const diff = Date.now() - new Date(dateStr).getTime()
  return Math.floor(diff / DAY_MS)
}

export function statusWeight(status) {
  return { hot: 30, warm: 18, cold: 8, client: 0, inactive: 0 }[status] ?? 10
}

// Rises from 0 toward `max` as x grows, asymptotically, never overshoots. Used
// wherever staleness should matter but not without bound, a contact idle a year
// shouldn't score meaningfully higher than one idle four months.
export function decayRise(x, k, max) {
  if (x <= 0) return 0
  return max * (1 - Math.exp(-x / k))
}

// Falls from near `max` toward 0 as x grows. Used wherever freshness itself is the
// value, a signal found an hour ago matters more than one found a week ago.
export function decayFall(x, k, max) {
  return max * Math.exp(-Math.max(0, x) / k)
}

export const norm = s => (s || '').trim().toLowerCase()

// The quality bar every pool is held to — an item below this never makes
// the list, no exceptions, regardless of category.
export const MIN_SCORE = 20

import { normalizeCompanyName } from './companyMatch.js'

// 2026-09-02, Michael, after a direct production data pull turned up 30+
// duplicate signal groups across 7+ customer accounts — the same real event
// found and written more than once, spanning expansion/leadership_change/
// m_and_a, not just funding (DIFC alone had 5 rows for one real story).
// scanShared.js's fundingFuzzyKey and filterSemanticDuplicates are the real
// fix — they stop NEW duplicates from being written, for every signal type,
// not just funding — but they do nothing for rows already on file, and this
// page had no display-time defense of its own at all (unlike Today's
// Actions' pools, which already collapse to one card per company — see
// relationshipPool.js/sourcedPool.js). This is that same defense-in-depth
// idea, applied here.
//
// Deliberately time-windowed, not "one card per company+type ever" — a
// real, later, genuinely different story about the same company (a second
// funding round weeks apart, a different hire) must still show as its own
// card, and a blanket collapse would wrongly hide it. Within the same
// company AND signal type, entries found within DEDUP_WINDOW_DAYS of a
// neighbouring entry (chained, not just compared to the very first one —
// see the rolling-gap loop below) collapse into one cluster; only the
// single best representative of each cluster is shown.
//
// 14 days chosen from the real production spread: every genuine duplicate
// cluster found in that same data pull landed within an 11.3-day span at
// the widest (Dubai Airports), most within a week — this cron runs twice
// daily and the cross-industry-by-function pass adds a second independent
// AI call per run, so a real duplicate is always rediscovered within a
// handful of days of the original, never weeks later.
export const DEDUP_WINDOW_DAYS = 14
const DEDUP_WINDOW_MS = DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000

function companyKey(name) {
  return normalizeCompanyName(name) || (name || '').trim().toLowerCase()
}

// Which single row best represents a cluster of rows already judged to be
// the same real event. Prefers an unread ('new') row if the cluster has one
// — collapsing must never hide that there's something the user hasn't seen
// yet just because the row that happened to sort last was already read —
// then the most recently found row.
function pickRepresentative(cluster) {
  const withNew = cluster.filter(s => s.status === 'new')
  const pool = withNew.length ? withNew : cluster
  return pool.reduce((best, s) => (new Date(s.found_at) > new Date(best.found_at) ? s : best))
}

export function collapseFeedDuplicates(signals) {
  const list = signals || []
  const groups = new Map()
  // A row missing any of the three fields this needs can't be grouped with
  // confidence — pass it through unconditionally rather than risk silently
  // hiding a genuinely real signal because of a data quirk.
  const passthrough = []
  for (const s of list) {
    if (!s?.company_name || !s?.signal_type || !s?.found_at) { passthrough.push(s); continue }
    const key = `${companyKey(s.company_name)}::${s.signal_type}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }

  const kept = [...passthrough]
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => new Date(a.found_at) - new Date(b.found_at))
    let cluster = []
    let lastTime = null
    for (const s of sorted) {
      const t = new Date(s.found_at).getTime()
      if (lastTime !== null && t - lastTime > DEDUP_WINDOW_MS) {
        kept.push(pickRepresentative(cluster))
        cluster = []
      }
      cluster.push(s)
      lastTime = t
    }
    if (cluster.length) kept.push(pickRepresentative(cluster))
  }

  return kept.sort((a, b) => new Date(b.found_at) - new Date(a.found_at))
}

// 2026-09-06, gap-analysis batch 3 ("Ramadan-aware pipeline SLAs"): the
// Job Pipeline's aging thresholds run on a flat calendar today — 7 days is
// 7 days whether it's a normal week or the middle of Ramadan, when private-
// sector hours legally drop from 8 to 6 (no salary reduction) and
// government hiring routinely pauses through Eid. This is a small, honest
// regional calendar — real, cited dates, not a guess — that the pipeline's
// own aging math reads from instead of a flat clock.
//
// Dates are for the UAE (Annie's core market); update yearly. `factor` is
// how much a calendar day counts toward the aging clock during that
// window: 0.5 means two real days only count as one "aging" day (candidate
// activity genuinely slows, but doesn't fully stop), 0 means the window is
// fully excluded from the clock (Eid itself — almost nothing moves).
export const SLOW_WINDOWS = [
  { name: 'Ramadan 2026', start: '2026-02-19', end: '2026-03-19', factor: 0.5 },
  { name: 'Eid al-Fitr 2026', start: '2026-03-20', end: '2026-03-22', factor: 0 },
]

// The researched busiest UAE hiring stretch — post-Eid through the summer
// budget cycle. Never affects the aging MATH (this is a "push harder", not
// a "slow down" signal) — purely a badge a recruiter can act on.
export const SURGE_WINDOW = { name: 'Post-Eid hiring surge', start: '2026-03-23', end: '2026-06-30' }

function toDateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }

// Effective (regionally-adjusted) days between `since` and `now` — walks
// calendar days one at a time rather than a single flat diff, since a
// stage change can straddle the start or end of a slow window. Small
// pipelines (weeks, not years, in one stage) make the day-by-day walk
// cheap; a year-plus gap is capped to avoid an unbounded loop on bad data.
export function effectiveDaysInStage(since, now = new Date()) {
  if (!since) return 0
  const start = toDateOnly(new Date(since))
  const end = toDateOnly(now)
  const rawDays = Math.max(0, Math.round((end - start) / 86400000))
  if (rawDays === 0) return 0

  const cappedDays = Math.min(rawDays, 730)
  let effective = 0
  const cursor = new Date(start)
  for (let i = 0; i < cappedDays; i++) {
    const window = SLOW_WINDOWS.find(w => cursor >= parseDate(w.start) && cursor <= parseDate(w.end))
    effective += window ? window.factor : 1
    cursor.setDate(cursor.getDate() + 1)
  }
  return Math.floor(effective)
}

export function isInHiringSurge(now = new Date()) {
  const d = toDateOnly(now)
  return d >= parseDate(SURGE_WINDOW.start) && d <= parseDate(SURGE_WINDOW.end)
}

export function activeSlowWindow(now = new Date()) {
  const d = toDateOnly(now)
  return SLOW_WINDOWS.find(w => d >= parseDate(w.start) && d <= parseDate(w.end)) || null
}

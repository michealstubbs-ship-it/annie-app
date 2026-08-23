// Single source of truth for the signal-type taxonomy.
//
// Before this, the same concept existed independently in separate files
// with nothing keeping them in sync: SIGNAL_TYPES in
// netlify/functions/lib/scanShared.js (what the AI scan prompt is allowed
// to return), TYPE_META in IntelligenceFeed.jsx (label/icon/color for the
// feed's cards and filter pills), and RACY_SIGNAL_TYPES in
// src/lib/actionsEngine.js plus a second, separately-maintained RACY_TYPES
// copy in IntelligenceFeed.jsx (which types count as time-sensitive).
// Adding the live_job signal type this session already showed the drift
// risk in practice: it went into actionsEngine's list but not
// IntelligenceFeed's copy, purely because they were different files
// enumerating the same thing. This file is the one place that now changes.
//
// live_job is included here for completeness (it's a real signal_type value
// the scan functions write) even though it's excluded from SIGNAL_TYPES,
// the subset the AI prompt is allowed to choose for itself — live_job rows
// are forced in code from a separate entryType field, never left to the
// AI's own signalType choice. See scan-now-background.js / intelligence-
// scan.js's row-building, and IntelligenceFeed.jsx's query (which excludes
// live_job rows from that feed entirely — Today's Actions only).
// `chipLabel` is the short form the Feed's filter chip bar uses (the mock
// keeps that row terse, e.g. "Leadership" rather than the fuller
// "Leadership change" the per-post topic pill spells out) — omit it and the
// chip bar falls back to the full `label`.
export const SIGNAL_TYPE_META = {
  funding: { label: 'Funding', icon: '💰', color: 'text-amber-700 bg-amber-100', racy: false },
  leadership_change: { label: 'Leadership change', chipLabel: 'Leadership', icon: '👤', color: 'text-blue-700 bg-blue-100', racy: false },
  hiring_activity: { label: 'Hiring activity', chipLabel: 'Hiring', icon: '📈', color: 'text-green-700 bg-green-100', racy: true },
  expansion: { label: 'Expansion', icon: '🌍', color: 'text-teal-700 bg-teal-100', racy: true },
  team_building: { label: 'Team building', icon: '💬', color: 'text-fuchsia-700 bg-fuchsia-100', racy: true },
  public_commentary: { label: 'Public commentary', chipLabel: 'Commentary', icon: '🎙️', color: 'text-purple-700 bg-purple-100', racy: false },
  job_posting_unclaimed: { label: 'Unclaimed role', icon: '📋', color: 'text-orange-700 bg-orange-100', racy: true },
  m_and_a: { label: 'M&A', icon: '🤝', color: 'text-indigo-700 bg-indigo-100', racy: false },
  regulatory: { label: 'Regulatory', icon: '📜', color: 'text-slate-700 bg-slate-100', racy: false },
  live_job: { label: 'Live role', chipLabel: 'Live roles', icon: '🎯', color: 'text-emerald-700 bg-emerald-100', racy: true },
}

// The subset the AI's own scan prompt is allowed to choose a signalType
// from. Order matters here — it's interpolated directly into the prompt
// text as a comma-separated list — so this preserves the exact original
// ordering rather than re-sorting.
export const SIGNAL_TYPES = Object.keys(SIGNAL_TYPE_META).filter(id => id !== 'live_job')

// Which signal types Today's Actions and the Intelligence Feed both treat
// as time-sensitive (worth a "time-sensitive" flag while still fresh).
export const RACY_SIGNAL_TYPES = Object.keys(SIGNAL_TYPE_META).filter(id => SIGNAL_TYPE_META[id].racy)

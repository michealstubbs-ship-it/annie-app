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
//
// `feedTopicColor` is the per-post topic pill's background/text color in the
// Feed. The mock only recolors three types this way (funding=amber,
// live_job=green, regulatory=red, matched to its exact hex values below);
// every other type falls back to the Feed's default navy-tinted pill — see
// IntelligenceFeed.jsx, which uses `feedTopicColor || <default classes>`.
// `color` (unrelated, unused by the Feed) is kept only for Pipeline.jsx's
// stage-count tiles, a different, older consumer of this same taxonomy.
export const SIGNAL_TYPE_META = {
  // A relationship the recruiter already owns and has never used. Not a market
  // event at all, which is exactly why it belongs in the feed: on a real
  // account, 600 of 753 contacts were C-suite or Director/VP/Head and none had
  // ever been contacted, while the scan beside them surfaced scaffolding firms.
  //
  // racy: false — there is no closing window. A relationship that has sat
  // untouched for two years is not more urgent today than it was yesterday, and
  // flagging it as time-sensitive would be a manufactured urgency the recruiter
  // would learn to ignore.
  network_backlog: { label: 'In your network', chipLabel: 'Your network', icon: '🤝', color: 'text-sky-700 bg-sky-100', feedTopicColor: 'bg-[#e0f2fe] text-[#0369a1]', racy: false },
  funding: { label: 'Funding', icon: '💰', color: 'text-amber-700 bg-amber-100', feedTopicColor: 'bg-[#fef3e2] text-[#b45309]', racy: false },
  // 2026-08-26 audit fix: racy was false here, meaning the Feed's own
  // "time-sensitive" flag (driven by RACY_SIGNAL_TYPES below) never applied
  // to leadership_change — while Today's Actions independently treats a
  // leadership change as urgent for up to 60 days after it happens (a new
  // exec is a real, time-boxed BD window). Same signal type, same concept
  // ("is this worth acting on before the window closes"), two different
  // answers depending which page you were on. This file's own header
  // explains it exists specifically to prevent that kind of drift; fixing
  // it here (rather than removing Today's Actions' urgency window) since a
  // fresh leadership change is genuinely one of the more time-sensitive
  // signal types, not less.
  leadership_change: { label: 'Leadership change', chipLabel: 'Leadership', icon: '👤', color: 'text-blue-700 bg-blue-100', racy: true },
  hiring_activity: { label: 'Hiring activity', chipLabel: 'Hiring', icon: '📈', color: 'text-green-700 bg-green-100', racy: true },
  expansion: { label: 'Expansion', icon: '🌍', color: 'text-teal-700 bg-teal-100', racy: true },
  team_building: { label: 'Team building', icon: '💬', color: 'text-fuchsia-700 bg-fuchsia-100', racy: true },
  public_commentary: { label: 'Public commentary', chipLabel: 'Commentary', icon: '🎙️', color: 'text-purple-700 bg-purple-100', racy: false },
  job_posting_unclaimed: { label: 'Unclaimed role', icon: '📋', color: 'text-orange-700 bg-orange-100', racy: true },
  m_and_a: { label: 'M&A', icon: '🤝', color: 'text-indigo-700 bg-indigo-100', racy: false },
  regulatory: { label: 'Regulatory', icon: '⚖️', color: 'text-slate-700 bg-slate-100', feedTopicColor: 'bg-[#fee2e2] text-[#b91c1c]', racy: false },
  live_job: { label: 'Live role', chipLabel: 'Live roles', icon: '💼', color: 'text-emerald-700 bg-emerald-100', feedTopicColor: 'bg-[#dcfce7] text-[#15803d]', racy: true },
}

// The subset the AI's own scan prompt is allowed to choose a signalType from.
// Order matters — it is interpolated directly into the prompt text as a
// comma-separated list — so this preserves the original ordering rather than
// re-sorting.
//
// Two exclusions, for the same underlying reason — anything in this list is
// something the model will go looking for in the market:
//
//   live_job        forced in code from a separate entryType, never the AI's
//                   own choice (see this file's header).
//   network_backlog not a market event at all. It is synthesised in the browser
//                   from the customer's own CRM, so asking a scan to find one
//                   is asking it to invent a relationship the customer has.
//                   The existing ordering test caught this the first time it
//                   was added, which is the test doing exactly its job.
const NOT_AI_CHOSEN = new Set(['live_job', 'network_backlog'])
export const SIGNAL_TYPES = Object.keys(SIGNAL_TYPE_META).filter(id => !NOT_AI_CHOSEN.has(id))

// Which signal types Today's Actions and the Intelligence Feed both treat
// as time-sensitive (worth a "time-sensitive" flag while still fresh).
export const RACY_SIGNAL_TYPES = Object.keys(SIGNAL_TYPE_META).filter(id => SIGNAL_TYPE_META[id].racy)

// M&A, regulatory filings, and public commentary are market intel worth
// knowing about, not something to act on commercially — never a BD trigger
// (see BD_ACTION_SIGNAL_TYPES in actionsEngine.js, which excludes exactly
// this set from Today's Actions). IntelligenceFeed.jsx uses this same list
// to split its own view into a "Signals" tab and a separate "News" tab,
// rather than mixing all of it into one undifferentiated timeline.
export const NEWS_SIGNAL_TYPES = ['m_and_a', 'regulatory', 'public_commentary']

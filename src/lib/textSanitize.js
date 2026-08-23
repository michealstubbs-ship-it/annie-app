// Shared text-sanitization for any AI-written field that reaches a customer,
// used both server-side (netlify/functions/lib/scanShared.js, at signal
// write-time) and client-side (TodaysActions.jsx's per-candidate pitch call,
// which runs through callChat directly and never touches
// buildEnrichedSignalRow). This used to be a private, unexported function
// duplicated wherever a new AI-generated field needed the same cleanup — one
// real implementation now, imported by both sides, so a fix here can't apply
// to one call path and silently miss the other the way the dedup-key drift
// this file's sibling fix (normalizeKey) had to correct for.
//
// Claude's web-search tool sometimes has the model itself write inline
// citation-style markup into its own JSON answer text (e.g.
// `<cite index="34-2,34-3">...</cite>`), imitating a citation format rather
// than anything the API adds — and it was leaking straight into signal
// cards a customer reads verbatim (raw `<cite ...>` tags visible in the
// "why it matters" text). Stripped here, once, for every AI-written field,
// rather than trusting prompt wording alone to keep the model from doing it
// again on some future run.
export function stripAiArtifacts(text) {
  if (!text) return text
  return text
    .replace(/<\/?cite[^>]*>/gi, '')
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '') // stray numeric footnote markers like [1] or [2, 3]
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// Cleans and bounds a list of AI-written short strings before it's stored —
// used for candidateProfile's company-name arrays (directCompetitors,
// similarIndustry, widerScope) and for a funding/expansion signal's
// likelyRoles list. Guards against the AI returning the wrong shape or an
// unbounded list, rather than trusting raw model JSON straight into a jsonb
// column.
export function sanitizeStringList(list, max) {
  if (!Array.isArray(list)) return []
  return list
    .map(c => stripAiArtifacts(typeof c === 'string' ? c : ''))
    .filter(Boolean)
    .slice(0, max)
}

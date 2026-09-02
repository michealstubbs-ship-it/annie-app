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

// 2026-09-02 audit fix, real customer report ("still too long to reply and
// still using ** not natural chat"): Chat.jsx's system prompt already
// instructs the model to write plain text, no bold headers, no bullet
// lists — the exact same "=== VOICE ===" block used for Ask Annie — but
// that's a soft ask the model doesn't reliably follow, the same lesson
// scanShared.js already learned about "reads as agency-posted" (see
// agencyMatch.js). Chat.jsx renders a message's content as raw text
// (`whitespace-pre-wrap`, no markdown parser at all), so any bold/heading/
// bullet markdown the model writes anyway shows up as literal asterisks and
// hashes on screen, not formatting. This is the deterministic backstop:
// strips markdown formatting characters from the model's own words rather
// than the words themselves, so the customer never sees raw markdown
// syntax again regardless of whether the model keeps ignoring the prompt.
// This can't fix response LENGTH the same way — there's no safe mechanical
// way to shorten an AI-written answer without risking cutting off real
// content — so that part still depends on the prompt actually being
// followed; see the VOICE block's own updated comment for that half.
export function stripChatMarkdown(text) {
  if (!text) return text
  return text
    // **bold** / __bold__ -> bold (keep the words, drop the markup)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // *italic* -> italic, but not a standalone "*" (e.g. multiplication,
    // a bare bullet dash already handled below) and not "**" (handled above)
    .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '$1')
    // markdown headers ("### Heading", "## Heading") -> just the text
    .replace(/^#{1,6}\s+/gm, '')
    // a bullet marker at the start of a line ("- item", "* item", "• item")
    // -> just the line's text; numbered steps ("1. ") are left alone, the
    // VOICE prompt explicitly allows those for a real sequence
    .replace(/^[ \t]*[-*•][ \t]+/gm, '')
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

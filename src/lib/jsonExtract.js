// Bracket-balanced JSON-array extraction from a model's free-text response.
// Moved here (was previously only in netlify/functions/lib/scanShared.js)
// because it is genuinely shared logic, not backend-only: TodaysActions.jsx
// needed the exact same thing for its own AI copywriting call and, not
// having access to it, had quietly reimplemented a much weaker version
// locally (a greedy regex matching from the first '[' to the LAST ']' in
// the whole response). That's the exact bug this version was written to
// fix in the first place — see the history below — so the duplicate was a
// live, unfixed instance of an already-fixed bug, not just extra code.
// scanShared.js re-exports this for backend callers so nothing there had to
// change; TodaysActions.jsx now imports it directly instead of keeping its
// own copy.
//
// Replaces a greedy regex (`/\[[\s\S]*\]/`) that matched from the first '['
// to the LAST ']' in the ENTIRE response — web-search tool-use responses
// commonly interleave narration text between searches ("Let me check X's
// funding history...", sometimes itself containing a bracketed aside), and
// the greedy match would span across it, producing invalid JSON and
// silently returning []. This walks forward from the first '[', tracking
// string state (so a bracket character inside a quoted headline is never
// mistaken for structure) and nesting depth, and parses only the balanced
// array it actually finds. Also strips a ```json ... ``` fence first, since
// models frequently wrap JSON in one despite being asked not to.
export function extractJson(text) {
  if (!text) return []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text

  const start = candidate.indexOf('[')
  if (start === -1) return []

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1)
        try { return JSON.parse(slice) } catch { return [] }
      }
    }
  }
  return []
}

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
//
// 2026-08-26 audit fix: narration BEFORE the real array (as opposed to
// after, the case above already covers) has the same failure mode as the
// old greedy regex if that leading narration itself contains a bracket
// character — e.g. "I checked their competitors [Acme, Beta] first.\n
// [{...real array...}]". The first '[' found used to be treated as the
// only candidate: it balances to a syntactically-closed-but-not-valid-JSON
// slice ("[Acme, Beta]"), JSON.parse throws on it, and the whole call gave
// up and returned [] without ever trying the real array a few characters
// later. Now, a failed parse (or a '[' that never closes) just moves the
// search on to the next '[' in the text instead of giving up — the real
// array is very rarely the FIRST bracket character in a free-text response,
// so trying every candidate in order is what the original "don't be
// greedy" fix should have done from the start.
export function extractJson(text) {
  if (!text) return []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text

  let searchFrom = 0
  while (true) {
    const start = candidate.indexOf('[', searchFrom)
    if (start === -1) return []

    let depth = 0
    let inString = false
    let escaped = false
    let closedAt = -1
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
        if (depth === 0) { closedAt = i; break }
      }
    }

    if (closedAt !== -1) {
      const slice = candidate.slice(start, closedAt + 1)
      try { return JSON.parse(slice) } catch { /* not valid JSON after all — try the next '[' */ }
    }
    searchFrom = start + 1
  }
}

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
// 2nd-pass audit fix (2026-08-26): that retry-next-bracket change had two
// real problems of its own, both confirmed by a follow-up review:
//
// 1. Silent wrong answer: every real call site here expects an array of
//    SIGNAL OBJECTS (splitLearnedEntries/scan-now-background read
//    entry?.entryType off each element). If the real array is malformed
//    (e.g. a trailing comma — a common model slip) but some LATER
//    bracketed aside in the same text happens to be independently valid
//    JSON — e.g. "[{...malformed real array,}]\n\nExcluded as duplicates:
//    [\"Beta\"]" — the retry loop would happily return that unrelated array
//    of strings instead of failing safely to []. Before this fix, a
//    malformed real array simply returned [] — safe and detectable. Now a
//    parsed candidate is only accepted if it's an array of objects (or
//    empty) — the one shape every real caller ever wants — so an
//    accidental non-object array is treated the same as a parse failure
//    and the search keeps going (or gives up) instead of returning it.
// 2. Quadratic blowup: a pathological string dominated by unclosed '['
//    characters (a known LLM repetition-loop failure mode — exactly the
//    kind of degenerate output looksTruncatedByTokenLimit in scanShared.js
//    uses this function to diagnose) forced one full end-of-string rescan
//    per '[', which is O(n^2) — measured at ~25s on a 100KB adversarial
//    string. Two independent bounds fix this: (a) if there's no ']'
//    anywhere left in the text, no candidate can ever close, so bail
//    immediately instead of rescanning to prove that once per bracket; (b)
//    a hard cap on retry attempts, since legitimate model output never
//    needs more than a handful.
const MAX_EXTRACT_ATTEMPTS = 200

function isArrayOfObjects(value) {
  return Array.isArray(value) && value.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))
}

export function extractJson(text) {
  if (!text) return []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text

  const lastCloseIdx = candidate.lastIndexOf(']')
  if (lastCloseIdx === -1) return [] // no ']' anywhere — no candidate can ever balance

  let searchFrom = 0
  for (let attempt = 0; attempt < MAX_EXTRACT_ATTEMPTS; attempt++) {
    const start = candidate.indexOf('[', searchFrom)
    if (start === -1 || start > lastCloseIdx) return []

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
      try {
        const parsed = JSON.parse(slice)
        if (isArrayOfObjects(parsed)) return parsed
        // Valid JSON, but not the shape any real caller wants (e.g. a
        // bracketed aside like ["BetaCo","GammaCo"]) — keep searching
        // rather than returning something semantically unrelated.
      } catch { /* not valid JSON after all — try the next '[' */ }
    }
    searchFrom = start + 1
  }
  return []
}

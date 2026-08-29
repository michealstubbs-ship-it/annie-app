// Cross-references a live intelligence signal against a recruiter's OWN
// candidate pool, so the dashboard can say "you already have someone for
// this" instead of only ever pointing outward. This is deliberately a loose,
// keyword-overlap heuristic rather than anything fancy: candidates.role and
// candidates.industry are free-text fields a human typed in, and
// signal.title_keywords are free-text strings the AI generated, there's no
// shared taxonomy to join on, so exact matching would miss almost
// everything. A few good overlapping words is a genuinely useful signal
// here, it doesn't need to be precise to be valuable.

const CLOSED_STATUSES = ['placed', 'rejected', 'withdrawn']

function tokenize(str) {
  return (str || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2)
}

function overlapScore(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0
  const setB = new Set(tokensB)
  // 2026-08-29 perf fix (no behavior change): this used to spread setB into
  // a fresh array INSIDE the tokensA loop, i.e. once per token in tokensA —
  // done once here instead, outside the loop, since it's the same set every
  // iteration. Pure constant-factor win, same hits either way.
  const arrB = [...setB]
  let hits = 0
  for (const t of tokensA) {
    if (setB.has(t)) hits++
    else if (arrB.some(b => b.length > 3 && (b.includes(t) || t.includes(b)))) hits += 0.5
  }
  return hits
}

// 2026-08-29 audit fix: found while chasing a real "Today's Actions still
// hanging" report. matchCandidatesToSignal used to re-tokenize every
// candidate's role/industry from scratch on every single call — fine for a
// one-off caller, but Today's Actions calls it once per sourced item
// against the exact same candidate pool every time (see useTodaysActions.js),
// so with an established agency's full candidate list (deliberately
// uncapped — see listCandidatesForMatching's own comment) and a normal
// day's worth of sourced items, the same retokenization work was being
// redone dozens of times over, synchronously, on the browser's own main
// thread. No network call involved, nothing to time out, nothing in the
// logs — it just looked like the page had frozen.
//
// Callers matching ONE candidate pool against MANY signals in the same pass
// should call this once and reuse the result via matchPreparedCandidatesToSignal
// below, instead of paying the tokenization cost again on every call.
export function prepareCandidatesForMatching(candidates) {
  return (candidates || [])
    .filter(c => !CLOSED_STATUSES.includes(c.status))
    .map(c => ({ candidate: c, roleTokens: tokenize(c.role), industryTokens: tokenize(c.industry) }))
}

function scoreAgainstPrepared(signal, prepared) {
  if (!signal || !prepared.length) return []

  const titleTokens = (signal.title_keywords || []).flatMap(tokenize)
  const headlineTokens = tokenize(signal.headline)
  const industryTokens = tokenize(signal.company_industry)

  const scored = prepared.map(({ candidate, roleTokens, industryTokens: candidateIndustryTokens }) => {
    // Role match matters far more than industry match, a CFO candidate is a
    // CFO candidate whether or not the industry label lines up exactly.
    const roleScore = overlapScore(titleTokens, roleTokens) * 2 + overlapScore(headlineTokens, roleTokens)
    const industryScore = overlapScore(industryTokens, candidateIndustryTokens)
    return { candidate, score: roleScore + industryScore }
  })

  return scored
    .filter(s => s.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(s => s.candidate)
}

// Returns the candidates (best matches first) worth surfacing for this
// signal, capped at 5. An empty array means "nothing in the pool fits,
// worth sourcing fresh" which is itself useful information, not a failure.
//
// One-off convenience wrapper — fine for matching a single signal. A caller
// matching the SAME candidate pool against many signals (Today's Actions)
// should call prepareCandidatesForMatching once and reuse it via
// matchPreparedCandidatesToSignal instead — see that function's own header.
export function matchCandidatesToSignal(signal, candidates) {
  if (!signal || !candidates?.length) return []
  return scoreAgainstPrepared(signal, prepareCandidatesForMatching(candidates))
}

// Same matching, against an already-prepared candidate pool (see
// prepareCandidatesForMatching) — the fast path for matching many signals
// against one fixed candidate pool in the same pass, with the tokenization
// cost paid exactly once regardless of how many signals get matched.
export function matchPreparedCandidatesToSignal(signal, prepared) {
  return scoreAgainstPrepared(signal, prepared || [])
}

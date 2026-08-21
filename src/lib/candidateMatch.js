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
  let hits = 0
  for (const t of tokensA) {
    if (setB.has(t)) hits++
    else if ([...setB].some(b => b.length > 3 && (b.includes(t) || t.includes(b)))) hits += 0.5
  }
  return hits
}

// Returns the candidates (best matches first) worth surfacing for this
// signal, capped at 5. An empty array means "nothing in the pool fits,
// worth sourcing fresh" which is itself useful information, not a failure.
export function matchCandidatesToSignal(signal, candidates) {
  if (!signal || !candidates?.length) return []

  const titleTokens = (signal.title_keywords || []).flatMap(tokenize)
  const headlineTokens = tokenize(signal.headline)
  const industryTokens = tokenize(signal.company_industry)

  const active = candidates.filter(c => !CLOSED_STATUSES.includes(c.status))

  const scored = active.map(c => {
    const roleTokens = tokenize(c.role)
    const candidateIndustryTokens = tokenize(c.industry)

    // Role match matters far more than industry match, a CFO candidate is a
    // CFO candidate whether or not the industry label lines up exactly.
    const roleScore = overlapScore(titleTokens, roleTokens) * 2 + overlapScore(headlineTokens, roleTokens)
    const industryScore = overlapScore(industryTokens, candidateIndustryTokens)
    return { candidate: c, score: roleScore + industryScore }
  })

  return scored
    .filter(s => s.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(s => s.candidate)
}

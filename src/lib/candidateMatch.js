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

// 2026-09-05, Michael, on the CV-parsing rebuild: "if any of the candidates
// are saudi nationals or emiratis, only recommend those candidates if those
// jobs are in Saudi or UAE". A free-text field matched against a free-text
// field, same "loose keyword overlap, not a shared taxonomy" reasoning as
// the rest of this file — deliberately narrow (only the two nationalities
// Michael actually named) rather than a general "nationals only match their
// own country" rule for every nationality, since he didn't ask for that and
// a candidate with no gating rule here should never be filtered out on
// nationality at all.
const NATIONALITY_HOME_COUNTRY = [
  { nationality: /\b(saudi|ksa)\b/i, country: /\b(saudi|ksa|riyadh|jeddah|dammam|khobar)\b/i },
  { nationality: /\b(emirati|u\.?a\.?e\.? national)\b/i, country: /\b(u\.?a\.?e\.?|emirates|dubai|abu dhabi|sharjah|ajman|fujairah)\b/i },
]

// Exported so the CV auto-fill UI can explain the rule inline (see
// Candidates.jsx's nationality field), not just candidateMatch.js itself.
export function isGeographicallyEligible(candidate, locationText) {
  const nationality = (candidate?.nationality || '').trim()
  if (!nationality) return true // nothing on file — no gate to apply
  const rule = NATIONALITY_HOME_COUNTRY.find(r => r.nationality.test(nationality))
  if (!rule) return true // a nationality Michael didn't ask to gate — never filtered on this basis
  return rule.country.test(locationText || '')
}

function tokenize(str) {
  return (str || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2)
}

// 2026-08-31 audit fix, root cause of "role fields holding sector names, and
// the matcher can't tell": tokenize() above treats a comma exactly like a
// space, so a role typed the way recruiters actually type them — "Partner,
// Financial Services", "Director, Real Estate", "Head of HR, EMEA" — comes
// out as one undifferentiated bag of words. "Partner, Financial Services"
// tokenized that way is indistinguishable from a genuine title like
// "Financial Services Partner", so "financial" reads as a title word and
// wrongly overlaps a CFO signal's title keywords ("Financial Controller",
// a headline mentioning "Chief Financial Officer") — the exact miss on
// Susan Okoye. Blacklisting "financial" as a word would just break the many
// genuine finance titles that legitimately contain it (Financial Controller,
// Financial Analyst, Chief Financial Officer) — the last three "title-keyword
// gate" tests above prove those still need to work.
// The comma itself is the actual signal: everything a recruiter types after
// it in a role field is near-universally a practice-area/sector qualifier,
// not part of the job title. So the title-matching tokens come only from the
// part before the first comma, and everything after it is folded into the
// candidate's industry tokens instead — where a stray "Financial Services"
// belongs, and where it can still help (a candidate whose role says "Partner,
// Financial Services" but has no separate industry field on file still
// surfaces correctly for a Financial Services job on industry alone).
function splitRoleForMatching(role) {
  const str = role || ''
  const commaIdx = str.indexOf(',')
  if (commaIdx === -1) return { titlePart: str, qualifierPart: '' }
  return { titlePart: str.slice(0, commaIdx), qualifierPart: str.slice(commaIdx + 1) }
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
    .map(c => {
      const { titlePart, qualifierPart } = splitRoleForMatching(c.role)
      // 2026-09-05: candidates.titles/industries (jsonb arrays) are Annie's
      // own CV-parse read on every OTHER title/industry this candidate's
      // real experience could plausibly match — e.g. "Head of Growth" also
      // covering "VP Marketing" or "Growth Lead" searches — additive to the
      // recruiter's own singular role/industry fields, never replacing
      // them, so a candidate whose CV was never parsed (titles/industries
      // empty) matches exactly as before.
      const extraTitleTokens = (Array.isArray(c.titles) ? c.titles : []).flatMap(tokenize)
      const extraIndustryTokens = (Array.isArray(c.industries) ? c.industries : []).flatMap(tokenize)
      return {
        candidate: c,
        roleTokens: [...new Set([...tokenize(titlePart), ...extraTitleTokens])],
        // Sector words a recruiter typed after a comma in the role field
        // (see splitRoleForMatching above) join the real industry field's
        // own tokens here — same array, so a candidate still surfaces on
        // industry overlap either way, but that comma-qualifier text can no
        // longer masquerade as a title word.
        industryTokens: [...new Set([...tokenize(c.industry), ...tokenize(qualifierPart), ...extraIndustryTokens])],
      }
    })
}

// Shared scorer: takes already-tokenized query fields rather than a
// signal/job shape directly, so both the signal-matching functions and the
// job-matching functions below funnel through exactly one scoring
// implementation instead of two near-identical copies.
function scoreAgainstPreparedTokens({ titleTokens, freeTextTokens, industryTokens, locationText = '' }, prepared, { requireTitleOverlap = false, limit = 5 } = {}) {
  if (!prepared.length) return []

  const scored = prepared.map(({ candidate, roleTokens, industryTokens: candidateIndustryTokens }) => {
    // Role match matters far more than industry match, a CFO candidate is a
    // CFO candidate whether or not the industry label lines up exactly.
    const titleScore = overlapScore(titleTokens, roleTokens)
    const roleScore = titleScore * 2 + overlapScore(freeTextTokens, roleTokens)
    const industryScore = overlapScore(industryTokens, candidateIndustryTokens)
    return { candidate, titleScore, score: roleScore + industryScore }
  })

  // 2026-08-31: with requireTitleOverlap (BD signals only — see
  // scoreAgainstPrepared), a candidate must overlap the signal's TITLE
  // KEYWORDS to be suggested at all; industry overlap or a chance hit
  // against the headline prose is no longer enough on its own. Without this
  // a "Chief Operating Officer" was surfacing against the headline "…appoints
  // a new Chief Financial Officer" purely on the words "chief" and "officer",
  // and a "Partner, Financial Services" was scoring on "Financial" — a sector
  // sitting in a role field. Recommending a COO and a Partner for a CFO search
  // is the kind of miss a recruiter spots instantly, and it costs trust in
  // every other suggestion on the card. Signals also cap at 3 rather than 5
  // for the same reason: three defensible matches read as judgement, five
  // loose ones read as a keyword dump. Job matching keeps the older, looser
  // behaviour deliberately — there, an industry-only match with no title
  // overlap is covered by its own test and is wanted.
  return scored
    .filter(s => s.score >= 1 && (!requireTitleOverlap || s.titleScore >= 1) && isGeographicallyEligible(s.candidate, locationText))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.candidate)
}

function scoreAgainstPrepared(signal, prepared) {
  if (!signal) return []
  const titleTokens = (signal.title_keywords || []).flatMap(tokenize)
  const freeTextTokens = tokenize(signal.headline)
  const industryTokens = tokenize(signal.company_industry)
  // A live_job signal has no dedicated location field of its own — only the
  // hiring company's own HQ, from Apollo enrichment (see
  // buildEnrichedSignalRow in scanShared.js) — which is exactly the "is
  // this job in Saudi/UAE" question the nationality gate above needs to
  // answer.
  const locationText = [signal.company_city, signal.company_state, signal.company_country].filter(Boolean).join(', ')
  return scoreAgainstPreparedTokens({ titleTokens, freeTextTokens, industryTokens, locationText }, prepared, { requireTitleOverlap: true, limit: 3 })
}

// 2026-08-29: same matching, pointed at a real job posting instead of a BD
// signal — title + brief/notes (requirements, must-haves, skills) +
// industry, in place of a signal's title_keywords/headline/company_industry.
// Added so Jobs & Mandates can surface "who in my CRM might fit this job"
// using the exact machinery already built and proven for Today's Actions,
// rather than a second, parallel matching implementation.
function scoreJobAgainstPrepared(job, prepared) {
  if (!job) return []
  const titleTokens = tokenize(job.title)
  const freeTextTokens = tokenize(job.notes)
  const industryTokens = tokenize(job.industry)
  // listJobsWithCompanies joins the client company in (see data/jobs.js) —
  // `job.companies.location` is the real location a customer-added job is
  // actually based in, same field Jobs.jsx already reads to show it on the
  // card.
  const locationText = job.companies?.location || ''
  return scoreAgainstPreparedTokens({ titleTokens, freeTextTokens, industryTokens, locationText }, prepared)
}

// Returns the candidates (best matches first) worth surfacing for this
// signal, best first, capped at 3. An empty array means "nothing in the pool fits,
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

// Same idea as matchCandidatesToSignal, pointed at a real job instead of a
// signal — one-off convenience wrapper, fine for matching a single job.
export function matchCandidatesToJob(job, candidates) {
  if (!job || !candidates?.length) return []
  return scoreJobAgainstPrepared(job, prepareCandidatesForMatching(candidates))
}

// The fast path for matching many jobs against one fixed candidate pool in
// the same pass (Jobs & Mandates) — same reasoning as
// matchPreparedCandidatesToSignal.
export function matchPreparedCandidatesToJob(job, prepared) {
  return scoreJobAgainstPrepared(job, prepared || [])
}

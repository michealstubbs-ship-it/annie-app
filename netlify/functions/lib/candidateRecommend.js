// AI-powered "recommend CRM candidates from job brief" (mid-turn addition,
// Michael: "if its an upgrade replace it" — this REPLACES the old
// keyword-overlap "Suggested candidates" panel on Jobs.jsx entirely, it
// doesn't run alongside it. See recommend-candidates.js for the endpoint
// that wires this up).
//
// The Saudi/Emirati geographic gate stays fully deterministic and is NEVER
// left to the model's judgement — recommend-candidates.js filters the
// candidate pool through candidateMatch.js's own isGeographicallyEligible
// (the exact same rule Today's Actions and the CV auto-fill matching both
// already use — no second implementation of that rule here) BEFORE any
// candidate summary ever reaches this prompt. The AI only ever ranks and
// explains a pool that's already known-eligible.
//
// Unlike the old panel (a pure keyword-overlap score over title/industry),
// this reads the candidate's real notes, CV-derived titles/industries,
// notice period and salary expectation together with the job's full brief
// text — the whole point of the "upgrade" is catching a genuine fit the
// literal word-overlap approach missed, and explaining WHY in one grounded
// sentence per candidate instead of just a bare name in a list.
import { stripAiArtifacts } from '../../../src/lib/textSanitize.js'
import { extractJson } from '../../../src/lib/jsonExtract.js'

// One recruiter's own CRM candidate pool, not the whole platform's — still
// capped so a very large, long-established agency's pool can't blow out
// prompt size/cost on every single job-card expand. 150 comfortably covers
// a boutique/mid-size recruiter's active pool; the caller sorts by most
// recently updated before slicing, so if this cap is ever hit it drops the
// stalest records first, not an arbitrary subset.
export const MAX_CANDIDATES_FOR_PROMPT = 150
export const MAX_RECOMMENDATIONS = 6
const MAX_NOTES_CHARS = 300
const MAX_REASON_CHARS = 220

// Compact, prompt-sized view of one candidate — every field the AI is
// allowed to reason from, and nothing else (no email/phone/CV path — this
// call never needs contact details, only fit).
export function summarizeCandidateForPrompt(c) {
  return {
    id: c.id,
    name: c.name,
    role: c.role || null,
    company: c.company || null,
    industry: c.industry || null,
    titles: Array.isArray(c.titles) ? c.titles : [],
    industries: Array.isArray(c.industries) ? c.industries : [],
    status: c.status || null,
    notice_period: c.notice_period || null,
    salary_expectation: c.want_sal ? `${c.want_sal} ${c.want_sal_currency || ''}`.trim() : null,
    notes: (c.notes || '').slice(0, MAX_NOTES_CHARS),
  }
}

export function buildRecommendationSystemPrompt() {
  return [
    "You are Annie, a recruitment CRM assistant. You'll be given one job brief and a list of real candidates already in the recruiter's own CRM.",
    'The candidate list has already been filtered for location/nationality eligibility for you — never second-guess, re-apply, or override that; every candidate given to you is already eligible for this job.',
    'Choose the candidates who are a genuine, specific fit for THIS job, using only the fields given for each candidate — never invent an employer, achievement, skill, or fact that is not present in the data. A candidate with a thin profile (few or empty fields) is not a good fit just because nothing rules them out; only recommend someone the given fields actually support.',
    `Rank best fit first. Return at most ${MAX_RECOMMENDATIONS} candidates. If genuinely nobody in the list is a reasonable fit, return an empty array — never force weak matches just to fill the list.`,
    'Return STRICT JSON ONLY, no other text: an array of objects, each shaped exactly as { "id": "<candidate id, copied exactly from the input>", "reason": "<one short, specific sentence grounded only in this candidate\'s own listed fields>" }.',
  ].join('\n')
}

export function buildRecommendationUserMessage(job, candidates) {
  const jobBrief = {
    title: job.title || null,
    industry: job.industry || null,
    company: job.companies?.name || null,
    location: job.companies?.location || null,
    fee_value: job.fee_value ?? null,
    brief: job.notes || null,
  }
  return JSON.stringify({ job: jobBrief, candidates: candidates.map(summarizeCandidateForPrompt) })
}

// Parses the model's reply, keeping only recommendations that actually
// name a real candidate from the pool it was given (never trust an id the
// model invented or a duplicate) and sanitizing the reason text through the
// same stripAiArtifacts every other AI-written field in this codebase goes
// through before a customer sees it.
export function parseRecommendationsResponse(replyText, candidatesById) {
  const raw = extractJson(replyText, { shape: 'object' })
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const id = typeof item?.id === 'string' ? item.id : null
    if (!id || seen.has(id) || !candidatesById.has(id)) continue
    seen.add(id)
    const reason = stripAiArtifacts(typeof item.reason === 'string' ? item.reason : '').slice(0, MAX_REASON_CHARS)
    out.push({ candidate: candidatesById.get(id), reason })
    if (out.length >= MAX_RECOMMENDATIONS) break
  }
  return out
}

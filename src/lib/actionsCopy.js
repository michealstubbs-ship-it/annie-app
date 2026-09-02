// Turns deterministically-selected items into customer-facing copy.
// The AI never chooses what makes the list, only how it's described.

const CATEGORY_LABEL = {
  dormant: 're-engage',
  meeting: 'meeting',
  relationship: 'relationship',
  new_client: 'new client',
}

// Exported (2026-09-01): this is exactly the data that drives the AI's
// enrichment output for a given item, so it doubles as the content
// signature for useTodaysActions.js's copy cache (see copyCache.js) — if
// this object is unchanged since the last load, the AI would write the same
// copy, so there's no reason to pay for the call again.
export function describeItem(item) {
  const base = { category: item.category, signals: item.signals }
  if (item.category === 'dormant') {
    return { ...base, name: item.contact.name, company: item.contact.company, title: item.contact.title }
  }
  if (item.category === 'meeting') {
    return { ...base, company: item.deal.company, role: item.deal.role, contactName: item.contact?.name }
  }
  if (item.category === 'relationship') {
    // 2026-09-02 audit fix, real report: a company having ANY contact row in
    // the CRM (including a cold, unengaged LinkedIn import — see
    // LinkedInImport.jsx's own 2026-09-02 fix, "an import is not a
    // relationship either") got treated as proof of an actual relationship,
    // so this item's copy was always written soft/light-touch and the real,
    // Apollo-verified contact from the signal itself got swapped out for
    // whichever CRM row happened to match by company name, dropping the
    // real email in the process (see useTodaysActions.js's own fix). A real
    // relationship needs actual evidence — a genuine note on file, ideally
    // with a status showing real engagement — not just a row existing.
    // Only pass that evidence through when it's genuinely there; the prompt
    // below is told never to assume a relationship otherwise.
    const hasRealEvidence = !!(item.contact && item.contact.notes && item.contact.notes.trim())
    return {
      ...base,
      company: item.signal.company_name,
      signalTitle: item.signal.headline,
      priorContactName: hasRealEvidence ? item.contact.name : null,
      priorNote: hasRealEvidence ? item.contact.notes : null,
      priorNoteDate: hasRealEvidence ? (item.contact.last_contacted || null) : null,
      priorContactStatus: hasRealEvidence ? item.contact.status : null,
    }
  }
  if (item.category === 'new_client') {
    return { ...base, name: item.contact.name, company: item.contact.company, title: item.contact.title }
  }
  return base
}

export function buildEnrichmentPrompt(items, onboarding, profile) {
  const context = `You are Annie, a BD intelligence engine for recruitment firms.
Recruiter: ${profile?.full_name || 'the user'} at ${profile?.firm_name || onboarding?.firm_name || 'their firm'}.
Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Functions this recruiter places candidates into: ${onboarding?.functions?.join(', ') || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `\nThe recruiter's real writing style, follow this closely for any drafted copy:\n${onboarding.writing_style}\n` : ''}
Below is a list of BD items that have ALREADY been selected by a scoring system, based on real data like days since contact, target company match, and pipeline stage. Your only job is to write good, specific copy for each one. Do not invent facts, only use what's given in the signals.

For every item, write:
- headline: max 8 words, specific
- detail: 1-2 sentences, what to do and why, grounded in the given signals
- moveForward: an array of 2-3 distinct, genuinely tactical options for what to actually try next. Never restate the signals data back, that's already visible. For "dormant" and "new_client" items, give real drafted opening angles (one referencing something specific if possible, one leading with value, one solid fallback). For "meeting" items, give distinct re-engagement tactics (switching channel, adding a fresh hook, opening a second contact at the same company). For "relationship" items, write it with EXACTLY the same substance and directness as a brand-new company approach — a company merely having a contact row in the CRM is NOT a relationship and is NOT a reason to go softer or lighter-touch; treat it as a cold approach by default.
  2026-09-02 audit fix, real report: "relationship" items used to be written as a soft, light-touch nudge purely because some contact at that company already existed in the CRM — often just an unengaged, cold LinkedIn import, not anyone the recruiter has actually spoken to. That's wrong: never assume a relationship, never soften the approach, and never imply "you already know someone here" UNLESS this item's data includes priorContactName/priorNote/priorNoteDate — those three appearing together is the only real evidence of an actual prior conversation. When they ARE present, you may reference that specifically and naturally, e.g. "I can see you've previously spoken with priorContactName here, based on a note from priorNoteDate" — and if priorContactStatus is "warm" or "hot", say it's worth reaching back out to that same person; otherwise treat it as background color, not a reason to soften the ask. When those fields are absent (the ordinary case), write the SAME kind of direct, substantive approach you'd write for a brand-new company — never invent or imply a relationship that isn't evidenced.

Every item needs real, specific headline/detail/moveForward, whatever its category. Do not skip or thin out an item just because it's labeled "relationship" — that label describes where Annie found the signal, not how confidently you should approach the company.

Items (each has an "id" — echo that same id back on its matching output object, unchanged; you do not need to preserve item order, every id just needs to appear exactly once):
${JSON.stringify(items.map((item, i) => ({ id: i, ...describeItem(item) })))}

Return a JSON array, one object per item, in any order: { "id": <the item's id>, "headline": "...", "detail": "...", "moveForward": ["...", "...", "..."] }
Only return the JSON array, nothing else.`
  return context
}

// Batched, grounded "why this candidate" pitch for the single top pipeline
// match on a sourced signal — one call for every candidate that needs one,
// same reasoning as buildEnrichmentPrompt's batching above (a round trip per
// candidate would be real waste). Deliberately restricted to the real fields
// already on the candidate/signal (role, company, industry, notes, pipeline
// status) rather than the mock's fabricated-and-specific claims ("Led a
// $340M cross-border refinancing") — the model is explicitly told not to
// invent anything beyond what's given, and the result is rendered in
// TodaysActions.jsx with a visible "Annie's read" label rather than as a
// stored fact, since even a grounded pitch is still an inference, not a
// verified claim about the person.
// 2026-08-30 audit fix: this used to return a bare array of pitch strings,
// matched back to targets purely by array position — the exact same class
// of bug fixed in buildEnrichmentPrompt above (see its own comment), just
// unnoticed here because a dropped/misaligned pitch degrades quietly to "no
// pill" instead of a visibly broken card. Every pairing now carries an id
// the model must echo back, so useTodaysActions.js can match by id instead
// of position.
// Exported (2026-09-01): same reasoning as describeItem above — this is
// exactly the data that drives a given pairing's pitch, and useTodaysActions.js's
// copy cache uses it as that pairing's content signature. Takes the SAME
// { signal: { headline, industry }, candidate } shape the prompt already
// built per-pairing, so there's exactly one place this reshaping happens.
export function describePitchTarget({ signal, candidate }) {
  return { signalHeadline: signal.headline, signalIndustry: signal.industry, candidate: { role: candidate.role, company: candidate.company, industry: candidate.industry, status: candidate.status, notes: candidate.notes || '' } }
}

export function buildCandidatePitchPrompt(targets) {
  return `You are Annie, a BD intelligence engine for recruitment firms.
For each pairing below, write ONE short, specific-sounding sentence on why this real candidate could be a fit for this signal — grounded ONLY in the fields given (their role, current company, industry, pipeline status, and any notes on file). Do not invent an employer, a deal value, a specific achievement, or any other fact not present in the notes field. If notes is empty, write a plain, generic fit sentence based only on role and industry overlap with the signal — never pad it out with an invented specific.

Pairings (each has an "id" — echo that same id back on its matching output object, unchanged; you do not need to preserve order, every id just needs to appear exactly once):
${JSON.stringify(targets.map((t, i) => ({ id: i, ...describePitchTarget(t) })))}

Return a JSON array, one object per pairing: { "id": <the pairing's id>, "pitch": "..." }. Only return the JSON array, nothing else.`
}

// Deterministic, no-AI copy for a CRM item whose entry didn't come back from
// its enrichment batch even though the batch as a whole succeeded (see the
// id-matching audit fix in useTodaysActions.js — a batch reply that omits
// one item's id is exactly the case this covers). Built straight from the
// item's own real data, same fields describeItem above already extracts, so
// a card never renders as bare "Follow up" with nothing else just because
// one entry got dropped from an otherwise-fine batch. Never used when the
// whole batch failed — that case keeps the explicit "couldn't load details"
// wording instead, since that failure is worth surfacing as degraded rather
// than smoothed over.
export function fallbackHeadline(item) {
  if (item.category === 'dormant') return `Re-engage ${item.contact?.name || 'this contact'}`
  if (item.category === 'meeting') return `Follow up on ${item.deal?.company || 'this meeting'}`
  if (item.category === 'relationship') return item.signal?.headline || 'A signal worth a light-touch follow-up'
  if (item.category === 'new_client') return `Reach out to ${item.contact?.name || 'this new contact'}`
  return 'Follow up'
}

export function fallbackDetail(item) {
  if (item.category === 'relationship') {
    return item.signal?.why_it_matters || `${item.signal?.company_name || 'This company'} had a recent update worth a light-touch check-in.`
  }
  const firstSignal = item.signals ? Object.values(item.signals)[0] : ''
  return firstSignal || "Annie's copywriter didn't come back in time for this one — the underlying signal is still real, worth a look."
}

// Sourcing/discovery no longer happens here, or anywhere in the client. The
// scheduled intelligence-scan Netlify function is the one place research happens,
// running every 4 hours per customer and writing into intelligence_signals. Today's
// Actions and the Intelligence Feed page both just read what it already found, so
// research is never paid for twice and the two views can never disagree with each
// other about the same fact.

export { CATEGORY_LABEL }

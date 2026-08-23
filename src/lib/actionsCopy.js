// Turns deterministically-selected items into customer-facing copy.
// The AI never chooses what makes the list, only how it's described.

const CATEGORY_LABEL = {
  dormant: 're-engage',
  meeting: 'meeting',
  relationship: 'relationship',
  new_client: 'new client',
}

function describeItem(item) {
  const base = { category: item.category, signals: item.signals }
  if (item.category === 'dormant') {
    return { ...base, name: item.contact.name, company: item.contact.company, title: item.contact.title }
  }
  if (item.category === 'meeting') {
    return { ...base, company: item.deal.company, role: item.deal.role, contactName: item.contact?.name }
  }
  if (item.category === 'relationship') {
    return { ...base, company: item.signal.company_name, signalTitle: item.signal.headline, contactName: item.contact?.name }
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
- moveForward: an array of 2-3 distinct, genuinely tactical options for what to actually try next. Never restate the signals data back, that's already visible. For "dormant" and "new_client" items, give real drafted opening angles (one referencing something specific if possible, one leading with value, one solid fallback). For "meeting" items, give distinct re-engagement tactics (switching channel, adding a fresh hook, opening a second contact at the same company). For "relationship" items, suggest a genuine light-touch way to engage tied to the signal, not a hard ask.

Items:
${JSON.stringify(items.map(describeItem))}

Return a JSON array, same order as given, each object: { "headline": "...", "detail": "...", "moveForward": ["...", "...", "..."] }
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
export function buildCandidatePitchPrompt(targets) {
  return `You are Annie, a BD intelligence engine for recruitment firms.
For each pairing below, write ONE short, specific-sounding sentence on why this real candidate could be a fit for this signal — grounded ONLY in the fields given (their role, current company, industry, pipeline status, and any notes on file). Do not invent an employer, a deal value, a specific achievement, or any other fact not present in the notes field. If notes is empty, write a plain, generic fit sentence based only on role and industry overlap with the signal — never pad it out with an invented specific.

Pairings:
${JSON.stringify(targets.map(({ signal, candidate }) => ({ signalHeadline: signal.headline, signalIndustry: signal.industry, candidate: { role: candidate.role, company: candidate.company, industry: candidate.industry, status: candidate.status, notes: candidate.notes || '' } })))}

Return a JSON array, same order and length as given, each entry just the pitch string (not an object). Only return the JSON array, nothing else.`
}

// Sourcing/discovery no longer happens here, or anywhere in the client. The
// scheduled intelligence-scan Netlify function is the one place research happens,
// running every 4 hours per customer and writing into intelligence_signals. Today's
// Actions and the Intelligence Feed page both just read what it already found, so
// research is never paid for twice and the two views can never disagree with each
// other about the same fact.

export { CATEGORY_LABEL }

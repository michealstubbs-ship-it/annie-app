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
    return { ...base, company: item.signal.company, signalTitle: item.signal.title, contactName: item.contact?.name }
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
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Tone: ${onboarding?.tone || 'professional'}.

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

export function buildSourcingPrompt(onboarding, existingCompanies) {
  return `You are Annie, an expert BD researcher for a recruitment firm.
Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Target companies already known: ${onboarding?.target_companies?.join(', ') || 'None specified'}.
Companies already in their CRM, do not resource these: ${existingCompanies.join(', ') || 'None'}.

Use web search to find 2-3 genuine, timely BD opportunities for this recruiter, companies or people they don't already know about. Bias strongly AGAINST obvious, oversaturated, famous names everyone already targets, unless that famous company has a genuinely fresh, non-public timing signal attached (like an internal recruiter departure). Prefer quiet signals that took real digging to find: a specific person posting about scaling their team, a company that just got licensed or funded without major press coverage, multiple simultaneous niche job postings suggesting a new function being built.

Every lead must have a real, citable source you actually found via search, do not invent anything. If you cannot find genuinely good non-obvious leads, return fewer than 3, do not pad with weak ones.

For each lead, also work out:
- whoToApproach: the specific person or role to approach, and why, bypass generic HR/Head of Talent unless they are genuinely the right door
- candidateAngle: a specific, credible candidate profile to lead with (background, seniority, source companies), not a generic pitch

Return a JSON array, each object:
{
  "company": "...",
  "headline": "max 8 words",
  "whatAnnieFound": "1-2 sentences on the specific signal",
  "sourceUrl": "the real URL you found this from",
  "sourceLabel": "short label for the source, e.g. techcrunch.com",
  "whoToApproach": "...",
  "candidateAngle": "..."
}
Only return the JSON array, nothing else. If nothing genuinely good was found, return an empty array.`
}

export { CATEGORY_LABEL }

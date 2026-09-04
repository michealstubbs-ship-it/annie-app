// Drafts written when the recruiter asks, not before.
//
// The old Today's Actions ran an AI copy pass and a candidate-pitch pass across
// every item BEFORE the page could render — so it paid Anthropic to write an
// approach for dozens of leads nobody opened, and made the page slow for
// everyone in order to do it. Michael, 2026-09-04: drafts on request.
//
// The prompt below is written around the way-in ladder, because the single
// worst thing this feature can do is write a warm opener to someone the
// recruiter has never met. companyMatch.js used to offer "a warm door" on a
// company-name match alone; the whole rebuild exists to stop that, and a draft
// that says "great to catch up again" undoes it in one sentence.
import { callChat } from '../callChat'
import { RUNG_SPOKEN, RUNG_CANDIDATE, RUNG_CONTACT } from './wayIn'

function relationshipBrief(wayIn, companyName) {
  const p = wayIn.person
  switch (wayIn.rung) {
    case RUNG_SPOKEN:
      return `The recruiter HAS dealt with ${p.name} (${p.title || p.role || 'role unknown'}) before. Their own note on file reads: "${(p.notes || '').trim().slice(0, 400) || 'no note text, but a contact date is logged'}". You may reference that prior contact, but only what the note actually says — never invent a detail of a previous conversation.`
    case RUNG_CANDIDATE:
      return `${p.name} is a CANDIDATE on the recruiter's books who currently works at ${p.company || companyName}. They are NOT a client contact. Do not write to them as one, and do not imply the recruiter has a client relationship with ${companyName}. If you suggest approaching through them at all, be explicit that they may be actively looking and that discretion matters.`
    case RUNG_CONTACT:
      return `${p.name} (${p.title || 'role unknown'}) is in the recruiter's CRM at ${p.company || companyName}, but there is NO record of them ever speaking — no note, no logged call. Treat this as a COLD approach to a name they may not remember. Never write "good to speak again", "following up on our conversation", "as discussed" or anything else implying prior contact.`
    default:
      return `The recruiter has no contact at ${companyName} at all. This is a cold approach to a stranger. Write it as one.`
  }
}

const SYSTEM = `You write short outbound business-development messages for an executive search recruiter.

Hard rules, in order of importance:
1. NEVER imply a relationship that does not exist. You will be told exactly what the recruiter's real history with this person is. If there is no evidence of prior contact, the message must read as a genuine first approach.
2. Lead with the trigger — the thing that actually happened at the company — not with the recruiter or their firm.
3. Six sentences maximum. Shorter is better. No preamble.
4. Plain text. No markdown, no bold, no bullet points, no headers, no em dashes.
5. No "I hope this finds you well", no "I wanted to reach out", no "Great question", no closing boilerplate like "Let me know if you'd like to discuss further".
6. One specific ask at the end — a short call, or a direct question. Not a menu of options.
7. Do not invent facts about the company, the person, or the recruiter's track record. Use only what you are given.

Output the message body only. No subject line unless asked, no signature, no commentary.`

/**
 * Asks Annie for an approach for one stream item.
 * Returns { text } or throws — the caller shows the error in place.
 */
export async function draftApproach({ item, profile, onboarding }) {
  const s = item.signal
  const wayIn = item.wayIn

  const context = [
    `Recruiter: ${profile?.full_name || 'a recruiter'} at ${profile?.firm_name || 'their search firm'}.`,
    onboarding?.sectors?.length ? `Sectors they cover: ${onboarding.sectors.join(', ')}.` : null,
    onboarding?.functions?.length ? `Functions they place: ${onboarding.functions.join(', ')}.` : null,
    onboarding?.tone ? `Preferred tone: ${onboarding.tone}.` : null,
    onboarding?.writing_style ? `Match this recruiter's own writing style closely:\n${onboarding.writing_style}` : null,
    '',
    `Company: ${s.company_name}`,
    `What happened: ${s.headline}`,
    s.why_it_matters ? `Why it matters for them: ${s.why_it_matters}` : null,
    s.who_to_approach ? `Who to aim at: ${s.who_to_approach}` : null,
    Array.isArray(s.likely_roles) && s.likely_roles.length ? `Roles this probably creates: ${s.likely_roles.join(', ')}` : null,
    '',
    `RELATIONSHIP — read this carefully, it governs the whole message:`,
    relationshipBrief(wayIn, s.company_name),
    '',
    wayIn.person?.name ? `Write the message TO ${wayIn.person.name}.` : `Write the message to the most senior relevant person at ${s.company_name}. Do not use a placeholder name — open without one.`,
  ].filter(Boolean).join('\n')

  const { text } = await callChat({
    messages: [{ role: 'user', content: context }],
    systemOverride: SYSTEM,
    maxTokens: 700,
    // No web search: everything needed is in the signal, and a search here
    // would both slow the draft down and invite invented facts.
    webSearch: false,
  })

  return { text: (text || '').trim() }
}

// Deterministic (no AI) fallback body for a sourced signal's ready-to-send
// outreach message — used only when the scan's own AI-drafted
// introMessage is missing (a null intro_message on the signal row; see
// useTodaysActions.js's fullIntroMessage for where this is called from).
//
// 2026-08-30 audit fix, a real, live bug found on the demo tenant: this
// used to splice action.detail straight into the message body. For a
// sourced item, action.detail is the signal's why_it_matters — Annie's own
// internal analysis, written TO THE RECRUITER, in second person ("You have
// no relationship here yet", "a clean first approach rather than a
// chase") — and it was landing verbatim in an email addressed to the
// prospect. 17 of 72 signals on the demo tenant had a null intro_message
// and took this path; every one of them mailed the recruiter's own
// reconnaissance notes to the contact, under a firm's own name.
//
// Fixed by never referencing why_it_matters — or any other field written
// in the recruiter's voice, for the recruiter's own reading, rather than
// as sendable prose (who_to_approach, candidateAngle, benchStrengthAngle
// are instructions and internal framing, e.g. "Congratulate her, and offer
// help as she builds out the team beneath her" — not something you'd
// literally say to her). Only two things are safe to build from here: the
// public event itself (headline/company) and, for a leadership change
// specifically, a genuine congratulations instead of a generic opener —
// applied structurally by signal type, since a no-AI fallback can't itself
// read and act on a free-text instruction the way the real AI-drafted
// message (or a human) could.
export function fallbackIntroMessage(action, { firmName, functions, locations } = {}) {
  const firmClause = firmName ? `I work for a recruitment firm called ${firmName}` : 'I work for a recruitment firm'
  const functionsClause = functions?.length ? functions.join(', ') : 'this space'
  const locationsClause = locations?.length ? locations.join(', ') : 'the region'

  if (action?.signalType === 'leadership_change') {
    return `Congratulations on the new role${action.company ? ` at ${action.company}` : ''}.\n\n${firmClause}, where I specialise in recruiting across ${functionsClause}. As you build out the team around you, I'd love to help however's useful, and our experience across ${locationsClause} means we can move quickly when the time is right.\n\nWould you be open to a call to discuss in more detail?`
  }

  const opener = action?.headline ? `I saw the news: ${action.headline}.` : "I hope you're doing well."
  return `${opener}\n\n${firmClause}, where I specialise in recruiting across ${functionsClause}. Given our experience across ${locationsClause}, I'd love to help as a recruitment partner here, through our relevant candidate network, as and when the need arises.\n\nWould you be open to a call to discuss in more detail?`
}

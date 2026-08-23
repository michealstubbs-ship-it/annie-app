// Builds the final ready-to-send message shown on a signal card: a real
// greeting (using the verified contact's actual first name when we have
// one), the body Annie's scan wrote for this specific signal, and a sign-off
// that introduces the sender by name and firm.
//
// Deliberately built here in plain, deterministic code rather than asked of
// the AI prompt: verifyContact (see scanShared.js) only resolves a real
// contact AFTER the AI has already written introMessage, so the model never
// actually knows who it's writing to at generation time — asking it to
// guess a greeting produced exactly the generic "Hi — I saw the news..."
// opener this replaces. The sender's own name and firm are equally not
// something the model should invent per signal; they come from the
// recruiter's own account (profile.full_name, profile.firm_name), the same
// way every real outreach message a person sends is signed.
export function buildOutreachMessage({ body, contactFirstName, senderFirstName, firmName }) {
  const greeting = contactFirstName ? `Hi ${contactFirstName},` : 'Hi there,'
  const trimmedBody = (body || '').trim()
  const signOff = senderFirstName
    ? `\n\nBest,\n${senderFirstName}${firmName ? `\n${firmName}` : ''}`
    : firmName ? `\n\n${firmName}` : ''
  return `${greeting}\n\n${trimmedBody}${signOff}`
}

// "Jane Doe" -> "Jane". Used for both the contact being addressed and the
// sender signing off — a first name reads as a real message, a full name in
// a greeting or sign-off reads like a form letter.
export function firstNameOf(fullName) {
  return (fullName || '').trim().split(/\s+/)[0] || ''
}

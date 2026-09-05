// Turning a counterparty into a row in the CRM.
//
// The match order here is the riskiest decision in email sync, so it is worth
// stating plainly. A duplicate contact is visible and a recruiter can merge it.
// A WRONG merge is silent: two people's histories fuse and nobody ever notices.
// So this file matches on exact evidence or it creates a new row. It never
// guesses, and there is deliberately no similarity scoring anywhere in it.
//
// Measured on the production account, 2026-09-05:
//   753 contacts, 18 with an email address (2.4%)
//   0 duplicate names among the 753
//   642 companies, 1 with a website filled in
// That last number is why domain resolution goes through company_enrichment
// (570 rows, domain populated) rather than companies.website.

import { CREATE_FROM_PERSONAL } from './emailSync.js'

const NAME_NOISE = /\b(mr|mrs|ms|miss|dr|prof|eng|sheikh|h\.?e\.?)\b\.?/gi

export function normaliseName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(NAME_NOISE, ' ')
    .replace(/[^a-z؀-ۿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normaliseCompany(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[|｜].*$/, ' ')                       // "Al Akaria | العقارية"
    .replace(/\b(llc|l\.l\.c|ltd|limited|inc|plc|pjsc|psc|dwc|fzco|fze|gmbh|sa|sarl|co|company|group|holding|holdings)\b/g, ' ')
    .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// "sanamadvisory.com.sa" -> "sanamadvisory"; "e7group.ae" -> "e7group"
export function domainRoot(domain) {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '')
  if (!d) return ''
  const parts = d.split('.')
  const CO_SECOND = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'])
  if (parts.length >= 3 && CO_SECOND.has(parts[parts.length - 2])) return parts[parts.length - 3]
  if (parts.length >= 2) return parts[parts.length - 2]
  return parts[0]
}

// A readable last-resort name when nothing in the database knows this domain.
// "limad.com" -> "Limad", "e7group.ae" -> "E7group". Deliberately plain: a
// wrong-but-confident company name is harder to spot than a dull one.
export function companyNameFromDomain(domain) {
  const root = domainRoot(domain)
  if (!root) return ''
  return root
    .split(/[-_]/)
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ')
}

/**
 * What company does this email domain belong to?
 * Order: Apollo's cache (real names), then whatever the user already calls it,
 * then a plain name derived from the domain itself.
 */
export async function resolveCompanyName(supabase, domain) {
  if (!supabase || !domain) return { name: companyNameFromDomain(domain), source: 'domain' }

  const { data: enriched } = await supabase
    .from('company_enrichment')
    .select('company_name, domain')
    .eq('domain', domain)
    .limit(1)
    .maybeSingle()

  if (enriched?.company_name) return { name: enriched.company_name, source: 'enrichment' }
  return { name: companyNameFromDomain(domain), source: 'domain' }
}

/**
 * Find the user's existing company row for this name, or make one.
 * Matching is on a normalised exact name — "Al Akaria | العقارية" and
 * "Al-Akaria LLC" both reduce to "al akaria", but nothing looser than that.
 */
export async function ensureCompany(supabase, { userId, companyName, domain }) {
  const name = String(companyName || '').trim()
  if (!supabase || !userId || !name) return { id: null, name, created: false }

  const key = normaliseCompany(name)
  const { data: rows } = await supabase
    .from('companies')
    .select('id, name, website')
    .eq('user_id', userId)
    .limit(1000)

  const hit = (rows || []).find(r => normaliseCompany(r.name) === key)
  if (hit) {
    // Fill in the website if this is the first time we have learned it. 641 of
    // 642 company rows have none, and it is what makes the next match instant.
    if (!hit.website && domain) {
      await supabase.from('companies').update({ website: domain }).eq('id', hit.id)
    }
    return { id: hit.id, name: hit.name, created: false }
  }

  const teamId = await activeTeamId(supabase, userId)
  const { data: made, error } = await supabase
    .from('companies')
    .insert({ user_id: userId, name, website: domain || null, team_id: teamId, owner_id: userId })
    .select('id, name')
    .single()

  if (error || !made) return { id: null, name, created: false, error }
  return { id: made.id, name: made.name, created: true }
}

// The contacts table fills these from a trigger; companies has no such trigger,
// so we do the same lookup by hand rather than leaving a team user's rows
// stranded as personal records.
export async function activeTeamId(supabase, userId) {
  const { data } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()
  return data?.team_id || null
}

/**
 * The three-tier match.
 *
 *   matched_email      the address is already on a contact — certain
 *   matched_name       same normalised name AND same company — near certain
 *   created            no evidence of an existing record, so make one
 *   skipped_personal   a free-mail address with no existing contact behind it
 *
 * Anything looser than tier two creates a new contact on purpose.
 */
export async function matchContact(supabase, {
  userId,
  email,
  name,
  kind = 'person',
  companyName = null,
  companyId = null,
  // The 18-month sweep sets this. It has established that this person wrote
  // BACK — see mailboxSweep.js's two-way rule — which the forward path cannot
  // know from a single message, and which is the entire difference between a
  // contact and a stranger with a gmail address. Michael, 2026-09-05:
  // "Becomes a contact: anyone you and they both sent to each other."
  allowPersonal = false,
}) {
  if (!supabase || !userId || !email) {
    return { contactId: null, outcome: 'skipped_invalid', contact: null }
  }

  // Tier one — the address itself.
  const { data: byEmail } = await supabase
    .from('contacts')
    .select('id, name, title, phone, company, company_id, email, notes')
    .eq('user_id', userId)
    .ilike('email', email)
    .limit(1)
    .maybeSingle()

  if (byEmail?.id) return { contactId: byEmail.id, outcome: 'matched_email', contact: byEmail }

  // Tier two — same person, same company. Both must agree.
  const nameKey = normaliseName(name)
  if (nameKey && nameKey.includes(' ')) {
    const { data: byName } = await supabase
      .from('contacts')
      .select('id, name, title, phone, company, company_id, email, notes')
      .eq('user_id', userId)
      .ilike('name', String(name).trim())
      .limit(10)

    const companyKey = normaliseCompany(companyName || '')
    const hit = (byName || []).find(c => {
      if (normaliseName(c.name) !== nameKey) return false
      if (companyId && c.company_id && c.company_id === companyId) return true
      if (!companyKey) return false
      return normaliseCompany(c.company || '') === companyKey
    })

    if (hit) return { contactId: hit.id, outcome: 'matched_name', contact: hit }
  }

  // Tier three — create, unless this is a bare personal address the caller has
  // no two-way evidence for.
  if (kind === 'personal' && !allowPersonal && !CREATE_FROM_PERSONAL) {
    return { contactId: null, outcome: 'skipped_personal', contact: null }
  }
  if (kind === 'role') {
    return { contactId: null, outcome: 'skipped_role', contact: null }
  }

  const { data: made, error } = await supabase
    .from('contacts')
    .insert({
      user_id: userId,
      name: String(name || '').trim() || email,
      email,
      company: companyName || null,
      company_id: companyId || null,
      status: 'cold',
      created_from: 'email_sync',
      tags: ['from-email'],
    })
    .select('id, name, title, phone, company, company_id, email, notes')
    .single()

  if (error || !made) return { contactId: null, outcome: 'create_failed', contact: null, error }
  return { contactId: made.id, outcome: 'created', contact: made }
}

/**
 * Fill in a title or a direct line lifted from an email signature — but only
 * where the field is empty. Whatever the recruiter typed themselves always
 * wins; a parser is not allowed to overwrite a person's own record.
 */
export async function applySignature(supabase, contact, signature) {
  if (!supabase || !contact?.id || !signature) return { updated: false, fields: [] }

  const patch = {}
  if (signature.title && !String(contact.title || '').trim()) patch.title = signature.title
  if (signature.phone && !String(contact.phone || '').trim()) patch.phone = signature.phone
  if (!Object.keys(patch).length) return { updated: false, fields: [] }

  const { error } = await supabase.from('contacts').update(patch).eq('id', contact.id)
  return { updated: !error, fields: Object.keys(patch), error: error || null }
}

// Deliberately not toLocaleDateString. Node's en-GB renders September as
// "Sept" on some ICU builds while browsers render "Sep", so the same note
// written by the server and by the Intelligence Feed would not match — which
// breaks the duplicate check below and looks sloppy in the notes column.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function stamp(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/**
 * Append a note, exactly as the Intelligence Feed's own logger formats them, so
 * a note Annie wrote and a note the recruiter wrote sit in one readable column.
 *
 * Appends, never replaces: a contact's notes are the recruiter's own record.
 *
 * last_contacted only moves for outbound mail and genuine inbound replies. An
 * out-of-office is not contact — treating it as such would mark an approach
 * answered and stop the chase, which is worse than not logging it at all.
 */
export async function appendContactNote(supabase, {
  contactId,
  existingNotes = '',
  note,
  sentAt,
  countsAsContact = true,
}) {
  const text = String(note || '').trim()
  if (!supabase || !contactId || !text) return { ok: false, reason: 'nothing_to_write' }

  const line = `${stamp(sentAt)} — ${text}`
  const prior = String(existingNotes || '').trim()
  if (prior.includes(line)) return { ok: true, skipped: 'duplicate' }

  const merged = prior ? `${prior}\n\n${line}` : line
  const patch = { notes: merged }
  if (countsAsContact) {
    patch.last_contacted = (sentAt instanceof Date ? sentAt : new Date(sentAt)).toISOString()
  }

  const { error } = await supabase.from('contacts').update(patch).eq('id', contactId)
  return { ok: !error, notes: merged, error: error || null }
}

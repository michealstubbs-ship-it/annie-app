// Email sync — the pure decisions, with no network and no database in them.
//
// Everything here was written against a real measured sample: 50 sent and 50
// received messages from a live recruiter mailbox on 2026-09-05. The numbers
// quoted in comments are from that sample, not estimates. The headline finding
// that shaped this file: of 50 inbox messages, 30 were LinkedIn notifications,
// 6 were DMARC reports and 1 was a bank statement. Without a filter the note
// writer would have spent its whole budget summarising robots.

// Mailbox providers where the address belongs to a person but carries no
// company. A recruiter's candidates live here. We still log these messages and
// still write notes against them, but we never invent a new contact from one —
// there is no company to attach it to, and a CRM full of bare gmail addresses
// is worse than one without them. Flip CREATE_FROM_PERSONAL to change that.
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr',
  'outlook.com', 'outlook.co.uk', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aim.com',
  'protonmail.com', 'proton.me', 'pm.me', 'tutanota.com',
  'gmx.com', 'gmx.net', 'web.de', 'mail.com', 'zoho.com',
  'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com',
])

export const CREATE_FROM_PERSONAL = false

// Local parts that are machinery, not people. Matched as a whole leading token
// so "jobs-listings" and "no-reply" are caught but "robertson" and "infosys"
// are not — the trailing boundary matters more than the list does.
const AUTOMATED_LOCAL = new RegExp(
  '^(' + [
    'no-?reply', 'do-?not-?reply', 'donotreply', 'noreply', 'reply',
    'notification', 'notifications', 'notify', 'alert', 'alerts',
    'mailer', 'mailer-daemon', 'bounce', 'bounces', 'postmaster', 'hostmaster',
    'automated', 'automatic', 'autoreply', 'robot', 'daemon',
    'digest', 'newsletter', 'newsletters', 'news', 'updates',
    'billing', 'invoice', 'invoices', 'receipt', 'receipts', 'statements',
    'jobs', 'job', 'careers', 'recruiting', 'applications',
    'dmarc', 'dmarcreport', 'abuse', 'security-noreply',
    'caseresponse', 'ticket', 'tickets', 'case',
    'communications', 'messages', 'messaging', 'hit-reply', 'feedback',
  ].join('|') + ')([-._+]|$)',
  'i'
)

// Addresses that are a company's front desk rather than a person. Worth
// knowing about at company level — an approach did land somewhere — but a
// contact called "info" helps nobody.
const ROLE_LOCAL = new RegExp(
  '^(info|hello|contact|enquiries|enquiry|inquiries|admin|office|reception|' +
  'sales|marketing|support|help|helpdesk|hr|people|talent|recruitment|' +
  'accounts|finance|legal|compliance|procurement|tenders|team|general)([-._+]|$)',
  'i'
)

export function splitAddress(raw) {
  const email = String(raw || '').trim().toLowerCase()
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) return { email: '', local: '', domain: '' }
  return { email, local: email.slice(0, at), domain: email.slice(at + 1) }
}

// Some providers hand back "Bayan AlKhalaf <balkhalaf@al-akaria.com>" in the
// display_name slot rather than a bare name. Strip anything angle-bracketed,
// and drop the quotes Outlook likes to add.
export function cleanDisplayName(raw) {
  let s = String(raw || '').replace(/<[^>]*>/g, ' ').trim()
  s = s.replace(/^["']+|["']+$/g, '').trim()
  if (!s || s.includes('@')) return ''
  // "AlKhalaf, Bayan" -> "Bayan AlKhalaf"
  const comma = s.match(/^([^,]+),\s*([^,]+)$/)
  if (comma) s = `${comma[2].trim()} ${comma[1].trim()}`
  return s.replace(/\s+/g, ' ').trim()
}

// Last resort when the provider gives no display name. Measured hit rate on
// the real sample: 3 of 11 (Christina.Westhuizen parses, hwild does not), so
// this is a fallback and callers should treat its output as unconfirmed.
export function nameFromAddress(email) {
  const { local } = splitAddress(email)
  if (!local) return ''
  const parts = local.split(/[._-]+/).filter(p => /^[a-z]{2,}$/i.test(p))
  if (parts.length < 2) return ''
  return parts.map(p => p[0].toUpperCase() + p.slice(1)).join(' ')
}

// The single gate every message passes through.
//
//   person   -> match or create a contact, write a note
//   personal -> match an existing contact only, write a note, never create
//   role     -> log at company level, never create a person
//   reject   -> never stored, never sent to the note writer
export function classifyAddress(rawEmail, { ownDomains = [], ownAddresses = [] } = {}) {
  const { email, local, domain } = splitAddress(rawEmail)
  if (!email) return { kind: 'reject', reason: 'unparseable' }

  const owned = new Set(ownAddresses.map(a => String(a || '').trim().toLowerCase()))
  if (owned.has(email)) return { kind: 'reject', reason: 'self' }

  const ownDomainSet = new Set(ownDomains.map(d => String(d || '').trim().toLowerCase()))
  if (ownDomainSet.has(domain)) return { kind: 'reject', reason: 'own_domain' }

  if (AUTOMATED_LOCAL.test(local)) return { kind: 'reject', reason: 'automated' }
  if (/(^|\.)linkedin\.com$/.test(domain)) return { kind: 'reject', reason: 'automated' }
  if (/(^|\.)(microsoft|google)\.com$/.test(domain) && /dmarc|noreply/i.test(local)) {
    return { kind: 'reject', reason: 'automated' }
  }
  if (/\.(test|invalid|localhost|example)$/.test(domain)) return { kind: 'reject', reason: 'test' }
  if (/(^|\.)mailpool\.io$/.test(domain)) return { kind: 'reject', reason: 'test' }

  if (FREE_MAIL_DOMAINS.has(domain)) return { kind: 'personal', reason: 'free_mail', email, domain }
  if (ROLE_LOCAL.test(local)) return { kind: 'role', reason: 'role_address', email, domain }

  return { kind: 'person', reason: 'work_address', email, domain }
}

// ---------------------------------------------------------------------------
// Auto-replies
//
// Hannah Wild's out-of-office arrived 40 seconds after Michael's mail. Logging
// that as "she replied" is worse than not logging it at all: Annie would mark
// the approach as answered and stop chasing. Logging it as "away until 21 Sep"
// is genuinely useful — it tells him when to come back.

const AUTO_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|autoreply|out of office|ooo\b|away from (the )?office|réponse automatique|abwesenheitsnotiz|respuesta automática)/i

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

// "until Monday 21st September", "back on 21 Sep", "return on September 21".
// Deliberately narrow: a wrong date here silently suppresses a real follow-up,
// so anything it cannot read confidently comes back null.
export function parseAwayUntil(text, referenceDate) {
  const src = String(text || '')
  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate || Date.now())
  if (Number.isNaN(ref.getTime())) return null

  const window = src.match(/\b(?:until|till|til|through|back on|returning on|return on|returns on|back in the office on)\b([^.!\n]{0,60})/i)
  if (!window) return null
  const tail = window[1]

  const monthNames = Object.keys(MONTHS).join('|')
  let day = null
  let month = null

  const dayFirst = tail.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})[a-z]*`, 'i'))
  const monthFirst = tail.match(new RegExp(`\\b(${monthNames})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?`, 'i'))
  if (dayFirst) {
    day = parseInt(dayFirst[1], 10)
    month = MONTHS[dayFirst[2].slice(0, 3).toLowerCase()]
  } else if (monthFirst) {
    month = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()]
    day = parseInt(monthFirst[2], 10)
  } else {
    return null
  }
  if (!day || !month || day < 1 || day > 31) return null

  const yearHint = tail.match(/\b(20\d{2})\b/)
  let year = yearHint ? parseInt(yearHint[1], 10) : ref.getUTCFullYear()

  let out = new Date(Date.UTC(year, month - 1, day))
  if (out.getUTCMonth() !== month - 1) return null
  // No year given and the date already passed? They mean next year.
  if (!yearHint && out.getTime() < ref.getTime() - 45 * 24 * 3600 * 1000) {
    out = new Date(Date.UTC(year + 1, month - 1, day))
  }
  return out.toISOString().slice(0, 10)
}

export function detectAutoReply({ subject = '', bodyPlain = '', headers = [], date = null } = {}) {
  const hdr = {}
  for (const h of headers || []) {
    if (h && h.name) hdr[String(h.name).toLowerCase()] = String(h.value == null ? '' : h.value)
  }

  const autoSubmitted = (hdr['auto-submitted'] || '').toLowerCase()
  const precedence = (hdr['precedence'] || '').toLowerCase()
  const headerSaysAuto =
    (autoSubmitted && autoSubmitted !== 'no') ||
    'x-autoreply' in hdr || 'x-autorespond' in hdr ||
    'x-auto-response-suppress' in hdr ||
    /^(auto_reply|bulk|junk|list)$/.test(precedence)

  const subjectSaysAuto = AUTO_SUBJECT.test(subject || '')
  const isAutoReply = Boolean(headerSaysAuto || subjectSaysAuto)
  if (!isAutoReply) return { isAutoReply: false, awayUntil: null }

  return { isAutoReply: true, awayUntil: parseAwayUntil(bodyPlain, date) }
}

// ---------------------------------------------------------------------------
// Bounces
//
// The opposite failure to the out-of-office above, and a worse one. An
// out-of-office wrongly counted as an answer stops a chase. A BOUNCE wrongly
// counted as an answer says the approach landed and was replied to, when in
// fact it never arrived at all — the product would be reporting a result that
// is not merely unproven but false.
//
// classifyAddress already rejects the usual senders (mailer-daemon, postmaster,
// bounce*, no-reply), so almost every delivery failure is filtered before it
// reaches the ledger. This is the second gate, and it exists because the first
// one is an address list: Exchange and some appliances send an NDR from a
// perfectly ordinary-looking address, and an address list cannot catch that.
// Two independent checks, so neither has to be complete on its own.
//
// Every rule below is structural rather than a phrase in the prose. A DSN is a
// machine-generated document with a defined shape (RFC 3464), and matching that
// shape is what makes this safe to apply to mail from real people: a person
// writing "sorry, your last message failed to reach me" trips none of it.

const BOUNCE_SUBJECT = /^\s*(undeliverable|undelivered mail returned to sender|delivery status notification\s*\(failure\)|mail delivery fail(ed|ure)|delivery has failed|delivery failure|returned mail|failure notice|message not delivered|delivery incomplete|couldn'?t be delivered)/i

// The machine-readable body parts of a DSN (RFC 3464 §2.3). These field names
// appear nowhere in ordinary prose, which is exactly why they are the check.
const DSN_BODY_FIELD = /^(final-recipient|original-recipient|diagnostic-code|action)\s*:/im

export function detectBounce({ subject = '', bodyPlain = '', headers = [] } = {}) {
  const hdr = {}
  for (const h of headers || []) {
    if (h && h.name) hdr[String(h.name).toLowerCase()] = String(h.value == null ? '' : h.value)
  }

  // The canonical marker. A delivery status notification is a multipart/report
  // whose report-type says so, and nothing else is.
  const contentType = (hdr['content-type'] || '').toLowerCase()
  if (contentType.includes('multipart/report') && contentType.includes('delivery-status')) {
    return { isBounce: true, reason: 'dsn_content_type' }
  }

  // Postfix and Exchange both set this, and only on a failure.
  if ('x-failed-recipients' in hdr) return { isBounce: true, reason: 'failed_recipients_header' }

  if (BOUNCE_SUBJECT.test(subject || '')) return { isBounce: true, reason: 'subject' }
  if (DSN_BODY_FIELD.test(String(bodyPlain || ''))) return { isBounce: true, reason: 'dsn_body' }

  return { isBounce: false, reason: null }
}

// ---------------------------------------------------------------------------
// Signature blocks
//
// Bayan AlKhalaf's replies carry "Organization Development Senior Manager" and
// a direct extension. Apollo charges a credit for the title and does not have
// the extension at all. It is sitting in the mail for free.

const CONTACT_LINE = /^(tel|telephone|phone|mob|mobile|cell|direct|fax|email|e-mail|web|website|www\.|http|address|p\.?o\.? box|ext)\b/i
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)(?:\s*(?:ext|x|extension)[.:\s]*(\d{1,6}))?/i
const LEGAL_NOISE = /^(this (e-?mail|message)|the information|confidential|disclaimer|sent from|please consider|p\s*lease)/i

export function parseSignature(bodyPlain, { name = '' } = {}) {
  const out = { title: null, phone: null }
  const text = String(bodyPlain || '')
  if (!text.trim()) return out

  const lines = text.split(/\r?\n/).map(l => l.replace(/ /g, ' ').trim())
  const person = String(name || '').trim().toLowerCase()
  if (!person) return out

  // Find where the person signs off. The last occurrence wins: quoted history
  // below a reply repeats earlier signatures, and the freshest one is theirs.
  let anchor = -1
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase().replace(/[.,]+$/, '')
    if (l === person || (l.length < 60 && l.includes(person) && !l.includes('@'))) anchor = i
  }
  if (anchor === -1) return out

  for (let i = anchor + 1; i < Math.min(lines.length, anchor + 9); i++) {
    const line = lines[i]
    if (!line) continue
    if (/^[-_=*]{2,}$/.test(line)) break
    if (LEGAL_NOISE.test(line)) break

    if (!out.phone) {
      const m = line.match(PHONE_RE)
      if (m && /\d{6,}/.test(m[1].replace(/\D/g, ''))) {
        out.phone = m[2] ? `${m[1].trim()} ext ${m[2]}` : m[1].trim()
      }
    }
    if (!out.title && !CONTACT_LINE.test(line) && !line.includes('@')) {
      const plausible =
        line.length >= 3 && line.length <= 80 &&
        /[a-z]/i.test(line) &&
        !/^\+?\d/.test(line) &&
        !/^(kind regards|best regards|regards|thanks|thank you|sincerely|br)\b/i.test(line)
      if (plausible) out.title = line.replace(/\s+/g, ' ')
    }
    if (out.title && out.phone) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Reducing a Unipile message to the one person it is about.

export function pickCounterparty(message, { ownAddresses = [] } = {}) {
  const owned = new Set(ownAddresses.map(a => String(a || '').trim().toLowerCase()))
  const from = message?.from_attendee || null
  const fromEmail = splitAddress(from?.identifier).email
  const direction = fromEmail && owned.has(fromEmail) ? 'out' : 'in'

  if (direction === 'in') {
    if (!fromEmail) return null
    return {
      direction,
      email: fromEmail,
      name: cleanDisplayName(from?.display_name) || nameFromAddress(fromEmail),
      nameConfirmed: Boolean(cleanDisplayName(from?.display_name)),
      domain: splitAddress(fromEmail).domain,
    }
  }

  // Outbound: the first To: that is not one of the sender's own addresses.
  // CC is deliberately ignored — being copied is not a conversation, and
  // treating it as one is how a CRM fills up with people nobody spoke to.
  for (const to of message?.to_attendees || []) {
    const email = splitAddress(to?.identifier).email
    if (!email || owned.has(email)) continue
    return {
      direction,
      email,
      name: cleanDisplayName(to?.display_name) || nameFromAddress(email),
      nameConfirmed: Boolean(cleanDisplayName(to?.display_name)),
      domain: splitAddress(email).domain,
    }
  }
  return null
}

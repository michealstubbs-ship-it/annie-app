// Email formats, learned from addresses, shared as formats only.
//
// THE RULE, Michael 2026-09-05, verbatim: "We will not steal exact emails of
// contacts from our customers. What annie does, is learns the exact email
// format of clients from peoples emails and is able to recommend quality
// emails to other customers if they have a different contact from the same
// organisation."
//
// The general principle it belongs to: SHARE THE FACT ABOUT THE ORGANISATION,
// NEVER THE RECORD ABOUT THE PERSON. That "nader.ashoor@neom.com" exists is
// one customer's own data and never leaves their tenant. That NEOM writes its
// addresses as first.last is a fact about NEOM — market knowledge, the same
// class of thing as its domain or its industry, and company_enrichment has
// been a cross-customer cache of exactly that since long before this.
//
// The boundary is enforced by the shape of this module, not by care: the only
// thing learnPattern can return is a pattern key and a count. There is no code
// path here that carries an address out. The test file asserts it.
//
// And a constructed address is ALWAYS a guess. It never earns a verified
// badge — contact_verified only ever comes from a real Apollo match. If it
// bounces, that is the answer, and it cost nothing to find out.

// Strip the decorations people put around their names on LinkedIn, which is
// where almost every contact in the product came from. Measured against the
// real 753-contact account: honorifics and post-nominals appear on 41 of them.
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'professor', 'eng', 'engr', 'sheikh', 'shaikh', 'hh', 'he', 'sir', 'capt', 'rev'])
const POST_NOMINALS = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'mba', 'cfa', 'cpa', 'msc', 'bsc', 'ma', 'md', 'mcips', 'fcca', 'acca', 'pmp', 'ceng', 'mrics', 'frics', 'chfc', 'cima'])

function deaccent(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * Split a display name into the parts an address is built from.
 *
 * Returns null when there is nothing usable — a name in a non-Latin script, a
 * single word, an initial where the surname should be. Returning null is the
 * point: "layla.h@khazna.ae" is not a lead, it is noise with an @ in it.
 */
export function nameParts(raw) {
  if (!raw || typeof raw !== 'string') return null

  let s = deaccent(raw)
  // Anything in brackets is a job title, a company, or an emoji caption.
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
  // "Smith, John" — a real export shape, and the reverse of what we assume.
  const comma = s.indexOf(',')
  if (comma > 0) {
    const head = s.slice(0, comma)
    const tail = s.slice(comma + 1)
    // Only treat it as reversed if the tail is a plausible forename rather
    // than a string of post-nominals ("Ahmed Musa, PhD").
    const tailWords = tail.split(/\s+/).map(w => w.replace(/[^A-Za-z'-]/g, '')).filter(Boolean)
    const allPostNominal = tailWords.length > 0 && tailWords.every(w => POST_NOMINALS.has(w.toLowerCase()))
    s = allPostNominal ? head : (tailWords.length ? `${tail} ${head}` : head)
  }

  const words = s
    .split(/[\s.]+/)
    .map(w => w.replace(/[^A-Za-z'-]/g, ''))
    .filter(Boolean)
    .filter(w => !HONORIFICS.has(w.toLowerCase()) && !POST_NOMINALS.has(w.toLowerCase()))

  if (words.length < 2) return null

  const first = words[0].toLowerCase().replace(/[^a-z]/g, '')
  // Middle names are dropped, not joined: nobody's address is
  // first.middle.last, and guessing one would fail silently.
  const last = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '')
  if (!first || !last) return null

  // A one-letter surname is a redacted LinkedIn name ("Layla H"), not a name.
  // Refuse rather than construct "layla.h@".
  if (last.length < 2) return null
  // A one-letter forename can still build flast (j + smith), but not first.last.
  return { first, last }
}

// The formats, in rough order of how often they occur in corporate email.
// The order is load-bearing twice: it breaks ties in the learner, and it is
// the order a guess falls back through.
export const PATTERNS = [
  { key: 'first.last', build: (f, l) => `${f}.${l}` },
  { key: 'firstlast', build: (f, l) => `${f}${l}` },
  { key: 'flast', build: (f, l) => `${f[0]}${l}` },
  { key: 'first_last', build: (f, l) => `${f}_${l}` },
  { key: 'f.last', build: (f, l) => `${f[0]}.${l}` },
  { key: 'first-last', build: (f, l) => `${f}-${l}` },
  { key: 'firstl', build: (f, l) => `${f}${l[0]}` },
  { key: 'last.first', build: (f, l) => `${l}.${f}` },
  { key: 'lastf', build: (f, l) => `${l}${f[0]}` },
  { key: 'first', build: f => f },
]

const BY_KEY = new Map(PATTERNS.map(p => [p.key, p]))
const ORDER = new Map(PATTERNS.map((p, i) => [p.key, i]))

// What Annie assumes when she has learned nothing. first.last is the single
// most common corporate convention, and the card says plainly that this is
// what happened rather than implying the format was observed.
export const DEFAULT_PATTERN = 'first.last'

export function domainOf(email) {
  const at = String(email || '').lastIndexOf('@')
  if (at < 1) return null
  const d = String(email).slice(at + 1).trim().toLowerCase()
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null
}

function localOf(email) {
  const at = String(email || '').lastIndexOf('@')
  if (at < 1) return null
  // Plus-addressing is the person's own routing, not the company's format.
  return String(email).slice(0, at).trim().toLowerCase().split('+')[0]
}

/**
 * Which formats a single (name, address) pair is consistent with.
 *
 * Plural because short names are genuinely ambiguous: "Jo Li" <joli@ > matches
 * firstlast, and if the forename were a single letter it would match flast
 * too. Counting every consistent format and letting the majority decide beats
 * picking one arbitrarily from n=1.
 */
export function detectPatterns(name, email) {
  const parts = nameParts(name)
  const local = localOf(email)
  if (!parts || !local) return []
  return PATTERNS
    .filter(p => {
      try { return p.build(parts.first, parts.last) === local } catch { return false }
    })
    .map(p => p.key)
}

/**
 * Learn an organisation's format from addresses at it.
 *
 * samples: [{ name, email }] — the caller's own contacts, or (server side) the
 * pooled evidence for one domain.
 *
 * Returns { pattern, confidence, sampleCount, agreeing } or null.
 *
 * THE BOUNDARY: the return value contains no address and no name, and that is
 * the only thing this function is allowed to hand back. Everything that
 * crosses a tenant boundary crosses it through this return type.
 */
export function learnPattern(samples = []) {
  const counts = new Map()
  const seen = new Set()
  let usable = 0

  for (const s of samples) {
    const email = String(s?.email || '').toLowerCase().trim()
    if (!email || seen.has(email)) continue
    seen.add(email)
    const keys = detectPatterns(s?.name, email)
    if (!keys.length) continue
    usable += 1
    for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1)
  }

  if (!usable) return null

  let best = null
  for (const [key, n] of counts) {
    if (!best || n > best.n || (n === best.n && ORDER.get(key) < ORDER.get(best.key))) best = { key, n }
  }
  if (!best) return null

  // Mixed conventions — an acquisition that never consolidated, or a company
  // where half the addresses are aliases. Guessing here produces confident
  // wrong answers, which is worse than no guess.
  if (best.n / usable < 0.6) return null

  return {
    pattern: best.key,
    agreeing: best.n,
    sampleCount: usable,
    confidence: best.n >= 3 ? 'high' : best.n === 2 ? 'medium' : 'low',
  }
}

/**
 * Build the address.
 *
 * Returns { email, pattern, basis, confidence } or null. `basis` is what the
 * card has to say out loud:
 *   'observed' — learned from addresses at this domain
 *   'assumed'  — nothing learned, fell back to the most common format
 */
export function guessEmail({ name, domain, pattern = null, confidence = null } = {}) {
  const parts = nameParts(name)
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
  if (!parts || !d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null

  const key = pattern && BY_KEY.has(pattern) ? pattern : DEFAULT_PATTERN
  const spec = BY_KEY.get(key)
  const local = spec.build(parts.first, parts.last)
  if (!local || local.length < 3) return null

  return {
    email: `${local}@${d}`,
    pattern: key,
    basis: pattern && BY_KEY.has(pattern) ? 'observed' : 'assumed',
    confidence: pattern && BY_KEY.has(pattern) ? (confidence || 'low') : 'low',
  }
}

// How the format is described to a recruiter, who has never heard the word
// "pattern" applied to an email address.
const HUMAN = {
  'first.last': 'firstname.lastname',
  firstlast: 'firstnamelastname',
  flast: 'initial + lastname',
  first_last: 'firstname_lastname',
  'f.last': 'initial.lastname',
  'first-last': 'firstname-lastname',
  firstl: 'firstname + initial',
  'last.first': 'lastname.firstname',
  lastf: 'lastname + initial',
  first: 'firstname only',
}

export function describePattern(key) {
  return HUMAN[key] || key
}

// Domains and email formats for the card's address row.
//
// Two very different things live here, and the difference is the whole point:
//
//   DOMAINS come from company_enrichment, which has been a cross-customer
//   cache readable by every authenticated user since long before this. A
//   domain is a fact about an organisation.
//
//   FORMATS are learned from the customer's OWN contacts, contributed to a
//   pooled table as a format key and a count, and read back as an aggregate.
//   No address and no name ever crosses a tenant boundary — see
//   supabase/migrations/20260905160000_email_patterns.sql, where the schema
//   itself makes that impossible.
//
// Michael's rule, 2026-09-05: "We will not steal exact emails of contacts from
// our customers."

import { supabase } from '../supabase'
import { normalizeCompanyName } from '../companyMatch'
import { learnPattern, domainOf } from '../emailPattern'

// company_enrichment.company_name_key is a trimmed lowercase company name —
// NOT normalizeCompanyName's key. Both apollo-enrich-companies.js and
// scanShared.js write it that way, so lookups must match it exactly.
export function enrichmentKey(name) {
  return String(name || '').trim().toLowerCase()
}

/**
 * Every domain Annie holds, keyed two ways.
 *
 * `exact` matches company_enrichment's own key. `loose` is the
 * normalizeCompanyName key, because the signal's AI-written company name and
 * the contact's LinkedIn-exported one are frequently different strings for the
 * same company ("Khazna Data Centers" vs "Khazna Data Centers PJSC").
 */
export async function fetchCompanyDomains() {
  const { data, error } = await supabase
    .from('company_enrichment')
    .select('company_name, company_name_key, domain')
    .not('domain', 'is', null)
    .limit(4000)
  if (error) return { exact: new Map(), loose: new Map() }

  const exact = new Map()
  const loose = new Map()
  for (const row of data || []) {
    const domain = cleanDomain(row.domain)
    if (!domain) continue
    if (row.company_name_key) exact.set(row.company_name_key, domain)
    const key = normalizeCompanyName(row.company_name || row.company_name_key || '')
    // First writer wins on the loose key: two different companies can normalize
    // to the same string, and overwriting would silently swap one's domain for
    // the other's.
    if (key && !loose.has(key)) loose.set(key, domain)
  }
  return { exact, loose }
}

export function cleanDomain(raw) {
  const d = String(raw || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null
}

export function domainForCompany(company, domains) {
  if (!company || !domains) return null
  return domains.exact?.get(enrichmentKey(company))
    || domains.loose?.get(normalizeCompanyName(company))
    || null
}

/**
 * What this customer's own contacts show about each domain.
 *
 * Runs entirely in the browser over data the customer already has. Nothing is
 * sent anywhere to compute it.
 */
export function learnOwnPatterns(contacts = []) {
  const byDomain = new Map()
  for (const c of contacts) {
    const d = domainOf(c?.email)
    if (!d || !c?.name) continue
    if (!byDomain.has(d)) byDomain.set(d, [])
    byDomain.get(d).push({ name: c.name, email: c.email })
  }

  const out = new Map()
  for (const [domain, samples] of byDomain) {
    const learned = learnPattern(samples)
    if (learned) out.set(domain, { ...learned, source: 'own' })
  }
  return out
}

/**
 * Contribute formats to the pool.
 *
 * Sends a domain and a format key. That is the entire payload — the RPC's
 * signature cannot accept anything else. Fire-and-forget: a failure here must
 * never affect the feed.
 */
export function contributePatterns(learned) {
  for (const [domain, info] of learned || []) {
    // One address is not evidence of a convention, and publishing it would
    // pollute the pool for everyone.
    if (!info || info.confidence === 'low') continue
    supabase.rpc('record_email_pattern', {
      p_domain: domain,
      p_pattern: info.pattern,
      p_samples: info.sampleCount || 1,
    }).then(() => {}, () => {})
  }
}

/**
 * Read the pooled format for domains this customer has learned nothing about.
 *
 * Deliberately only called for the domains actually on screen — this is one
 * round trip per domain, and the feed shows ten cards, not six hundred.
 */
export async function fetchPooledPatterns(domains = []) {
  const wanted = [...new Set(domains.filter(Boolean))].slice(0, 25)
  const out = new Map()
  await Promise.all(wanted.map(async domain => {
    try {
      const { data, error } = await supabase.rpc('email_pattern_for', { p_domain: domain })
      if (error) return
      const row = Array.isArray(data) ? data[0] : data
      if (!row?.pattern) return
      out.set(domain, {
        pattern: row.pattern,
        // Confidence is how many DISTINCT customers agree, not how many
        // addresses were seen — one customer with a big CRM is one opinion.
        confidence: row.voters >= 3 ? 'high' : row.voters === 2 ? 'medium' : 'low',
        sampleCount: row.samples || 0,
        voters: row.voters || 0,
        source: 'pooled',
      })
    } catch { /* the address row simply falls back to the assumed format */ }
  }))
  return out
}

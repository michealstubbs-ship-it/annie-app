// Every item in the stream ends with a way to reach a human, even when Apollo
// has nothing. Michael, 2026-09-04: "always give a LinkedIn profile."
//
// Three tiers, and the copy is honest about which one the recruiter is
// getting. The third is a keyword search, not a person, and pretending
// otherwise is how a product loses trust the first time a link goes nowhere.
//
// All three are ordinary links the recruiter clicks while signed in as
// themselves. Annie never stores a LinkedIn session cookie or credentials and
// never scrapes — see CLAUDE.md.

export const ROUTE_PROFILE = 'profile'
export const ROUTE_COMPANY_PEOPLE = 'company_people'
export const ROUTE_SEARCH = 'search'

// LinkedIn's real company URLs are vanity slugs it assigns, not a
// transformation of the company name, and its people filter needs an internal
// numeric id that cannot be constructed from anything we hold. So the company
// tier is only offered when a company slug is actually known — guessing one
// produces a 404 that reads as a broken product.
function slugFromLinkedinUrl(url) {
  if (!url) return null
  const m = String(url).match(/linkedin\.com\/company\/([^/?#]+)/i)
  return m ? m[1] : null
}

/**
 * Builds the best available LinkedIn route for a signal.
 *
 * contact:  an optional resolved contact ({ linkedin_url, name })
 * signal:   the intelligence_signals row
 *
 * Returns { tier, url, label, approximate } — `approximate` is true only for
 * the keyword search, and the UI must say so where it renders.
 */
export function buildLinkedinRoute(signal, contact = null) {
  const profileUrl = contact?.linkedin_url || signal?.contact_linkedin_url
  if (profileUrl && /linkedin\.com\/in\//i.test(profileUrl)) {
    return {
      tier: ROUTE_PROFILE,
      url: profileUrl,
      label: contact?.name ? `${contact.name} on LinkedIn` : 'Their LinkedIn profile',
      approximate: false,
    }
  }

  const companySlug = slugFromLinkedinUrl(signal?.company_linkedin_url) || slugFromLinkedinUrl(signal?.company_logo_url)
  if (companySlug) {
    return {
      tier: ROUTE_COMPANY_PEOPLE,
      url: `https://www.linkedin.com/company/${companySlug}/people/`,
      label: 'Their people on LinkedIn',
      approximate: false,
    }
  }

  const company = (signal?.company_name || '').trim()
  if (!company) return null

  // Aim the search at the roles this signal implies, so the recruiter lands on
  // a useful page rather than the company's whole headcount. likely_roles is
  // written at scan time; title_keywords is the older field.
  const roles = Array.isArray(signal?.likely_roles) && signal.likely_roles.length
    ? signal.likely_roles
    : (Array.isArray(signal?.title_keywords) ? signal.title_keywords : [])
  const keywords = [company, ...roles.slice(0, 2)].join(' ')

  return {
    tier: ROUTE_SEARCH,
    url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`,
    label: roles.length ? `Search: ${company} + ${roles[0]}` : `Search LinkedIn for ${company}`,
    // The one tier that can legitimately return nothing. Say so.
    approximate: true,
  }
}

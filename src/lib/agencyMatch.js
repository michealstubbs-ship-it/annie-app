// Shared "is this actually a staffing/recruitment agency, not a real hiring
// employer" check. Moved here (was previously only in
// netlify/functions/lib/scanShared.js) for the same reason as jsonExtract.js
// and textSanitize.js: this is genuinely shared logic, not backend-only.
//
// 2026-09-02 audit fix: the write-time check in scanShared.js (still the
// primary defense — it stops a bad live_job signal from ever being written,
// and saves an Apollo enrichment credit by checking the name first) only
// protects signals created AFTER it shipped. Four "Quik Hire Staffing"
// live_job rows already sat in intelligence_signals from before the fix
// landed, and Today's Actions/the Feed have no read-time check of their
// own — so they kept surfacing indefinitely, exactly the persistent-list
// behavior that's otherwise the point (an item stays until marked done or
// its record is gone). A stale pre-fix row is never marked done by the
// user or "gone" on its own, so it would have sat there forever. This
// export is now also applied as a read-time filter in sourcedPool.js and
// relationshipPool.js, so no live_job signal can surface as a lead
// regardless of when it was written — same "defense in depth" pattern
// those two files already use for their own per-company dedup collapse.
//
// 2026-09-02, Michael, real report: a live_job lead ("Private Equity -
// Investment Associate (Remote)" at "Quik Hire Staffing") turned out to be
// posted BY another recruitment/staffing firm on behalf of an anonymous
// client, not a genuine hiring company — the "contact" Annie surfaced (the
// agency's own founder) is a rival recruiter, not a hiring manager, so
// there's no real BD opportunity there the way there is for a company
// actually filling its own seat.
const STAFFING_AGENCY_NAME_PATTERN = /\b(staffing|recruitment|recruiting|recruiters?|talent (partners|solutions|acquisition)|search (partners|group)|headhunt(ing|ers?)|executive search|manpower)\b/i

export function looksLikeStaffingAgencyName(companyName) {
  if (!companyName) return false
  return STAFFING_AGENCY_NAME_PATTERN.test(companyName)
}

// Apollo/LinkedIn's own industry classification — catches an agency whose
// name gives no hint at all. Not a guess from text; the same real
// company_industry field already stored on every signal.
const STAFFING_AGENCY_INDUSTRY_PATTERN = /staffing|recruiting|recruitment/i

export function isStaffingAgencyIndustry(industry) {
  if (!industry) return false
  return STAFFING_AGENCY_INDUSTRY_PATTERN.test(industry)
}

// Convenience combined check for the read-time pool filters — true if
// either signal says "this is an agency, not the hiring employer".
export function looksLikeStaffingAgency(companyName, industry) {
  return looksLikeStaffingAgencyName(companyName) || isStaffingAgencyIndustry(industry)
}

// 2026-09-06, Michael, real report: two live_job leads surfaced with
// "COPADO User Group Hyderabad" and "AWS User Group SE" as the company, a
// Salesforce/AWS meetup community, not a hiring employer. Same failure
// shape as the Quik Hire Staffing incident above (a non-employer entity's
// name ends up in the company field), just a different vocabulary: the AI
// found a real hiring mention inside a LinkedIn post, but the post was
// shared by or through a user group / meetup / community page, and that
// page's own name got written down as "company" instead of the actual
// employer named in the post's text. There is no real BD opportunity at a
// meetup group's own page, so this is a hard drop, same as an agency name.
const NON_EMPLOYER_ORG_NAME_PATTERN = /\b(user group|users? group|meetup|meet-?up group|community( group)?|chapter|association|alumni( network)?|forum)\b/i

export function looksLikeCommunityOrGroupName(companyName) {
  if (!companyName) return false
  return NON_EMPLOYER_ORG_NAME_PATTERN.test(companyName)
}

// Combined "not a genuine hiring employer" check, for anywhere that used to
// call looksLikeStaffingAgency alone. An agency and a community/meetup
// page are different vocabularies but the same underlying problem, so
// every caller of the agency check gets this one too rather than needing
// its own separate second call.
export function looksLikeNonEmployerOrg(companyName, industry) {
  return looksLikeStaffingAgency(companyName, industry) || looksLikeCommunityOrGroupName(companyName)
}

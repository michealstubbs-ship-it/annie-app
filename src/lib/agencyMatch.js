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

import React from 'react'

// The single, consistent "what to look for" breakdown — same heading, same
// three bullet points, in the same order, on every signal card regardless
// of which signal type or which of the two scan prompts produced it (see
// candidateProfile in both scan-now-background.js and intelligence-scan.js,
// and sanitizeCandidateProfile in scanShared.js, which is what guarantees
// this shape). Replaces a single paragraph of freeform "bench strength"
// text that read as vague marketing copy — a recruiter can act on a real
// range, a named function, and three concrete lists of companies to
// search, not on "we work with strong candidates in this space."
export default function CandidateProfileBox({ profile }) {
  if (!profile) return null
  const { yearsMin, yearsMax, functionalExperience, directCompetitors, similarIndustry, widerScope } = profile
  const hasYears = yearsMin != null || yearsMax != null
  const hasCompanies = directCompetitors?.length > 0 || similarIndustry?.length > 0 || widerScope?.length > 0
  if (!hasYears && !functionalExperience && !hasCompanies) return null

  const yearsLabel = yearsMin != null && yearsMax != null
    ? (yearsMin === yearsMax ? `${yearsMin}+ years` : `${yearsMin}–${yearsMax} years`)
    : `${yearsMin ?? yearsMax}+ years`

  return (
    <div className="rounded-lg px-3.5 py-3 mb-2.5 bg-page-bg border border-gray-200/70">
      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">If you had a candidate with this profile</p>
      <ul className="space-y-1.5 text-[11.5px] text-gray-700 leading-relaxed">
        {hasYears && (
          <li><span className="font-semibold text-navy">Experience needed: </span>{yearsLabel}</li>
        )}
        {functionalExperience && (
          <li><span className="font-semibold text-navy">Functional experience: </span>{functionalExperience}</li>
        )}
        {hasCompanies && (
          <li>
            <span className="font-semibold text-navy block mb-1">Companies to look at:</span>
            <ul className="space-y-0.5 pl-3.5">
              {directCompetitors?.length > 0 && (
                <li>&bull; <span className="text-gray-500">Direct competitors:</span> {directCompetitors.join(', ')}</li>
              )}
              {similarIndustry?.length > 0 && (
                <li>&bull; <span className="text-gray-500">Similar industry:</span> {similarIndustry.join(', ')}</li>
              )}
              {widerScope?.length > 0 && (
                <li>&bull; <span className="text-gray-500">Wider scope:</span> {widerScope.join(', ')}</li>
              )}
            </ul>
          </li>
        )}
      </ul>
    </div>
  )
}

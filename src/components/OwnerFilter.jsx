import React from 'react'

// Reusable "Owned by" filter dropdown — same team-roster list backs this
// wherever it's used (Candidates.jsx, Contacts.jsx, Companies.jsx), rather
// than three separate ad-hoc dropdowns. 2026-09-03, Michael: "there should
// be a drop down to that specific license with everyone on the license so
// that you can always see who added the contact/company/candidate."
//
// Renders nothing on a solo team (teamMembers.length <= 1) — there's no
// one else to filter by yet, and an always-visible "Owned by: Everyone"
// dropdown with a single option would just be clutter until a second seat
// is actually active.
export default function OwnerFilter({ value, onChange, teamMembers, className = '' }) {
  if (!teamMembers || teamMembers.length <= 1) return null
  return (
    <select
      className={`input max-w-[200px] ${className}`}
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label="Filter by owner"
    >
      <option value="all">Owned by: Everyone</option>
      {teamMembers.map(m => (
        <option key={m.id} value={m.id}>Owned by: {m.name}</option>
      ))}
    </select>
  )
}

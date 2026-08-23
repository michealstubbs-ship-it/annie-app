import React, { useState } from 'react'

function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

function logoColor(name) {
  const colors = ['#0d1b3e', '#b45309', '#1d4ed8', '#15803d', '#a21caf', '#6d28d9']
  let hash = 0
  for (const ch of (name || '')) hash = (hash * 31 + ch.charCodeAt(0)) % colors.length
  return colors[Math.abs(hash) % colors.length]
}

// Every company Annie mentions gets a real logo wherever possible — the
// backend (enrichCompany in netlify/functions/lib/scanShared.js) already
// resolves one before a signal is ever written: Apollo's own logo when it
// matched the company, or a Clearbit domain-based logo as a fallback when
// it didn't. This component is the last line of defence on top of that: if
// the resolved URL still fails to load (a dead link, or a company obscure
// enough that even the fallback lookup came up empty), it swaps to a
// colored initials tile rather than leaving broken or empty space — so a
// company is never shown with nothing at all, even in that rare case.
//
// Shared by IntelligenceFeed and TodaysActions so "every company gets a
// real logo, and the same graceful fallback either way" is guaranteed by
// one component rather than two components trying to agree.
export default function CompanyLogo({ name, logoUrl, size = 'w-8 h-8', textSize = 'text-[11px]' }) {
  const [failed, setFailed] = useState(false)

  if (logoUrl && !failed) {
    return (
      <img
        src={logoUrl}
        alt=""
        className={`${size} rounded-lg object-cover flex-shrink-0 bg-white border border-gray-100`}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <div
      className={`${size} rounded-lg flex items-center justify-center text-white ${textSize} font-bold flex-shrink-0`}
      style={{ backgroundColor: logoColor(name) }}
    >
      {initials(name)}
    </div>
  )
}

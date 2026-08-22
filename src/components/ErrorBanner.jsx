import React from 'react'

// The exact same error banner markup was duplicated ~20 times across the
// app with no role="alert" anywhere — meaning a screen-reader user was
// never reliably notified when a save or load failed. Extracted 2026-08-22
// so that gap is fixed once, centrally, instead of in twenty places.
export default function ErrorBanner({ children, className = '' }) {
  if (!children) return null
  return (
    <div role="alert" className={`bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3 ${className}`}>
      {children}
    </div>
  )
}

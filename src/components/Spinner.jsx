import React from 'react'

// The exact same spinner markup was duplicated across 6+ files with only
// the size varying — extracted 2026-08-22 alongside PageLoader and
// ErrorBanner, the same fix already applied once to modal dialogs
// (Modal.jsx). `size` picks the two variants actually used in the codebase.
export default function Spinner({ size = 'md', className = '' }) {
  const dims = size === 'lg' ? 'w-12 h-12 border-4' : 'w-8 h-8 border-4'
  return <div className={`${dims} border-gold border-t-transparent rounded-full animate-spin ${className}`} />
}

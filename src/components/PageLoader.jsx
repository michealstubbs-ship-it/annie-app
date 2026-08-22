import React from 'react'
import Spinner from './Spinner'

// Full-page centered loading state — App.jsx had three near-identical
// copies of this (one per route guard) before this extraction, and it's
// also what every lazy-loaded route now falls back to during
// React.lazy()'s chunk fetch (see App.jsx's <Suspense>).
export default function PageLoader({ label }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-page-bg">
      <div className="text-center">
        <Spinner size="lg" className="mx-auto" />
        {label && <p className="text-gray-500 font-medium mt-4">{label}</p>}
      </div>
    </div>
  )
}

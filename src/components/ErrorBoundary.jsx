import React from 'react'
import { reportClientError } from '../lib/errorReporting'

// Every dashboard sub-page is React.lazy-loaded (see Dashboard.jsx), and
// Vite doesn't keep old build output around after a new deploy. A customer
// who already has the app open in a tab is still holding an index.html that
// references the PREVIOUS deploy's chunk hashes — the moment we ship again,
// their next in-app navigation to any route they haven't already visited
// this session tries to fetch a chunk file that no longer exists, and
// throws "Failed to fetch dynamically imported module" (Firefox/Safari
// phrase it slightly differently: "error loading dynamically imported
// module" / "Importing a module script failed"). This is not a real bug in
// that page, it's a stale reference to a deploy that no longer exists, and
// it is fully fixed by one reload, which fetches the current index.html
// with correct hashes. Caught this hitting a real customer twice within 20
// minutes (two deploys landing back-to-back while their tab stayed open),
// each time surfacing as the generic "Something went wrong" card below —
// technically recoverable (the button says so), but needlessly alarming
// for something that isn't actually broken.
const CHUNK_LOAD_ERROR_RE = /Failed to fetch dynamically imported module|Loading chunk .* failed|error loading dynamically imported module|Importing a module script failed/i

// One auto-reload per browser tab, not per error: if the reload doesn't
// clear it (a real network problem, not a stale chunk), retrying forever
// would loop the tab instead of ever showing the customer anything.
// sessionStorage (not a module-level variable) survives the reload itself,
// which is the whole point of needing a flag at all.
const AUTO_RELOAD_KEY = 'annie_chunk_reload_attempted'

// Catches render-time errors that the global window handlers in
// errorReporting.js can't (React swallows those instead of letting them
// reach window.onerror) — without this, a broken render past this point
// used to mean a blank white page with no clue anything went wrong, for
// either the customer or us.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    reportClientError(error.message, error, { kind: 'react-render', componentStack: info?.componentStack })

    if (CHUNK_LOAD_ERROR_RE.test(error?.message || '')) {
      let alreadyTried = false
      try { alreadyTried = sessionStorage.getItem(AUTO_RELOAD_KEY) === '1' } catch {}
      if (!alreadyTried) {
        try { sessionStorage.setItem(AUTO_RELOAD_KEY, '1') } catch {}
        window.location.reload()
        return
      }
      // Reload already happened once this tab and it's STILL a chunk-load
      // error — genuinely stuck (offline, a CDN issue), not a stale
      // reference. Fall through to the normal error card rather than
      // reload-looping the tab forever.
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-page-bg px-6">
          <div className="card p-8 max-w-sm text-center">
            <h1 className="text-xl font-bold text-navy mb-2">Something went wrong</h1>
            <p className="text-gray-500 text-sm mb-5">
              Annie hit an unexpected error. This has been logged, and reloading the page usually fixes it.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="bg-navy text-white px-5 py-2.5 rounded-lg text-sm font-medium"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

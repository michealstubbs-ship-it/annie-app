import React from 'react'
import { reportClientError } from '../lib/errorReporting'

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
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-page-bg px-6">
          <div className="card p-8 max-w-sm text-center">
            <h1 className="text-xl font-bold text-navy mb-2">Something went wrong</h1>
            <p className="text-gray-500 text-sm mb-5">
              Annie hit an unexpected error. This has been logged — reloading the page usually fixes it.
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

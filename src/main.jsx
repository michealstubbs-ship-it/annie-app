import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { clearChunkReloadGuard } from './lib/chunkReloadGuard.js'
import { installGlobalErrorReporting } from './lib/errorReporting.js'
import { initAnalytics } from './lib/analytics.js'
import './index.css'

installGlobalErrorReporting()
initAnalytics()

// Reaching this line at all proves the current tab just fetched a fresh,
// matching-hash entry bundle for whatever the current deploy is (a stale
// entry reference would have failed as a plain network error before any of
// this module's code ran, not as the dynamic-import failure ErrorBoundary
// catches). So this is the right, and only, place to clear the one-shot
// auto-reload guard — see ErrorBoundary.jsx's own comment on why it must be
// cleared at all, not just set.
clearChunkReloadGuard()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)

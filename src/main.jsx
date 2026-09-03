import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { installGlobalErrorReporting } from './lib/errorReporting.js'
import { initAnalytics } from './lib/analytics.js'
import { registerServiceWorker } from './lib/registerServiceWorker.js'
import './index.css'

installGlobalErrorReporting()
initAnalytics()
registerServiceWorker()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)

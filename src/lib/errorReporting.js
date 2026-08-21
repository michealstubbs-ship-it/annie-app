// Client-side counterpart to netlify/functions/lib/reportError.js. Same
// table (public.error_logs), same "must never throw" rule — a broken error
// reporter must never turn one real error into a second, worse one, and it
// must never block whatever the user was actually trying to do.
//
// Insert-only from here: the RLS policy on error_logs allows anon and
// authenticated to INSERT and nothing else, so this can run before login
// (a failed signup, a login error) as well as after.
import { supabase } from './supabase'

export function reportClientError(message, err, context = {}) {
  try {
    supabase.from('error_logs').insert({
      source: 'client',
      message: String(message || (err && err.message) || 'Unknown error'),
      stack: err && err.stack ? String(err.stack) : null,
      context,
      url: typeof window !== 'undefined' ? window.location.href : null,
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    }).then(() => {}, () => {})
  } catch {
    // Reporting the error must never throw — see file header.
  }
}

// Call once, from main.jsx, before anything else renders. Catches the
// errors React's own error boundary can't: things that happen outside a
// render (a rejected promise nobody awaited, a script error in an event
// handler) which otherwise only ever showed up in a console nobody was
// watching.
export function installGlobalErrorReporting() {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (event) => {
    reportClientError(event.message, event.error, { kind: 'window.onerror' })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    reportClientError(reason && reason.message ? reason.message : 'Unhandled promise rejection', reason instanceof Error ? reason : null, { kind: 'unhandledrejection' })
  })
}

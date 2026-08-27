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
      // 2026-08-26 audit fix: the hash fragment is stripped before logging.
      // This app is path-routed (react-router-dom, no HashRouter) — the URL
      // hash is never meaningful for app navigation, only ever used by
      // Supabase for auth tokens (password-recovery and invite links carry
      // access_token/refresh_token/type=recovery in the hash). supabase-js
      // strips that hash itself, but asynchronously — there was a real,
      // narrow window right after landing on /reset-password from an
      // emailed link where an unrelated error firing here would have
      // written the live recovery token straight into error_logs (visible
      // to any admin, per that table's own RLS, until the token expired or
      // was used). Splitting off the hash unconditionally closes this
      // regardless of that timing window, and costs nothing — no error
      // report anywhere in this app has ever needed the hash portion of a
      // URL to be useful for debugging.
      url: typeof window !== 'undefined' ? window.location.href.split('#')[0] : null,
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

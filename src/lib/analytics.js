// PostHog wrapper. Same fail-open philosophy as reserveApolloCredits and
// alertIfConfigured elsewhere in this codebase: analytics is observability,
// not a dependency anything else relies on, so a missing key, a blocked
// network request, or PostHog itself being down must never break the app or
// throw somewhere a real feature is waiting on it. Every function here is
// safe to call even when analytics isn't configured at all — they just do
// nothing.
//
// posthog-js itself is dynamically imported, not a top-level import — it's
// a large library (~250KB), and every call site here already tolerates
// analytics not being ready yet (buffering events until init resolves, or
// silently no-op-ing if the key was never set). Loading it eagerly would
// mean every visitor downloads it even with analytics switched off, or
// before it's had any chance to matter for the page they're on.
let posthogPromise = null
let initialized = false
let queuedIdentify = null
const queuedEvents = []

function loadPosthog() {
  if (!posthogPromise) posthogPromise = import('posthog-js').then(m => m.default)
  return posthogPromise
}

export function initAnalytics() {
  const key = import.meta.env.VITE_POSTHOG_KEY
  if (!key) return // no key set — analytics is simply off, not broken
  loadPosthog()
    .then(posthog => {
      posthog.init(key, {
        api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
        // Recent posthog-js defaults auto-capture SPA route changes via the
        // History API, so react-router navigation is tracked as pageviews
        // without any manual wiring in App.jsx.
        defaults: '2026-05-30',
      })
      initialized = true
      // Anything that tried to identify/track before this async load
      // finished (e.g. AuthContext resolving a session before PostHog has
      // downloaded) — replay it now instead of silently dropping it.
      if (queuedIdentify) { posthog.identify(...queuedIdentify); queuedIdentify = null }
      for (const [name, props] of queuedEvents.splice(0)) posthog.capture(name, props)
    })
    .catch(err => console.error('[analytics] init failed:', err.message))
}

// Ties events to a real Annie account so usage can be looked at per
// customer, not just in aggregate. Called once the profile row is available
// (see AuthContext.jsx's fetchProfile) rather than at init, since no user id
// is known yet at app load. Takes the profile row itself, not the Supabase
// auth user object, since profiles.email is already the field the rest of
// the app treats as this account's email — one less thing to keep in sync.
export function identifyUser(userId, profile) {
  if (!userId || !import.meta.env.VITE_POSTHOG_KEY) return
  const traits = { email: profile?.email || null, firm_name: profile?.firm_name || null, is_admin: !!profile?.is_admin }
  if (!initialized) { queuedIdentify = [userId, traits]; return }
  loadPosthog().then(posthog => posthog.identify(userId, traits)).catch(() => {})
}

// Called on sign-out so the next person to use this browser (a shared
// machine, a demo) doesn't have their activity attributed to whoever was
// logged in before them.
export function resetAnalytics() {
  if (!initialized) return
  loadPosthog().then(posthog => posthog.reset()).catch(() => {})
}

export function trackEvent(name, properties = {}) {
  if (!import.meta.env.VITE_POSTHOG_KEY) return
  if (!initialized) { queuedEvents.push([name, properties]); return }
  loadPosthog().then(posthog => posthog.capture(name, properties)).catch(() => {})
}

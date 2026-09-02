// Backs the "feature adoption" panel on Annie Overview's Product &
// Engineering tab — which real features customers actually use, not just
// that Annie is installed. This can't be a Postgres RPC like every other
// admin-overview read (get_admin_account_summary etc.) — the events it
// reads live in PostHog, not Supabase, because that's where usage
// telemetry has always been sent (see src/lib/analytics.js: named
// business events like ask_annie_message_sent, signal_actioned,
// linkedin_import_completed, onboarding_completed; plus automatic
// $pageview events for every route). Rather than inventing a second,
// parallel event table in Supabase and wiring a duplicate tracking call
// into every page — the exact kind of drift this codebase has spent this
// whole audit closing — this reads the tracking system that already
// exists and already fires on real usage.
//
// The authorization bar is identical to every other admin-overview read
// (is_admin, checked server-side); it's just enforced here in JS instead
// of inside a SECURITY DEFINER function, because that's where the data
// actually lives (same reasoning as admin-resource-caps.js).
//
// Requires POSTHOG_PERSONAL_API_KEY (a personal/query-scoped API key —
// NOT the public VITE_POSTHOG_KEY project key, which can only ever send
// events, never read them back) and POSTHOG_PROJECT_ID, set in Netlify.
// Until those are set this returns configured:false rather than an error,
// same fail-open posture as every other optional external integration
// here (Resend, Apollo) — the panel shows "connect PostHog" instead of
// blanking the whole Overview tab.
import { createClient } from '@supabase/supabase-js'
import { getAuthedUser } from './lib/auth.js'
import { jsonError } from './lib/httpError.js'
import { createTimeoutFetch } from './lib/scanShared.js'
import { reportServerError } from './lib/reportError.js'

// Route -> human label for the pageview breakdown. Kept in sync with
// Dashboard.jsx's actual <Route path="..."> list by hand (there is no way
// to introspect react-router's route tree from a Netlify function) —
// mirrors what "Deleted" or renamed routes would need updating with a
// PageviewPathnames-hitting Dashboard.jsx change.
const ROUTE_LABELS = {
  '/dashboard': 'Overview',
  '/dashboard/actions': "Today's Actions",
  '/dashboard/intelligence-feed': 'Intelligence Feed',
  '/dashboard/candidates': 'Candidates',
  '/dashboard/meetings': 'Meetings',
  '/dashboard/tasks': 'Tasks',
  '/dashboard/companies': 'Companies',
  '/dashboard/jobs': 'Jobs & Mandates',
  '/dashboard/invoices': 'Invoices',
  '/dashboard/contacts': 'Contacts',
  '/dashboard/pipeline': 'BD Pipeline',
  '/dashboard/chat': 'Ask Annie',
  '/dashboard/settings': 'Settings',
  '/dashboard/billing': 'Billing',
}

// Named business events already sent from real user actions (see
// src/lib/analytics.js call sites) — these are stronger adoption signals
// than a pageview, since each one is a completed action, not just a visit.
const NAMED_EVENT_LABELS = {
  onboarding_completed: 'Onboarding completed',
  linkedin_import_completed: 'LinkedIn import completed',
  signal_actioned: 'Signal actioned (Feed)',
  signal_added_to_bd_actions: 'Added to BD Actions',
  ask_annie_message_sent: 'Ask Annie message sent',
}

function pageviewQuery() {
  return {
    kind: 'HogQLQuery',
    query: `
      SELECT properties.$pathname AS path,
             countIf(timestamp > now() - INTERVAL 7 DAY) AS events_7d,
             count(DISTINCT if(timestamp > now() - INTERVAL 7 DAY, person_id, NULL)) AS users_7d,
             countIf(timestamp > now() - INTERVAL 30 DAY) AS events_30d,
             count(DISTINCT if(timestamp > now() - INTERVAL 30 DAY, person_id, NULL)) AS users_30d
      FROM events
      WHERE event = '$pageview' AND timestamp > now() - INTERVAL 30 DAY
      GROUP BY path
    `,
  }
}

function namedEventQuery() {
  const names = Object.keys(NAMED_EVENT_LABELS).map(n => `'${n}'`).join(', ')
  return {
    kind: 'HogQLQuery',
    query: `
      SELECT event,
             countIf(timestamp > now() - INTERVAL 7 DAY) AS events_7d,
             count(DISTINCT if(timestamp > now() - INTERVAL 7 DAY, person_id, NULL)) AS users_7d,
             countIf(timestamp > now() - INTERVAL 30 DAY) AS events_30d,
             count(DISTINCT if(timestamp > now() - INTERVAL 30 DAY, person_id, NULL)) AS users_30d
      FROM events
      WHERE event IN (${names}) AND timestamp > now() - INTERVAL 30 DAY
      GROUP BY event
    `,
  }
}

// PostHog's query API returns { columns: [...], results: [[...], ...] } —
// read by column name rather than trusting positional order, so a future
// column reorder on PostHog's side can't silently swap two numbers.
function rowsToObjects(columns, results) {
  return (results || []).map(row => {
    const obj = {}
    columns.forEach((col, i) => { obj[col] = row[i] })
    return obj
  })
}

async function runQuery(apiHost, projectId, apiKey, fetchImpl, query) {
  const resp = await fetchImpl(`${apiHost}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!resp.ok) throw new Error(`PostHog query failed: ${resp.status}`)
  const body = await resp.json()
  return rowsToObjects(body.columns || [], body.results || [])
}

export default async (req) => {
  if (req.method !== 'GET') {
    return jsonError(405, 'Method not allowed')
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return jsonError(500, 'Not configured')
  }

  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError || !user) {
    return jsonError(401, 'Invalid session')
  }

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })
  const { data: profile, error: profileError } = await supabase.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  if (profileError || !profile?.is_admin) {
    return jsonError(403, 'Not authorized')
  }

  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY
  const projectId = process.env.POSTHOG_PROJECT_ID
  const apiHost = process.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com'
  if (!apiKey || !projectId) {
    // Real, expected state until Michael sets these two in Netlify — not
    // an error. The frontend shows a "connect PostHog" prompt for this.
    return new Response(JSON.stringify({ configured: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const fetchImpl = createTimeoutFetch()
    const [pageviewRows, namedRows] = await Promise.all([
      runQuery(apiHost, projectId, apiKey, fetchImpl, pageviewQuery()),
      runQuery(apiHost, projectId, apiKey, fetchImpl, namedEventQuery()),
    ])

    const pages = pageviewRows
      .filter(r => ROUTE_LABELS[r.path])
      .map(r => ({
        path: r.path,
        label: ROUTE_LABELS[r.path],
        usersLast7d: Number(r.users_7d) || 0,
        usersLast30d: Number(r.users_30d) || 0,
        eventsLast7d: Number(r.events_7d) || 0,
        eventsLast30d: Number(r.events_30d) || 0,
      }))
      .sort((a, b) => b.usersLast30d - a.usersLast30d)

    const events = namedRows
      .filter(r => NAMED_EVENT_LABELS[r.event])
      .map(r => ({
        name: r.event,
        label: NAMED_EVENT_LABELS[r.event],
        usersLast7d: Number(r.users_7d) || 0,
        usersLast30d: Number(r.users_30d) || 0,
        eventsLast7d: Number(r.events_7d) || 0,
        eventsLast30d: Number(r.events_30d) || 0,
      }))
      .sort((a, b) => b.usersLast30d - a.usersLast30d)

    return new Response(JSON.stringify({ configured: true, pages, events }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('admin-feature-adoption', err, { userId: user.id })
    // Same "never blank the whole tab for one data source's failure"
    // posture as the rest of Annie Overview — the caller gets a clear
    // configured:true-but-empty-handed signal rather than a 500 that would
    // fail the Promise.all in loadAdminOverview() and blank everything.
    return new Response(JSON.stringify({ configured: true, pages: [], events: [], error: 'fetch_failed' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/admin-feature-adoption' }

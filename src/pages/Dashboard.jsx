import React, { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from '../components/Sidebar'
import Spinner from '../components/Spinner'
import ErrorBoundary from '../components/ErrorBoundary'
import { useAuth } from '../contexts/AuthContext'

const Contacts = lazy(() => import('../components/Contacts'))
const Pipeline = lazy(() => import('../components/Pipeline'))
const Chat = lazy(() => import('../components/Chat'))
const Settings = lazy(() => import('../components/Settings'))
const LinkedInImport = lazy(() => import('./LinkedInImport'))
const Insights = lazy(() => import('../components/Insights'))
const IntelligenceFeed = lazy(() => import('../components/IntelligenceFeed'))
const Candidates = lazy(() => import('../components/Candidates'))
const Meetings = lazy(() => import('../components/Meetings'))
const Tasks = lazy(() => import('../components/Tasks'))
const Companies = lazy(() => import('../components/Companies'))
const Jobs = lazy(() => import('../components/Jobs'))
const JobPipeline = lazy(() => import('../components/JobPipeline'))
const Overview = lazy(() => import('../components/Overview'))
const Billing = lazy(() => import('../components/Billing'))
const Invoices = lazy(() => import('../components/Invoices'))
const TeamPerformance = lazy(() => import('../components/TeamPerformance'))

function RoutePageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Spinner />
    </div>
  )
}

// Sidebar.jsx already hides the "Insights" link for non-admins, but that
// was cosmetic only — the route itself rendered for any logged-in,
// onboarded user with no admin check, and Insights.jsx calls RPCs
// (get_support_insights, get_support_conversations) that return every
// customer's support conversation content. This is the actual enforcement:
// a non-admin who navigates to /dashboard/insights directly is redirected
// away before the component (and its RPC calls) ever mounts. Server-side
// enforcement on the RPCs themselves still needs confirming independently,
// this is defense-in-depth, not a replacement for that.
function AdminRoute({ children }) {
  const { profile } = useAuth()
  if (!profile?.is_admin) return <Navigate to="/dashboard" replace />
  return children
}

export default function Dashboard() {
  return (
    <div className="flex min-h-screen bg-page-bg">
      <Sidebar />
      {/* pt-14 clears the fixed mobile top bar Sidebar renders below lg;
          lg:pt-0 restores today's desktop layout exactly — moved from md:
          to lg: alongside Sidebar.jsx's own breakpoint fix (2026-08-29,
          see that file's header) so this stays in sync with where the
          sidebar itself actually switches from off-canvas to static.
          pb-24 (2026-08-29 audit fix) clears SupportWidget.jsx's floating
          launcher button (fixed bottom-6 right-6, 56px tall, z-50) —
          every one of the routes below shares this single scroll
          container, so without this the button visually overlapped real
          content on every page (the last card in a list, in particular)
          with nothing reserving space for it. Fixed once here rather than
          in each of the 13 pages. */}
      <main className="flex-1 overflow-auto pt-14 lg:pt-0 pb-24">
        {/* Scoped here, not at the app root (see main.jsx for that one) —
            a scale-readiness audit (2026-08-22) found a single crashing
            dashboard page used to take the whole app down, Sidebar
            included, since only one app-wide boundary existed. This one
            catches a page-level render error without unmounting Sidebar,
            which sits outside it as a sibling — the rest of the app stays
            usable while just this one page shows the error card. */}
        <ErrorBoundary>
          <Suspense fallback={<RoutePageLoader />}>
            <Routes>
              <Route index element={<Overview />} />
              {/* 2026-09-04: Today's Actions merged into the Intelligence
                  Feed. The old path still resolves so bookmarks, the support
                  widget's copy and any link in a sent email land on the real
                  page rather than a blank route. */}
              <Route path="actions" element={<Navigate to="/dashboard/intelligence-feed" replace />} />
              <Route path="intelligence-feed" element={<IntelligenceFeed />} />
              <Route path="candidates" element={<Candidates />} />
              <Route path="meetings" element={<Meetings />} />
              <Route path="tasks" element={<Tasks />} />
              <Route path="companies" element={<Companies />} />
              <Route path="jobs" element={<Jobs />} />
              {/* 2026-09-03: the real build behind mockups/pipeline-v2-mockup.html — one job's full candidate pipeline board. */}
              <Route path="jobs/:jobId/pipeline" element={<JobPipeline />} />
              <Route path="invoices" element={<Invoices />} />
              {/* 2026-09-06: gated inside the component itself (owner-only),
                  not here. The role check needs an async listTeamMembers()
                  call rather than a value already sitting on `profile`, same
                  reasoning as this file's own header comment on AdminRoute. */}
              <Route path="team-performance" element={<TeamPerformance />} />
              <Route path="contacts" element={<Contacts />} />
              <Route path="pipeline" element={<Pipeline />} />
              <Route path="chat" element={<Chat />} />
              <Route path="settings" element={<Settings />} />
              <Route path="billing" element={<Billing />} />
              <Route path="import-linkedin" element={<LinkedInImport embedded />} />
              <Route path="insights" element={<AdminRoute><Insights /></AdminRoute>} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  )
}

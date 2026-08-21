import React, { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from '../components/Sidebar'
import { useAuth } from '../contexts/AuthContext'

const TodaysActions = lazy(() => import('../components/TodaysActions'))
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
const Overview = lazy(() => import('../components/Overview'))
const Billing = lazy(() => import('../components/Billing'))

function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" />
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
      {/* pt-14 clears the fixed mobile top bar Sidebar renders below md;
          md:pt-0 restores today's desktop layout exactly. */}
      <main className="flex-1 overflow-auto pt-14 md:pt-0">
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route index element={<Overview />} />
            <Route path="actions" element={<TodaysActions />} />
            <Route path="intelligence-feed" element={<IntelligenceFeed />} />
            <Route path="candidates" element={<Candidates />} />
            <Route path="meetings" element={<Meetings />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="companies" element={<Companies />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="contacts" element={<Contacts />} />
            <Route path="pipeline" element={<Pipeline />} />
            <Route path="chat" element={<Chat />} />
            <Route path="settings" element={<Settings />} />
            <Route path="billing" element={<Billing />} />
            <Route path="import-linkedin" element={<LinkedInImport embedded />} />
            <Route path="insights" element={<AdminRoute><Insights /></AdminRoute>} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}

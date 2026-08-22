import React, { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import PageLoader from './components/PageLoader'

// A scale-readiness audit (2026-08-22) found these six top-level routes
// were all statically imported here, shipping in the main bundle regardless
// of which route a visitor actually hit — a returning logged-in user never
// sees Login/Onboarding/Terms/Privacy, but paid for their JS anyway. Worse,
// LinkedInImport was ALSO dynamically imported from Dashboard.jsx, which
// Vite can't split into its own chunk while this file statically imported
// the same module — confirmed by the build's own warning. Converting all
// six to React.lazy() fixes both: a smaller main chunk, and LinkedInImport
// finally gets a real chunk of its own.
const Login = lazy(() => import('./pages/Login'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const LinkedInImport = lazy(() => import('./pages/LinkedInImport'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const ResetPassword = lazy(() => import('./pages/ResetPassword'))
const Terms = lazy(() => import('./pages/Terms'))
const Privacy = lazy(() => import('./pages/Privacy'))
const SupportWidget = lazy(() => import('./components/SupportWidget'))

function ProtectedRoute({ children }) {
  const { user, profile, loading } = useAuth()

  if (loading) return <PageLoader label="Loading Annie..." />

  if (!user) return <Navigate to="/login" replace />
  if (!profile?.onboarding_completed) return <Navigate to="/onboarding" replace />
  if (!profile?.linkedin_import_completed) return <Navigate to="/import" replace />
  return children
}

function OnboardingRoute({ children }) {
  const { user, profile, loading } = useAuth()

  if (loading) return <PageLoader />

  if (!user) return <Navigate to="/login" replace />
  if (profile?.onboarding_completed) return <Navigate to="/dashboard" replace />
  return children
}

function ImportRoute({ children }) {
  const { user, profile, loading } = useAuth()

  if (loading) return <PageLoader />

  if (!user) return <Navigate to="/login" replace />
  if (!profile?.onboarding_completed) return <Navigate to="/onboarding" replace />
  if (profile?.linkedin_import_completed) return <Navigate to="/dashboard" replace />
  return children
}

function routeForUser(user, profile) {
  if (!user) return '/login'
  if (!profile?.onboarding_completed) return '/onboarding'
  if (!profile?.linkedin_import_completed) return '/import'
  return '/dashboard'
}

function AppRoutes() {
  const { user, profile, loading } = useAuth()

  if (loading) return <PageLoader />

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={user ? <Navigate to={routeForUser(user, profile)} replace /> : <Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/onboarding" element={<OnboardingRoute><Onboarding /></OnboardingRoute>} />
        <Route path="/import" element={<ImportRoute><LinkedInImport /></ImportRoute>} />
        <Route path="/dashboard/*" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/" element={<Navigate to={routeForUser(user, profile)} replace />} />
      </Routes>
      {user && <SupportWidget />}
    </Suspense>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}

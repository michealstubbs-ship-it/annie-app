import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import Login from './pages/Login'
import Onboarding from './pages/Onboarding'
import Dashboard from './pages/Dashboard'

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-page-bg">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-500 font-medium">Loading Annie...</p>
        </div>
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  return children
}

function OnboardingRoute({ children }) {
  const { user, profile, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-page-bg">
        <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  if (profile?.onboarding_completed) return <Navigate to="/dashboard" replace />
  return children
}

function AppRoutes() {
  const { user, profile, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-page-bg">
        <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={profile?.onboarding_completed ? '/dashboard' : '/onboarding'} replace /> : <Login />} />
      <Route path="/onboarding" element={<OnboardingRoute><Onboarding /></OnboardingRoute>} />
      <Route path="/dashboard/*" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
      <Route path="/" element={<Navigate to={user ? (profile?.onboarding_completed ? '/dashboard' : '/onboarding') : '/login'} replace />} />
    </Routes>
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

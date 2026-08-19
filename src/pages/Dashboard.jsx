import React, { Suspense, lazy } from 'react'
import { Routes, Route } from 'react-router-dom'
import Sidebar from '../components/Sidebar'

const TodaysActions = lazy(() => import('../components/TodaysActions'))
const Contacts = lazy(() => import('../components/Contacts'))
const Pipeline = lazy(() => import('../components/Pipeline'))
const Signals = lazy(() => import('../components/Signals'))
const Chat = lazy(() => import('../components/Chat'))
const Settings = lazy(() => import('../components/Settings'))
const LinkedInImport = lazy(() => import('./LinkedInImport'))

function PageLoader() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

export default function Dashboard() {
  return (
    <div className="flex min-h-screen bg-page-bg">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route index element={<TodaysActions />} />
            <Route path="contacts" element={<Contacts />} />
            <Route path="pipeline" element={<Pipeline />} />
            <Route path="signals" element={<Signals />} />
            <Route path="chat" element={<Chat />} />
            <Route path="settings" element={<Settings />} />
            <Route path="import-linkedin" element={<LinkedInImport embedded />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}

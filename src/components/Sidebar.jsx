import React from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { IconHome, IconZap, IconRadio, IconUsers, IconBuilding, IconTrendingUp, IconCalendar, IconCheckSquare, IconMessageCircle, IconBriefcase, IconUser, IconSettings } from './icons'

// "Signals" was retired as a standalone page — the same BD-trigger data now
// lives on the Intelligence Feed, so this nav no longer links anywhere dead.
const NAV = [
  { to: '/dashboard', label: 'Overview', Icon: IconHome, exact: true },
  { to: '/dashboard/actions', label: "Today's Actions", Icon: IconZap },
  { to: '/dashboard/intelligence-feed', label: 'Intelligence Feed', Icon: IconRadio },
  { to: '/dashboard/contacts', label: 'Contacts', Icon: IconUsers },
  { to: '/dashboard/companies', label: 'Companies', Icon: IconBuilding },
  { to: '/dashboard/pipeline', label: 'BD Pipeline', Icon: IconTrendingUp },
  { to: '/dashboard/meetings', label: 'Meetings', Icon: IconCalendar },
  { to: '/dashboard/tasks', label: 'Tasks', Icon: IconCheckSquare },
  { to: '/dashboard/chat', label: 'Ask Annie', Icon: IconMessageCircle },
]

const RECRUITMENT_NAV = [
  { to: '/dashboard/jobs', label: 'Jobs & Mandates', Icon: IconBriefcase },
  { to: '/dashboard/candidates', label: 'Candidates', Icon: IconUser },
]

const SETTINGS_NAV = [
  { to: '/dashboard/settings', label: 'Settings', Icon: IconSettings },
]

export default function Sidebar() {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  return (
    <aside className="w-60 bg-navy min-h-screen flex flex-col flex-shrink-0">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-white/10">
        <div className="flex items-center gap-2.5">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="8" fill="#c9a84c"/>
            <path d="M18 3L29 33H25L18 13L11 33H7L18 3Z" fill="#0d1b3e"/>
            <rect x="10" y="22" width="16" height="3.2" rx="1.6" fill="#c9a84c"/>
          </svg>
          <div>
            <div className="text-white font-bold text-lg leading-none">annie</div>
            <div className="text-gold text-[10px] font-semibold tracking-widest uppercase">BD Intelligence</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {profile?.is_admin && (
          <NavLink
            to="/dashboard/insights"
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all mb-1
              ${isActive ? 'bg-gold text-navy' : 'text-white/70 hover:text-white hover:bg-white/10'}`
            }
          >
            <IconTrendingUp className="w-[17px] h-[17px]" />
            Insights
          </NavLink>
        )}
        {NAV.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all
              ${isActive ? 'bg-gold text-navy' : 'text-white/70 hover:text-white hover:bg-white/10'}`
            }
          >
            <item.Icon className="w-[17px] h-[17px] flex-shrink-0" />
            {item.label}
          </NavLink>
        ))}

        <div className="text-[10px] font-bold text-white/30 uppercase tracking-wider px-3 pt-4 pb-1">Recruitment</div>
        {RECRUITMENT_NAV.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all
              ${isActive ? 'bg-gold text-navy' : 'text-white/70 hover:text-white hover:bg-white/10'}`
            }
          >
            <item.Icon className="w-[17px] h-[17px] flex-shrink-0" />
            {item.label}
          </NavLink>
        ))}

        {SETTINGS_NAV.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all mt-4
              ${isActive ? 'bg-gold text-navy' : 'text-white/70 hover:text-white hover:bg-white/10'}`
            }
          >
            <item.Icon className="w-[17px] h-[17px] flex-shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* User */}
      <div className="px-4 py-4 border-t border-white/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full bg-gold flex items-center justify-center text-navy font-bold text-sm">
            {profile?.full_name?.[0] || '?'}
          </div>
          <div className="min-w-0">
            <div className="text-white text-sm font-semibold truncate">{profile?.full_name || 'User'}</div>
            <div className="text-white/50 text-xs truncate">{profile?.firm_name || ''}</div>
          </div>
        </div>
        <button onClick={handleSignOut} className="text-white/50 hover:text-white text-xs font-medium transition-colors">
          Sign out
        </button>
      </div>
    </aside>
  )
}

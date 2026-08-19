import React from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

const NAV = [
  { to: '/dashboard', label: "Today's Actions", icon: '⚡', exact: true },
  { to: '/dashboard/contacts', label: 'Contacts', icon: '👥' },
  { to: '/dashboard/pipeline', label: 'BD Pipeline', icon: '📈' },
  { to: '/dashboard/signals', label: 'Signals', icon: '🔔' },
  { to: '/dashboard/chat', label: 'Ask Annie', icon: '💬' },
  { to: '/dashboard/settings', label: 'Settings', icon: '⚙️' },
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
          <svg width="36" height="36" viewBox="0 0 68 68" fill="none">
            <rect width="68" height="68" rx="16" fill="#c9a84c"/>
            <path d="M34 14 L50 54 H44 L40 44 H28 L24 54 H18 L34 14Z M34 24 L30 38 H38 L34 24Z" fill="#0d1b3e"/>
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
            <span className="text-base">📊</span>
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
            <span className="text-base">{item.icon}</span>
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

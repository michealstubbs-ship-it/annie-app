import React, { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { IconHome, IconZap, IconRadio, IconUsers, IconBuilding, IconTrendingUp, IconCalendar, IconCheckSquare, IconMessageCircle, IconBriefcase, IconUser, IconSettings, IconCreditCard, IconReceipt, IconBarChart } from './icons'

// "Signals" was retired as a standalone page — the same BD-trigger data now
// lives on the Intelligence Feed, so this nav no longer links anywhere dead.
//
// 2026-09-04: "Today's Actions" retired the same way, into the same place.
// The two pages read the same table and were divided only by an invisible
// contact gate that hid 338 of 446 BD signals over seven days. One stream
// now, under the name customers already know. /dashboard/actions still
// resolves — it redirects (see Dashboard.jsx) so bookmarks and old links
// land somewhere real rather than on a blank route.
const NAV = [
  { to: '/dashboard', label: 'Overview', Icon: IconHome, exact: true },
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
  { to: '/dashboard/invoices', label: 'Invoices', Icon: IconReceipt },
  // 2026-09-06, Michael: per-recruiter pipeline, meetings, terms signed and
  // revenue, for a manager reviewing the desk. Route itself gates on team
  // role (owner-only), same reasoning as Billing.jsx's own myRole check.
  // This link is shown to everyone since a member with no permission just
  // sees a friendly explanation, not a dead end with no way to understand
  // why, matching how Insights already handles its own admin-only gate.
  { to: '/dashboard/team-performance', label: 'Team Performance', Icon: IconBarChart },
]

const SETTINGS_NAV = [
  { to: '/dashboard/billing', label: 'Billing', Icon: IconCreditCard },
  { to: '/dashboard/settings', label: 'Settings', Icon: IconSettings },
]

export default function Sidebar() {
  const { profile, signOut } = useAuth()
  const navigate = useNavigate()
  // Below lg, the sidebar is off-canvas by default and slides in over the
  // page as an overlay. At lg+ this state is never read (the aside is
  // forced visible via lg:translate-x-0 / lg:static), so desktop behaviour
  // is unchanged.
  //
  // 2026-08-29 audit fix: this was md: (768px) — which is iPad portrait's
  // OWN width, and Tailwind's md: breakpoint applies at min-width:768px,
  // inclusive. So at exactly that width the "desktop" rules won this
  // boundary, not the mobile ones: the sidebar rendered fixed and static,
  // taking its full 240px out of the viewport with no way to collapse it,
  // on the one device this was supposed to already handle. Content itself
  // (tables, grids, fixed-width elements throughout the CRM) has no
  // responsive treatment of its own below roughly 1024px regardless of
  // this fix — that's a separate, much larger piece of work, flagged
  // separately rather than silently taken on here — but moving this
  // specific boundary to lg: (1024px) at least gives that content its full
  // viewport width on a tablet instead of losing 240px of it to a sidebar
  // that was never meant to be static there, and matches the one width
  // band confirmed to render correctly today: 1024px and up.
  const [open, setOpen] = useState(false)

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  const linkClass = ({ isActive }) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all
    ${isActive ? 'bg-gold text-navy' : 'text-white/70 hover:text-white hover:bg-white/10'}`

  return (
    <>
      {/* Mobile top bar: only rendered below md, gives brand presence and a
          way to open the sidebar once it's off-canvas by default. */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-30 h-14 bg-navy border-b border-white/10 flex items-center gap-3 px-4">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="text-white/80 hover:text-white -ml-1 p-1"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="flex items-center gap-2">
          <svg width="22" height="22" viewBox="0 0 36 36" fill="none">
            <rect width="36" height="36" rx="8" fill="#c9a84c"/>
            <path d="M18 3L29 33H25L18 13L11 33H7L18 3Z" fill="#0d1b3e"/>
            <rect x="10" y="22" width="16" height="3.2" rx="1.6" fill="#c9a84c"/>
          </svg>
          <span className="text-white font-bold text-base leading-none">annie</span>
        </div>
      </div>

      {/* Overlay: mobile only, shown while the sidebar is open, tap to close
          (same overlay-click-to-close pattern as Modal.jsx). */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 bg-black/40 z-40"
          onClick={() => setOpen(false)}
        />
      )}

      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-60 bg-navy min-h-screen flex flex-col flex-shrink-0
        transform transition-transform duration-300 ease-in-out lg:translate-x-0
        ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Logo */}
        <div className="px-5 py-6 border-b border-white/10 flex items-center justify-between">
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
          <button
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="lg:hidden text-white/60 hover:text-white p-1"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {profile?.is_admin && (
            <NavLink
              to="/dashboard/insights"
              onClick={() => setOpen(false)}
              className={({ isActive }) => `${linkClass({ isActive })} mb-1`}
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
              onClick={() => setOpen(false)}
              className={linkClass}
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
              onClick={() => setOpen(false)}
              className={linkClass}
            >
              <item.Icon className="w-[17px] h-[17px] flex-shrink-0" />
              {item.label}
            </NavLink>
          ))}

          {SETTINGS_NAV.map((item, i) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className={({ isActive }) => `${linkClass({ isActive })} ${i === 0 ? 'mt-4' : ''}`}
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
    </>
  )
}

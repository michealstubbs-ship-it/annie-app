// Annie Overview — the real brain of the business, per Michael's own
// framing (2026-09-02): finance, product/engineering, customers, and who
// needs a human right now, all in one place. Five tabs, each loading its
// OWN data independently (see adminDashboard.js's per-tab loaders' own
// header) — the previous single-file version fetched all nine of its data
// sources in one Promise.all and blanked the entire page behind one error
// banner whenever any single RPC broke (get_admin_opex's bigint-cast bug
// did exactly this in production). Splitting by tab means a broken query
// in one area never takes down the rest of the dashboard.
import React, { useState } from 'react'
import AdminOverviewTab from './admin/AdminOverviewTab'
import AdminFinanceTab from './admin/AdminFinanceTab'
import AdminCustomersTab from './admin/AdminCustomersTab'
import AdminProductTab from './admin/AdminProductTab'
import AdminEscalationsTab from './admin/AdminEscalationsTab'
import { getAdminEscalationSummary } from '../lib/data/adminDashboard'

export const ADMIN_OVERVIEW_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'finance', label: 'Finance' },
  { key: 'customers', label: 'Customers' },
  { key: 'product', label: 'Product & Engineering' },
  { key: 'escalations', label: 'Client Escalations' },
]

export default function AdminOverview({ onOpenErrors }) {
  const [tab, setTab] = useState('overview')
  const [openEscalations, setOpenEscalations] = useState(null)

  // Just enough of a peek to badge the Client Escalations tab even when
  // it isn't the active one — cheap (one small RPC), and lets Michael see
  // "something needs me" without having to click into the tab first.
  React.useEffect(() => {
    let cancelled = false
    getAdminEscalationSummary().then((s) => { if (!cancelled) setOpenEscalations(s.open_count) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  return (
    <div>
      <div className="flex gap-1 mb-5 border-b border-gray-200 flex-wrap">
        {ADMIN_OVERVIEW_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-[13.5px] font-semibold rounded-t-lg -mb-px border ${
              tab === t.key ? 'bg-white border-gray-200 border-b-white text-navy' : 'border-transparent text-gray-500 hover:text-navy'
            }`}
          >
            {t.label}
            {t.key === 'escalations' && openEscalations > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-status-critical text-white text-[10px] font-bold">{openEscalations}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'overview' && <AdminOverviewTab />}
      {tab === 'finance' && <AdminFinanceTab />}
      {tab === 'customers' && <AdminCustomersTab />}
      {tab === 'product' && <AdminProductTab onOpenErrors={onOpenErrors} />}
      {tab === 'escalations' && <AdminEscalationsTab />}
    </div>
  )
}

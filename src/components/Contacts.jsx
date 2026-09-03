import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { listContacts, deleteContact } from '../lib/data/contacts'
import { listTeamMembers } from '../lib/data/teamMembers'
import { CONTACT_STATUSES, CONTACT_STATUS_LABELS, searchContacts, filterContactsByStatus, sortContacts, groupContactsByStatus } from '../lib/contactsView'
import InfoTip from './InfoTip'
import ContactFormModal from './ContactFormModal'
import ContactDetailModal from './ContactDetailModal'
import ConfirmDialog from './ConfirmDialog'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import OwnerFilter from './OwnerFilter'

const STATUS_COLORS = {
  hot: 'bg-red-100 text-red-700',
  warm: 'bg-amber-100 text-amber-700',
  cold: 'bg-blue-100 text-blue-700',
  client: 'bg-green-100 text-green-700',
  inactive: 'bg-gray-100 text-gray-500',
}

// 2026-08-29 audit fix, flagged directly: this used to be one flat table in
// whatever order the database returned, with only a free-text search box —
// "a big list of names all in one." Status filter chips, sortable columns,
// and a grouped-by-status view (shown when no single status is picked) are
// new; the filtering/sorting/grouping logic itself lives in
// lib/contactsView.js so it's unit-tested rather than only reachable
// through this render.
const COLUMNS = [
  { label: 'Name', key: 'name' },
  { label: 'Company', key: 'company' },
  { label: 'Title', key: 'title' },
  { label: 'Status', key: 'status' },
  { label: 'Actions', key: null },
]

export default function Contacts() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  const [showModal, setShowModal] = useState(false)
  const [editContact, setEditContact] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [listError, setListError] = useState('')
  // 2026-09-01: click-to-expand — clicking a contact opens this detail view
  // (notes log + follow-up) instead of Edit being the only way in.
  const [detailContactId, setDetailContactId] = useState(null)
  // 2026-09-03, Michael: "a drop down to that specific license with
  // everyone on the license so that you can always see who added the
  // contact" — same teamMembers/ownerFilter pattern as Candidates.jsx.
  const [teamMembers, setTeamMembers] = useState([])
  const [ownerFilter, setOwnerFilter] = useState('all')

  useEffect(() => { loadContacts() }, [user])
  useEffect(() => { if (location.state?.autoOpenAdd) openAdd() }, [location.state])

  async function loadContacts() {
    setLoading(true)
    setListError('')
    // 2026-08-24 Task 2: routed through lib/data/contacts.js (previously
    // duplicated inline here) so this table's query shape lives in exactly
    // one place.
    // 2026-08-26 audit fix: listContacts now throws on a real Supabase
    // error instead of quietly returning [] — previously that looked
    // identical to "you have no contacts yet".
    try {
      const [c, tm] = await Promise.all([listContacts(user.id), listTeamMembers()])
      setContacts(c)
      setTeamMembers(tm)
    } catch (err) {
      setListError(err.message || 'Could not load your contacts. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  function openAdd() { setEditContact(null); setShowModal(true) }
  function openEdit(c) { setEditContact(c); setShowModal(true) }

  async function del(id) {
    setListError('')
    const { error: err } = await deleteContact(id)
    if (err) return setListError('Could not delete contact: ' + err.message)
    setContacts(prev => prev.filter(c => c.id !== id))
  }

  function toggleSort(key) {
    if (!key) return
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const searched = useMemo(() => searchContacts(contacts, search), [contacts, search])
  const ownerFiltered = useMemo(
    () => (ownerFilter === 'all' ? searched : searched.filter(c => c.owner_id === ownerFilter)),
    [searched, ownerFilter]
  )
  const statusCounts = useMemo(() => {
    const counts = {}
    for (const s of CONTACT_STATUSES) counts[s] = ownerFiltered.filter(c => c.status === s).length
    return counts
  }, [ownerFiltered])
  const statusFiltered = useMemo(() => filterContactsByStatus(ownerFiltered, statusFilter), [ownerFiltered, statusFilter])
  const sorted = useMemo(() => sortContacts(statusFiltered, sortKey, sortDir), [statusFiltered, sortKey, sortDir])
  const groups = statusFilter === 'all' ? groupContactsByStatus(sorted) : null

  function renderRow(c) {
    return (
      <tr key={c.id} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => setDetailContactId(c.id)}>
        <td className="px-4 py-3">
          <div className="font-semibold text-navy text-sm hover:underline">{c.name}</div>
          {c.email && <div className="text-xs text-gray-400">{c.email}</div>}
        </td>
        <td className="px-4 py-3 text-sm text-gray-600">{c.company || '-'}</td>
        <td className="px-4 py-3 text-sm text-gray-600">{c.title || '-'}</td>
        <td className="px-4 py-3">
          <span className={`text-xs font-semibold px-2 py-1 rounded-full ${STATUS_COLORS[c.status] || 'bg-gray-100 text-gray-500'}`}>
            {c.status}
          </span>
        </td>
        <td className="px-4 py-3">
          {/* 2026-08-29 audit fix: Delete sat one word from Edit in
              the same plain-text row, styled a faint neutral-ish
              red that undersold how irreversible it is — same
              mis-click-adjacency issue just fixed on Invoices.jsx,
              applied here for consistency across the CRM. */}
          <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
            <button onClick={() => openEdit(c)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
            <div className="pl-2 ml-1 border-l border-gray-200">
              <button onClick={() => setConfirmDeleteId(c.id)} className="text-xs text-red-500 font-semibold hover:underline">Delete</button>
            </div>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            Contacts
            <InfoTip text="Hot means at one of your target companies, warm means in your focus sectors, cold means low priority for now. Annie monitors hot and warm contacts for signals." />
          </h1>
          <p className="text-gray-500 mt-1">{contacts.length} contacts in your network</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => navigate('/dashboard/import-linkedin')} className="btn-ghost">Import from LinkedIn</button>
          <button onClick={openAdd} className="btn-primary">+ Add Contact</button>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <input className="input max-w-sm" placeholder="Search contacts..." value={search} onChange={e => setSearch(e.target.value)} />
        <OwnerFilter value={ownerFilter} onChange={setOwnerFilter} teamMembers={teamMembers} />
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setStatusFilter('all')}
            className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors ${statusFilter === 'all' ? 'bg-navy text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
          >
            All <span className="opacity-70">({ownerFiltered.length})</span>
          </button>
          {CONTACT_STATUSES.map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors ${statusFilter === s ? STATUS_COLORS[s] : 'bg-gray-50 text-gray-400 hover:bg-gray-100'}`}
            >
              {CONTACT_STATUS_LABELS[s]} <span className="opacity-70">({statusCounts[s] || 0})</span>
            </button>
          ))}
        </div>
      </div>

      <ErrorBanner>{listError}</ErrorBanner>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner />
        </div>
      ) : contacts.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">👥</div>
          <h3 className="font-bold text-navy mb-1">No contacts yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Import your LinkedIn connections to bring in your whole network at once, or add contacts one at a time.</p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => navigate('/dashboard/import-linkedin')} className="btn-ghost">Import from LinkedIn</button>
            <button onClick={openAdd} className="btn-primary">Add a contact</button>
          </div>
        </div>
      ) : searched.length === 0 ? (
        // 2026-08-26 audit fix: this used to be the same "No contacts yet"
        // empty state as an actually-empty list (condition was just
        // `filtered.length === 0`, true either way) — a user with hundreds
        // of real contacts and a typo'd search saw "add your first contact"
        // and the import/add buttons, which was actively misleading.
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-bold text-navy mb-1">No contacts match "{search}"</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different name, company, title, or email — or clear the search to see all {contacts.length} contacts.</p>
          <button onClick={() => setSearch('')} className="btn-ghost">Clear search</button>
        </div>
      ) : ownerFiltered.length === 0 ? (
        // Owner filter narrowed a non-empty search down to nobody — its own
        // empty state so it doesn't get misread as "no contacts at this
        // status", same precedent as Candidates.jsx's equivalent.
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🗂️</div>
          <h3 className="font-bold text-navy mb-1">No contacts owned by {teamMembers.find(m => m.id === ownerFilter)?.name || 'that team member'}{search ? ` matching "${search}"` : ''}</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different team member, or clear this filter to see all {searched.length} contact{searched.length === 1 ? '' : 's'}{search ? ' matching your search' : ''}.</p>
          <button onClick={() => setOwnerFilter('all')} className="btn-ghost">Show everyone's contacts</button>
        </div>
      ) : statusFiltered.length === 0 ? (
        // 2026-08-29 audit fix: a status filter with zero matches used to be
        // impossible (there was no status filter) — now that there is one,
        // this needs its own empty state rather than falling through to an
        // empty table.
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🗂️</div>
          <h3 className="font-bold text-navy mb-1">No {CONTACT_STATUS_LABELS[statusFilter]} contacts{search ? ` matching "${search}"` : ''}</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different status, or clear this filter to see all {ownerFiltered.length} contact{ownerFiltered.length === 1 ? '' : 's'}{search ? ' matching your search' : ''}.</p>
          <button onClick={() => setStatusFilter('all')} className="btn-ghost">Show all statuses</button>
        </div>
      ) : (
        // 2026-08-29 audit fix, found alongside the sidebar breakpoint bug:
        // this card's overflow-hidden exists to clip the table's flat edges
        // into the card's own rounded corners — but with nothing else
        // providing horizontal scroll, that same overflow-hidden also just
        // silently CLIPPED whichever columns didn't fit at a narrow width,
        // Actions (Edit/Delete) included, with no way to reach them at all
        // rather than an awkward-but-usable scroll. This is the only
        // <table> in the app — every other CRM list already uses reflowing
        // cards instead — so it's the one place that needed this. The inner
        // div now owns the scrolling; the outer card keeps the rounded-
        // corner clip it was there for.
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {COLUMNS.map(col => (
                  <th key={col.label} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                    {col.key ? (
                      <button onClick={() => toggleSort(col.key)} className="flex items-center gap-1 hover:text-navy transition-colors">
                        {col.label}
                        {sortKey === col.key && <span className="text-gold-ink normal-case">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                      </button>
                    ) : col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {groups
                ? groups.flatMap(g => [
                    <tr key={`group-${g.status}`} className="bg-gray-50/60">
                      <td colSpan={COLUMNS.length} className="px-4 py-2">
                        <span className={`inline-flex items-center text-xs font-bold px-2 py-1 rounded-full uppercase tracking-wider ${STATUS_COLORS[g.status] || 'bg-gray-100 text-gray-500'}`}>
                          {g.label}
                        </span>
                        <span className="ml-2 text-xs text-gray-400">{g.contacts.length} contact{g.contacts.length === 1 ? '' : 's'}</span>
                      </td>
                    </tr>,
                    ...g.contacts.map(renderRow),
                  ])
                : sorted.map(renderRow)}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <ContactFormModal
        open={showModal}
        editContact={editContact}
        onClose={() => setShowModal(false)}
        onSaved={() => loadContacts()}
      />

      <ContactDetailModal
        contactId={detailContactId}
        open={!!detailContactId}
        onClose={() => setDetailContactId(null)}
        onChanged={() => loadContacts()}
      />

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => del(confirmDeleteId)}
        title="Delete this contact?"
        message="This can't be undone."
        confirmLabel="Delete"
      />
    </div>
  )
}

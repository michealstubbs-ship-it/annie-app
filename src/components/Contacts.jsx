import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { listContacts, deleteContact } from '../lib/data/contacts'
import InfoTip from './InfoTip'
import ContactFormModal from './ContactFormModal'
import ConfirmDialog from './ConfirmDialog'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'

const STATUS_COLORS = {
  hot: 'bg-red-100 text-red-700',
  warm: 'bg-amber-100 text-amber-700',
  cold: 'bg-blue-100 text-blue-700',
  client: 'bg-green-100 text-green-700',
  inactive: 'bg-gray-100 text-gray-500',
}

export default function Contacts() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editContact, setEditContact] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [listError, setListError] = useState('')

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
      setContacts(await listContacts(user.id))
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

  const filtered = contacts.filter(c =>
    [c.name, c.company, c.title, c.email].some(f => f?.toLowerCase().includes(search.toLowerCase()))
  )

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

      <input className="input max-w-sm mb-6" placeholder="Search contacts..." value={search} onChange={e => setSearch(e.target.value)} />

      <ErrorBanner>{listError}</ErrorBanner>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner />
        </div>
      ) : filtered.length === 0 && contacts.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">👥</div>
          <h3 className="font-bold text-navy mb-1">No contacts yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Import your LinkedIn connections to bring in your whole network at once, or add contacts one at a time.</p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => navigate('/dashboard/import-linkedin')} className="btn-ghost">Import from LinkedIn</button>
            <button onClick={openAdd} className="btn-primary">Add a contact</button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
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
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {['Name', 'Company', 'Title', 'Status', 'Actions'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map(c => (
                <tr key={c.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-navy text-sm">{c.name}</div>
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
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(c)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
                      <div className="pl-2 ml-1 border-l border-gray-200">
                        <button onClick={() => setConfirmDeleteId(c.id)} className="text-xs text-red-500 font-semibold hover:underline">Delete</button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ContactFormModal
        open={showModal}
        editContact={editContact}
        onClose={() => setShowModal(false)}
        onSaved={() => loadContacts()}
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

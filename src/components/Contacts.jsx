import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import InfoTip from './InfoTip'
import ContactFormModal from './ContactFormModal'

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

  useEffect(() => { loadContacts() }, [user])
  useEffect(() => { if (location.state?.autoOpenAdd) openAdd() }, [location.state])

  async function loadContacts() {
    setLoading(true)
    const { data } = await supabase.from('contacts').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
    setContacts(data || [])
    setLoading(false)
  }

  function openAdd() { setEditContact(null); setShowModal(true) }
  function openEdit(c) { setEditContact(c); setShowModal(true) }

  async function del(id) {
    if (!confirm('Delete this contact?')) return
    await supabase.from('contacts').delete().eq('id', id)
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

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">👥</div>
          <h3 className="font-bold text-navy mb-1">No contacts yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Import your LinkedIn connections to bring in your whole network at once, or add contacts one at a time.</p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => navigate('/dashboard/import-linkedin')} className="btn-ghost">Import from LinkedIn</button>
            <button onClick={openAdd} className="btn-primary">Add a contact</button>
          </div>
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
                    <div className="flex gap-2">
                      <button onClick={() => openEdit(c)} className="text-xs text-gold font-semibold hover:underline">Edit</button>
                      <button onClick={() => del(c.id)} className="text-xs text-red-400 font-semibold hover:underline">Delete</button>
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
    </div>
  )
}

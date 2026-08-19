import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

const STATUSES = ['hot', 'warm', 'cold', 'client', 'inactive']
const STATUS_COLORS = {
  hot: 'bg-red-100 text-red-700',
  warm: 'bg-amber-100 text-amber-700',
  cold: 'bg-blue-100 text-blue-700',
  client: 'bg-green-100 text-green-700',
  inactive: 'bg-gray-100 text-gray-500',
}

const EMPTY = { name: '', email: '', phone: '', company: '', title: '', linkedin_url: '', status: 'warm', notes: '' }

export default function Contacts() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { loadContacts() }, [user])

  async function loadContacts() {
    setLoading(true)
    const { data } = await supabase.from('contacts').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
    setContacts(data || [])
    setLoading(false)
  }

  function openAdd() { setForm(EMPTY); setEditId(null); setShowModal(true); setError('') }
  function openEdit(c) { setForm({ name: c.name, email: c.email || '', phone: c.phone || '', company: c.company || '', title: c.title || '', linkedin_url: c.linkedin_url || '', status: c.status || 'warm', notes: c.notes || '' }); setEditId(c.id); setShowModal(true); setError('') }

  async function save() {
    if (!form.name.trim()) return setError('Name is required')
    setSaving(true)
    setError('')
    try {
      if (editId) {
        await supabase.from('contacts').update({ ...form, updated_at: new Date().toISOString() }).eq('id', editId)
      } else {
        await supabase.from('contacts').insert({ ...form, user_id: user.id })
      }
      await loadContacts()
      setShowModal(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

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
          <h1 className="text-3xl font-bold text-navy">Contacts</h1>
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
          <p className="text-gray-500 text-sm mb-4">Add your first contact to start tracking relationships.</p>
          <button onClick={openAdd} className="btn-primary">Add your first contact</button>
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

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-navy mb-4">{editId ? 'Edit Contact' : 'Add Contact'}</h2>
            {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{error}</div>}
            <div className="space-y-3">
              {[['name','Name *','text'],['email','Email','email'],['phone','Phone','tel'],['company','Company','text'],['title','Job Title','text'],['linkedin_url','LinkedIn URL','url']].map(([field, label, type]) => (
                <div key={field}>
                  <label className="label">{label}</label>
                  <input className="input" type={type} value={form[field]} onChange={e => setForm(p => ({ ...p, [field]: e.target.value }))} />
                </div>
              ))}
              <div>
                <label className="label">Status</label>
                <select className="input" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea className="input resize-none" rows={3} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-3 justify-end mt-5">
              <button onClick={() => setShowModal(false)} className="btn-ghost">Cancel</button>
              <button onClick={save} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

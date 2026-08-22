import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import CompanySelect from './CompanySelect'
import Modal from './Modal'
import ErrorBanner from './ErrorBanner'

const STATUSES = ['hot', 'warm', 'cold', 'client', 'inactive']
const EMPTY = { name: '', email: '', phone: '', title: '', linkedin_url: '', status: 'warm', notes: '', company_id: '', company: '' }

// Shared add/edit contact form, used both from the Contacts page and from a
// Company's detail view. When lockedCompanyId is passed, the company field is
// fixed to that company instead of offering a picker, so a contact added from
// inside a company can never end up attached to a different or duplicate one.
export default function ContactFormModal({ open, editContact, lockedCompanyId, lockedCompanyName, onClose, onSaved }) {
  const { user } = useAuth()
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    if (editContact) {
      setForm({
        name: editContact.name || '', email: editContact.email || '', phone: editContact.phone || '',
        title: editContact.title || '', linkedin_url: editContact.linkedin_url || '', status: editContact.status || 'warm',
        notes: editContact.notes || '',
        company_id: editContact.company_id || lockedCompanyId || '',
        company: editContact.company || lockedCompanyName || '',
      })
    } else {
      setForm({ ...EMPTY, company_id: lockedCompanyId || '', company: lockedCompanyName || '' })
    }
    setError('')
  }, [open, editContact, lockedCompanyId, lockedCompanyName])

  async function save(e) {
    e.preventDefault()
    if (!form.name.trim()) return setError('Name is required')
    setSaving(true)
    setError('')
    try {
      const row = {
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        title: form.title.trim() || null,
        linkedin_url: form.linkedin_url.trim() || null,
        status: form.status,
        notes: form.notes.trim() || null,
        company_id: form.company_id || null,
        company: form.company || null,
        updated_at: new Date().toISOString(),
      }
      let result
      if (editContact) {
        const { data, error: err } = await supabase.from('contacts').update(row).eq('id', editContact.id).select().single()
        if (err) throw err
        result = data
      } else {
        const { data, error: err } = await supabase.from('contacts').insert({ ...row, user_id: user.id }).select().single()
        if (err) throw err
        result = data
      }
      onSaved?.(result)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={editContact ? 'Edit Contact' : 'Add Contact'} maxWidth="max-w-lg">
      <ErrorBanner>{error}</ErrorBanner>
      {/* A real <form onSubmit> so the `required`/type="email"/type="url"
          constraints on these fields actually fire — they were previously
          inert because "Save" called save() directly via onClick instead
          of submitting a form. */}
      <form onSubmit={save}>
        <div className="space-y-3">
          <div><label className="label">Name *</label><input className="input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} autoFocus required /></div>
          <div><label className="label">Email</label><input className="input" type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} /></div>
          <div><label className="label">Phone</label><input className="input" type="tel" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} /></div>

          {lockedCompanyId ? (
            <div>
              <label className="label">Company</label>
              <div className="input bg-gray-50 text-gray-600 flex items-center">{lockedCompanyName}</div>
            </div>
          ) : (
            <CompanySelect value={form.company_id} onChange={(id, name) => setForm(p => ({ ...p, company_id: id, company: name }))} />
          )}

          <div><label className="label">Job Title</label><input className="input" value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} /></div>
          <div><label className="label">LinkedIn URL</label><input className="input" type="url" value={form.linkedin_url} onChange={e => setForm(p => ({ ...p, linkedin_url: e.target.value }))} /></div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div><label className="label">Notes</label><textarea className="input resize-none" rows={3} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} /></div>
        </div>
        <div className="flex gap-3 justify-end mt-5">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

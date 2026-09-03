import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { createContact, updateContact, findContactDuplicateByEmail } from '../lib/data/contacts'
import { listTeamMembers, nameForMember } from '../lib/data/teamMembers'
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
  const [teamMembers, setTeamMembers] = useState([])
  // 2026-09-03, Michael: "in case there are any ownerships" — same
  // duplicate-by-email check as Candidates.jsx's save(), for the same
  // reason: a second team member adding a contact someone else already has.
  const [dupWarning, setDupWarning] = useState(null)
  const [dupChecking, setDupChecking] = useState(false)

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
    setDupWarning(null)
    listTeamMembers().then(setTeamMembers).catch(() => setTeamMembers([]))
  }, [open, editContact, lockedCompanyId, lockedCompanyName])

  async function save(e, { skipDupCheck = false } = {}) {
    e?.preventDefault()
    if (!form.name.trim()) return setError('Name is required')

    if (!editContact && form.email.trim() && !skipDupCheck) {
      setDupChecking(true)
      try {
        const dup = await findContactDuplicateByEmail(form.email)
        if (dup) {
          setDupWarning({ id: dup.id, name: dup.name, ownerName: nameForMember(teamMembers, dup.owner_id) })
          return
        }
      } catch {
        // Best-effort — never block a genuine save on a failed dup-check.
      } finally {
        setDupChecking(false)
      }
    }

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
        const { data, error: err } = await updateContact(editContact.id, row)
        if (err) throw err
        result = data
      } else {
        const { data, error: err } = await createContact(row, user.id)
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

      {/* 2026-09-03, Michael: "in case there are any ownerships" — a new
          contact whose email matches one someone else on the team already
          added. Never blocks outright, just makes it a deliberate choice. */}
      {dupWarning && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 flex-wrap">
          <span className="text-sm text-amber-800">
            ⚠️ <b>{dupWarning.name}</b> is already in the CRM with this email{dupWarning.ownerName ? ` (owned by ${dupWarning.ownerName})` : ''}.
          </span>
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={() => setDupWarning(null)} className="text-xs font-semibold text-amber-800 hover:underline px-2">Cancel</button>
            <button type="button" onClick={e => { setDupWarning(null); save(e, { skipDupCheck: true }) }} className="btn-primary text-xs px-3 py-1.5">Save as new anyway</button>
          </div>
        </div>
      )}

      {/* A real <form onSubmit> so the `required`/type="email"/type="url"
          constraints on these fields actually fire — they were previously
          inert because "Save" called save() directly via onClick instead
          of submitting a form. */}
      <form onSubmit={save}>
        <div className="space-y-3">
          <div><label className="label" htmlFor="contact-name">Name *</label><input id="contact-name" className="input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} autoFocus required /></div>
          <div><label className="label" htmlFor="contact-email">Email</label><input id="contact-email" className="input" type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} /></div>
          <div><label className="label" htmlFor="contact-phone">Phone</label><input id="contact-phone" className="input" type="tel" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} /></div>

          {lockedCompanyId ? (
            <div>
              <label className="label">Company</label>
              <div className="input bg-gray-50 text-gray-600 flex items-center">{lockedCompanyName}</div>
            </div>
          ) : (
            <CompanySelect value={form.company_id} onChange={(id, name) => setForm(p => ({ ...p, company_id: id, company: name }))} />
          )}

          <div><label className="label" htmlFor="contact-title">Job Title</label><input id="contact-title" className="input" value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} /></div>
          <div><label className="label" htmlFor="contact-linkedin-url">LinkedIn URL</label><input id="contact-linkedin-url" className="input" type="url" value={form.linkedin_url} onChange={e => setForm(p => ({ ...p, linkedin_url: e.target.value }))} /></div>
          <div>
            <label className="label" htmlFor="contact-status">Status</label>
            <select id="contact-status" className="input" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="contact-notes">Notes</label><textarea id="contact-notes" className="input resize-none" rows={3} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} /></div>
        </div>
        <div className="flex gap-3 justify-end mt-5">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={saving || dupChecking} className="btn-primary">{dupChecking ? 'Checking...' : saving ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  )
}

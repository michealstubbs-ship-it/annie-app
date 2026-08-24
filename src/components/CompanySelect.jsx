import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { normalizeCompanyName } from '../lib/companyMatch'
import ErrorBanner from './ErrorBanner'
import Modal from './Modal'

// Reusable "pick an existing company, or add one" dropdown. Used anywhere a
// company needs to be attached to something (contacts, jobs) so the same
// company never gets created twice under slightly different spellings.
const EMPTY_CO = { name: '', industry: '', location: '', website: '' }

export default function CompanySelect({ value, onChange, required = false, label = 'Company' }) {
  const { user } = useAuth()
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(EMPTY_CO)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => { load() }, [user])

  async function load() {
    if (!user) return
    setLoading(true)
    // 2026-08-24: companies is team-scoped by RLS — no client-side user_id filter on top of it.
    const { data } = await supabase.from('companies').select('id, name, industry').order('name')
    setCompanies(data || [])
    setLoading(false)
  }

  function handleSelect(e) {
    const v = e.target.value
    if (v === '__add__') { setForm(EMPTY_CO); setError(''); setNote(''); setShowAdd(true); return }
    setNote('')
    const co = companies.find(c => c.id === v)
    onChange(v || null, co?.name || '', co?.industry || '')
  }

  async function saveNewCompany() {
    const name = form.name.trim()
    if (!name) return setError('Company name is required')

    // Same company, different spelling ("Acme Ltd" vs "Acme Limited" vs
    // "acme") should never become two records — match against what's
    // already loaded before creating anything.
    const existing = companies.find(c => normalizeCompanyName(c.name) === normalizeCompanyName(name))
    if (existing) {
      onChange(existing.id, existing.name, existing.industry || '')
      setShowAdd(false)
      setNote(`Using existing record for ${existing.name}`)
      return
    }

    setSaving(true)
    setError('')
    try {
      const { data, error: err } = await supabase.from('companies').insert({
        user_id: user.id,
        name,
        industry: form.industry.trim() || null,
        location: form.location.trim() || null,
        website: form.website.trim() || null,
      }).select().single()
      if (err) throw err
      setCompanies(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
      onChange(data.id, data.name, data.industry || '')
      setShowAdd(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      {/* Static ids: CompanySelect only ever has one mounted, visible
          instance at a time (it's only rendered inside JobFormModal /
          ContactFormModal, and those two are never open simultaneously —
          see Companies.jsx's showContactModal/showJobModal gating). Its own
          nested "Add company" modal below is prefixed separately
          (company-select-new-*) so it can never collide with Companies.jsx's
          own Add/Edit Company modal (co-edit-*), which can legitimately be
          mounted at the same time as this component in a stacked-modal
          scenario (Company detail modal -> Edit, plus Add contact -> Add
          new company, both left open). */}
      {label && <label className="label" htmlFor="company-select">{label}{required ? ' *' : ''}</label>}
      <select id="company-select" className="input" value={value || ''} onChange={handleSelect} disabled={loading}>
        <option value="">{loading ? 'Loading companies...' : required ? 'Select a company...' : 'No company'}</option>
        {companies.map(c => <option key={c.id} value={c.id}>{c.name}{c.industry ? ` (${c.industry})` : ''}</option>)}
        <option value="__add__">+ Add new company...</option>
      </select>
      {note && <p className="text-xs text-gray-500 mt-1">{note}</p>}

      {/* 2026-08-24 Task 4: moved off a hand-rolled `fixed inset-0` overlay
          (no role="dialog", no Escape-to-close, no focus trap) onto the
          shared Modal component every other form dialog already uses. */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add company">
        <p className="text-xs text-gray-500 mb-3">This creates a real company record. Everything you attach to it later (contacts, jobs) links back here, instead of typing the name fresh each time.</p>
        <ErrorBanner>{error}</ErrorBanner>
        <div className="space-y-3">
          <div><label className="label" htmlFor="company-select-new-name">Company name *</label><input id="company-select-new-name" className="input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} autoFocus /></div>
          <div><label className="label" htmlFor="company-select-new-industry">Industry</label><input id="company-select-new-industry" className="input" value={form.industry} onChange={e => setForm(p => ({ ...p, industry: e.target.value }))} /></div>
          <div><label className="label" htmlFor="company-select-new-location">Location</label><input id="company-select-new-location" className="input" value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))} /></div>
          <div><label className="label" htmlFor="company-select-new-website">Website</label><input id="company-select-new-website" className="input" value={form.website} onChange={e => setForm(p => ({ ...p, website: e.target.value }))} /></div>
        </div>
        <div className="flex gap-3 justify-end mt-5">
          <button onClick={() => setShowAdd(false)} className="btn-ghost">Cancel</button>
          <button onClick={saveNewCompany} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Add company'}</button>
        </div>
      </Modal>
    </div>
  )
}

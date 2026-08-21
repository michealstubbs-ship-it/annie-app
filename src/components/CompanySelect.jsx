import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { normalizeCompanyName } from '../lib/companyMatch'

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
    const { data } = await supabase.from('companies').select('id, name, industry').eq('user_id', user.id).order('name')
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
      {label && <label className="label">{label}{required ? ' *' : ''}</label>}
      <select className="input" value={value || ''} onChange={handleSelect} disabled={loading}>
        <option value="">{loading ? 'Loading companies...' : required ? 'Select a company...' : 'No company'}</option>
        {companies.map(c => <option key={c.id} value={c.id}>{c.name}{c.industry ? ` (${c.industry})` : ''}</option>)}
        <option value="__add__">+ Add new company...</option>
      </select>
      {note && <p className="text-xs text-gray-500 mt-1">{note}</p>}

      {showAdd && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] px-4" onClick={e => e.stopPropagation()}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-bold text-navy mb-3">Add company</h3>
            <p className="text-xs text-gray-500 mb-3">This creates a real company record. Everything you attach to it later (contacts, jobs) links back here, instead of typing the name fresh each time.</p>
            {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{error}</div>}
            <div className="space-y-3">
              <div><label className="label">Company name *</label><input className="input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} autoFocus /></div>
              <div><label className="label">Industry</label><input className="input" value={form.industry} onChange={e => setForm(p => ({ ...p, industry: e.target.value }))} /></div>
              <div><label className="label">Location</label><input className="input" value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))} /></div>
              <div><label className="label">Website</label><input className="input" value={form.website} onChange={e => setForm(p => ({ ...p, website: e.target.value }))} /></div>
            </div>
            <div className="flex gap-3 justify-end mt-5">
              <button onClick={() => setShowAdd(false)} className="btn-ghost">Cancel</button>
              <button onClick={saveNewCompany} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Add company'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

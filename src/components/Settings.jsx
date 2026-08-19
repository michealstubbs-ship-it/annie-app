import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

export default function Settings() {
  const navigate = useNavigate()
  const { user, profile, refreshProfile } = useAuth()
  const [form, setForm] = useState({ full_name: '', firm_name: '', job_title: '', phone: '' })
  const [onboarding, setOnboarding] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (profile) setForm({ full_name: profile.full_name || '', firm_name: profile.firm_name || '', job_title: profile.job_title || '', phone: profile.phone || '' })
    loadOnboarding()
  }, [profile])

  async function loadOnboarding() {
    const { data } = await supabase.from('onboarding').select('*').eq('user_id', user.id).single()
    setOnboarding(data)
  }

  async function saveProfile() {
    setSaving(true)
    await supabase.from('profiles').update({ ...form, updated_at: new Date().toISOString() }).eq('id', user.id)
    await refreshProfile()
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-navy">Settings</h1>
        <p className="text-gray-500 mt-1">Manage your account and preferences</p>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-lg font-bold text-navy mb-4">Your Profile</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Full name</label><input className="input" value={form.full_name} onChange={e => setForm(p => ({ ...p, full_name: e.target.value }))} /></div>
            <div><label className="label">Job title</label><input className="input" value={form.job_title} onChange={e => setForm(p => ({ ...p, job_title: e.target.value }))} /></div>
          </div>
          <div><label className="label">Firm name</label><input className="input" value={form.firm_name} onChange={e => setForm(p => ({ ...p, firm_name: e.target.value }))} /></div>
          <div><label className="label">Phone</label><input className="input" type="tel" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} /></div>
          <div><label className="label">Email</label><input className="input" value={user?.email || ''} disabled className="input opacity-60 cursor-not-allowed" /></div>
        </div>
        <div className="flex items-center gap-3 mt-5">
          <button onClick={saveProfile} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save changes'}</button>
          {saved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-lg font-bold text-navy mb-1">LinkedIn contacts</h2>
        <p className="text-sm text-gray-500 mb-4">Import or re-import your LinkedIn connections. Annie only adds contacts matching the filters you set.</p>
        <button onClick={() => navigate('/dashboard/import-linkedin')} className="btn-primary">Import LinkedIn contacts</button>
      </div>

      {onboarding && (
        <div className="card p-6">
          <h2 className="text-lg font-bold text-navy mb-4">BD Configuration</h2>
          <div className="space-y-4 text-sm">
            <div><span className="font-semibold text-gray-600">Sectors:</span> <span className="text-gray-700">{onboarding.sectors?.join(', ') || 'Not set'}</span></div>
            <div><span className="font-semibold text-gray-600">Markets:</span> <span className="text-gray-700">{onboarding.locations?.join(', ') || 'Not set'}</span></div>
            <div><span className="font-semibold text-gray-600">Tone:</span> <span className="text-gray-700 capitalize">{onboarding.tone || 'Professional'}</span></div>
          </div>
          <p className="text-xs text-gray-400 mt-4">To update your BD configuration, contact support or re-run the onboarding flow.</p>
        </div>
      )}
    </div>
  )
}

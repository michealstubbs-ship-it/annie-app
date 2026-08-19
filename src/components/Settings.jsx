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

  const [pastedMessages, setPastedMessages] = useState('')
  const [writingStyle, setWritingStyle] = useState('')
  const [analysing, setAnalysing] = useState(false)
  const [styleError, setStyleError] = useState('')
  const [styleSaving, setStyleSaving] = useState(false)
  const [styleSaved, setStyleSaved] = useState(false)

  useEffect(() => {
    if (profile) setForm({ full_name: profile.full_name || '', firm_name: profile.firm_name || '', job_title: profile.job_title || '', phone: profile.phone || '' })
    loadOnboarding()
  }, [profile])

  async function loadOnboarding() {
    const { data } = await supabase.from('onboarding').select('*').eq('user_id', user.id).single()
    setOnboarding(data)
    setWritingStyle(data?.writing_style || '')
  }

  async function saveProfile() {
    setSaving(true)
    await supabase.from('profiles').update({ ...form, updated_at: new Date().toISOString() }).eq('id', user.id)
    await refreshProfile()
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  async function analyseStyle() {
    if (!pastedMessages.trim() || pastedMessages.trim().length < 40) {
      setStyleError('Paste in a few real messages you\'ve actually sent, at least a couple of sentences each, so Annie has enough to work from.')
      return
    }
    setAnalysing(true)
    setStyleError('')
    try {
      const systemPrompt = `You analyse a person's real written communication style from examples of messages they've actually sent, so an AI writing on their behalf can sound authentically like them.

Read the pasted messages below and produce a concise style profile (120-180 words) covering: typical sentence length and structure, vocabulary/formality level, how they open and close messages, any recurring phrases or habits, use of punctuation, and overall tone. Be specific and descriptive, not generic. Write it as instructions an AI could follow, e.g. "Opens with a direct question rather than a greeting. Uses short sentences, rarely more than 15 words. Signs off with 'Cheers,' not 'Best regards.'"

Only return the style profile text, nothing else.`

      const resp = await fetch('/.netlify/functions/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: pastedMessages.trim() }],
          systemOverride: systemPrompt,
          maxTokens: 500,
        }),
      })
      const { text, error } = await resp.json()
      if (error) throw new Error(error)
      setWritingStyle((text || '').trim())
    } catch (err) {
      setStyleError('Could not analyse right now. Please try again.')
    } finally {
      setAnalysing(false)
    }
  }

  async function saveWritingStyle() {
    setStyleSaving(true)
    await supabase.from('onboarding').update({ writing_style: writingStyle.trim() || null }).eq('user_id', user.id)
    setOnboarding(prev => prev ? { ...prev, writing_style: writingStyle.trim() || null } : prev)
    setStyleSaving(false)
    setStyleSaved(true)
    setTimeout(() => setStyleSaved(false), 3000)
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

      <div className="card p-6 mb-6">
        <h2 className="text-lg font-bold text-navy mb-1">Writing style</h2>
        <p className="text-sm text-gray-500 mb-4">Paste in a few messages you've actually sent (emails, LinkedIn messages, anything in your own words). Annie analyses how you actually write and uses it to draft outreach that sounds like you, not a template.</p>

        <label className="label">Paste example messages</label>
        <textarea
          className="input resize-none mb-2"
          rows={5}
          placeholder="Paste 2-3 real messages you've sent, separated by a blank line..."
          value={pastedMessages}
          onChange={e => setPastedMessages(e.target.value)}
        />
        {styleError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{styleError}</div>}
        <button onClick={analyseStyle} disabled={analysing} className="btn-ghost mb-4">{analysing ? 'Analysing...' : 'Analyse my style'}</button>

        <label className="label">Your style profile</label>
        <textarea
          className="input resize-none"
          rows={5}
          placeholder="Your style profile will appear here after analysing, or you can write/edit it directly."
          value={writingStyle}
          onChange={e => setWritingStyle(e.target.value)}
        />
        <div className="flex items-center gap-3 mt-3">
          <button onClick={saveWritingStyle} disabled={styleSaving} className="btn-primary">{styleSaving ? 'Saving...' : 'Save style profile'}</button>
          {styleSaved && <span className="text-green-600 text-sm font-medium">Saved!</span>}
        </div>
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

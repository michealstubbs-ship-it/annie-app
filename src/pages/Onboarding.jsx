import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

const SECTORS = ['Executive Search','Technology','Financial Services','Legal','Healthcare','Energy & Utilities','Real Estate','Consumer & Retail','Industrial','Professional Services','Private Equity','Government & Public Sector']
const LOCATIONS = ['United Kingdom','UAE / GCC','Europe','United States','Asia Pacific','Global']
const TONES = [
  { id: 'professional', label: 'Professional', desc: 'Polished and formal' },
  { id: 'warm', label: 'Warm', desc: 'Friendly and personable' },
  { id: 'direct', label: 'Direct', desc: 'Straight to the point' },
  { id: 'consultative', label: 'Consultative', desc: 'Advisory and thoughtful' },
]

export default function Onboarding() {
  const { user, profile, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [form, setForm] = useState({
    firmName: profile?.firm_name || '',
    sectors: [],
    locations: [],
    targetCompanies: '',
    bdGoals: '',
    tone: 'professional',
  })

  function toggleItem(field, value) {
    setForm(prev => ({
      ...prev,
      [field]: prev[field].includes(value)
        ? prev[field].filter(v => v !== value)
        : [...prev[field], value],
    }))
  }

  function update(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
    setError('')
  }

  async function handleFinish() {
    setLoading(true)
    setError('')
    try {
      const targetArr = form.targetCompanies
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)

      // Save onboarding data
      const { error: onboardErr } = await supabase.from('onboarding').upsert({
        user_id: user.id,
        firm_name: form.firmName,
        sectors: form.sectors,
        locations: form.locations,
        target_companies: targetArr,
        bd_goals: form.bdGoals,
        tone: form.tone,
      }, { onConflict: 'user_id' })

      if (onboardErr) throw onboardErr

      // Mark onboarding complete on profile
      const { error: profileErr } = await supabase
        .from('profiles')
        .update({ onboarding_completed: true, firm_name: form.firmName })
        .eq('id', user.id)

      if (profileErr) throw profileErr

      await refreshProfile()
      navigate('/dashboard')
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const steps = [
    { num: 1, label: 'Your Firm' },
    { num: 2, label: 'Sectors' },
    { num: 3, label: 'Markets' },
    { num: 4, label: 'Targets' },
    { num: 5, label: 'Your Style' },
  ]

  return (
    <div className="min-h-screen bg-navy flex flex-col items-center justify-center px-4 py-12">

      {/* Logo */}
      <div className="flex items-center gap-3 mb-10">
        <svg width="40" height="40" viewBox="0 0 68 68" fill="none">
          <rect width="68" height="68" rx="16" fill="#c9a84c"/>
          <path d="M34 14 L50 54 H44 L40 44 H28 L24 54 H18 L34 14Z M34 24 L30 38 H38 L34 24Z" fill="#0d1b3e"/>
        </svg>
        <div>
          <div className="text-white font-bold text-xl leading-none">annie</div>
          <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {steps.map((s, i) => (
          <React.Fragment key={s.num}>
            <div className={`flex items-center gap-1.5 ${step >= s.num ? 'text-gold' : 'text-gray-600'}`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all
                ${step > s.num ? 'bg-gold border-gold text-navy' : step === s.num ? 'border-gold text-gold' : 'border-gray-600 text-gray-600'}`}>
                {step > s.num ? '✓' : s.num}
              </div>
              <span className="text-xs font-medium hidden sm:block">{s.label}</span>
            </div>
            {i < steps.length - 1 && <div className={`w-8 h-px ${step > s.num ? 'bg-gold' : 'bg-gray-700'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Card */}
      <div className="bg-white rounded-2xl p-8 shadow-2xl w-full max-w-lg">

        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>}

        {/* Step 1 — Firm */}
        {step === 1 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Tell us about your firm</h2>
            <p className="text-gray-500 text-sm mb-6">Annie uses this to personalise everything for you.</p>
            <div className="space-y-4">
              <div>
                <label className="label">Firm name</label>
                <input className="input" placeholder="e.g. Vantage Search Group" value={form.firmName} onChange={e => update('firmName', e.target.value)} />
              </div>
              <div>
                <label className="label">Your BD goals</label>
                <textarea className="input resize-none" rows={4} placeholder="e.g. Win 3 new retained clients this quarter in financial services. Focus on CFO and CEO roles..." value={form.bdGoals} onChange={e => update('bdGoals', e.target.value)} />
                <p className="text-xs text-gray-400 mt-1">Be specific — Annie will use this to prioritise your daily actions.</p>
              </div>
            </div>
          </div>
        )}

        {/* Step 2 — Sectors */}
        {step === 2 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Which sectors do you recruit in?</h2>
            <p className="text-gray-500 text-sm mb-6">Select all that apply.</p>
            <div className="grid grid-cols-2 gap-2">
              {SECTORS.map(s => (
                <button key={s} onClick={() => toggleItem('sectors', s)}
                  className={`px-3 py-2.5 rounded-lg text-sm font-medium border-2 text-left transition-all
                    ${form.sectors.includes(s) ? 'border-gold bg-yellow-50 text-navy' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3 — Markets */}
        {step === 3 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Where are your target markets?</h2>
            <p className="text-gray-500 text-sm mb-6">Select all that apply.</p>
            <div className="grid grid-cols-2 gap-2">
              {LOCATIONS.map(l => (
                <button key={l} onClick={() => toggleItem('locations', l)}
                  className={`px-3 py-2.5 rounded-lg text-sm font-medium border-2 text-left transition-all
                    ${form.locations.includes(l) ? 'border-gold bg-yellow-50 text-navy' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 4 — Target Companies */}
        {step === 4 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Who are you targeting?</h2>
            <p className="text-gray-500 text-sm mb-6">List the companies or types of firms you most want to win as clients.</p>
            <div>
              <label className="label">Target companies (one per line)</label>
              <textarea className="input resize-none" rows={8}
                placeholder={"HSBC\nBarclays\nMubadala\nADNOC\nMcKinsey & Company\nBlackRock"}
                value={form.targetCompanies} onChange={e => update('targetCompanies', e.target.value)} />
              <p className="text-xs text-gray-400 mt-1">Add as many as you like. Annie will monitor these for BD triggers.</p>
            </div>
          </div>
        )}

        {/* Step 5 — Tone */}
        {step === 5 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">How do you communicate?</h2>
            <p className="text-gray-500 text-sm mb-6">Annie will match your outreach style.</p>
            <div className="space-y-3">
              {TONES.map(t => (
                <button key={t.id} onClick={() => update('tone', t.id)}
                  className={`w-full px-4 py-3.5 rounded-lg border-2 text-left transition-all
                    ${form.tone === t.id ? 'border-gold bg-yellow-50' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className={`font-semibold text-sm ${form.tone === t.id ? 'text-navy' : 'text-gray-700'}`}>{t.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{t.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between items-center mt-8">
          {step > 1 ? (
            <button onClick={() => setStep(s => s - 1)} className="btn-ghost">Back</button>
          ) : <div />}

          {step < 5 ? (
            <button onClick={() => setStep(s => s + 1)} className="btn-primary">
              Continue
            </button>
          ) : (
            <button onClick={handleFinish} disabled={loading} className="btn-primary">
              {loading ? 'Setting up Annie...' : 'Launch Annie'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

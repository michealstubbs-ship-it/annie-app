import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { SECTOR_TAXONOMY } from '../lib/sectorTaxonomy'
import { FUNCTION_TAXONOMY } from '../lib/functionTaxonomy'
import SectorPicker from '../components/SectorPicker'

const LOCATIONS = ['United Kingdom', 'UAE / GCC', 'Europe', 'United States', 'Asia Pacific', 'Global']

const SCENARIO_NOTE = 'Same scenario in every tone, reaching out to a Head of Payments Ops who just posted about scaling her team.'

const TONES = [
  {
    id: 'professional',
    label: 'Professional',
    desc: 'Polished and formal',
    example: "Hi Amina, I hope this finds you well. I came across your recent update about expanding your payments operations team and wanted to introduce myself. I specialise in placing payments and fintech operations talent across the region, and would welcome the opportunity to discuss how I might support your hiring plans. Would you be available for a brief call this week?",
  },
  {
    id: 'warm',
    label: 'Warm',
    desc: 'Friendly and personable',
    example: "Hi Amina, congrats on getting the green light to build out payments ops, that's exciting! I work with a lot of fintech teams going through exactly this stage, and would love to hear more about what you're building. Free for a quick chat this week?",
  },
  {
    id: 'direct',
    label: 'Direct',
    desc: 'Straight to the point',
    example: "Hi Amina, saw you're scaling payments ops. I place specialist talent in this space across the region and have people ready to speak with now. Worth a 15-minute call this week?",
  },
  {
    id: 'consultative',
    label: 'Consultative',
    desc: 'Advisory and thoughtful',
    example: "Hi Amina, noticed you're building out payments ops, a stage where the right early hires shape the whole function long term. I work closely with teams at this point and have perspective on what's worked well elsewhere that might be useful either way. Open to a short call to compare notes?",
  },
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
    functions: [],
    locations: [],
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
      const { error: onboardErr } = await supabase.from('onboarding').upsert({
        user_id: user.id,
        firm_name: form.firmName,
        sectors: form.sectors,
        functions: form.functions,
        locations: form.locations,
        tone: form.tone,
      }, { onConflict: 'user_id' })
      if (onboardErr) throw onboardErr

      const { error: profileErr } = await supabase
        .from('profiles')
        .update({ onboarding_completed: true, firm_name: form.firmName })
        .eq('id', user.id)
      if (profileErr) throw profileErr

      await refreshProfile()
      navigate('/import')
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const steps = [
    { num: 1, label: 'Your Firm' },
    { num: 2, label: 'Sectors' },
    { num: 3, label: 'Functions' },
    { num: 4, label: 'Markets' },
    { num: 5, label: 'Your Style' },
  ]

  return (
    <div className="min-h-screen bg-navy flex flex-col items-center justify-center px-4 py-12">

      <div className="flex items-center gap-3 mb-10">
        <svg width="40" height="40" viewBox="0 0 36 36" fill="none">
          <rect width="36" height="36" rx="8" fill="#c9a84c"/>
          <path d="M18 3L29 33H25L18 13L11 33H7L18 3Z" fill="#0d1b3e"/>
          <rect x="10" y="22" width="16" height="3.2" rx="1.6" fill="#c9a84c"/>
        </svg>
        <div>
          <div className="text-white font-bold text-xl leading-none">annie</div>
          <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
        </div>
      </div>

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

      <div className={`bg-white rounded-2xl p-8 shadow-2xl w-full ${step === 5 ? 'max-w-xl' : 'max-w-lg'}`}>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>}

        {step === 1 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Tell us about your firm</h2>
            <p className="text-gray-500 text-sm mb-6">Annie uses this to personalise everything for you.</p>
            <div>
              <label className="label">Firm name</label>
              <input className="input" placeholder="e.g. Vantage Search Group" value={form.firmName} onChange={e => update('firmName', e.target.value)} />
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Which sectors do you recruit in?</h2>
            <p className="text-gray-500 text-sm mb-6">Select all that apply, click "Narrow down" on any of them to pick specific sub-sectors instead of the whole category. This drives everything Annie researches for you.</p>
            <SectorPicker taxonomy={SECTOR_TAXONOMY} value={form.sectors} onChange={v => update('sectors', v)} />
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Which functions do you place people into?</h2>
            <p className="text-gray-500 text-sm mb-6">This is the discipline a candidate works in (Finance, HSE, Construction, Healthcare, etc.), separate from the sector their employer sits in. Select all that apply, narrow down where useful.</p>
            <SectorPicker taxonomy={FUNCTION_TAXONOMY} value={form.functions} onChange={v => update('functions', v)} />
          </div>
        )}

        {step === 4 && (
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

        {step === 5 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">How do you communicate?</h2>
            <p className="text-gray-500 text-sm mb-1">Annie will match your outreach style.</p>
            <p className="text-xs text-gray-400 mb-5">{SCENARIO_NOTE}</p>
            <div className="space-y-2.5">
              {TONES.map(t => (
                <button key={t.id} onClick={() => update('tone', t.id)}
                  className={`w-full px-4 py-3.5 rounded-lg border-2 text-left transition-all
                    ${form.tone === t.id ? 'border-gold bg-yellow-50' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`font-semibold text-sm ${form.tone === t.id ? 'text-navy' : 'text-gray-700'}`}>{t.label}</span>
                    <span className="text-xs text-gray-400">{t.desc}</span>
                  </div>
                  <p className="text-xs text-gray-500 italic leading-relaxed">"{t.example}"</p>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-between items-center mt-8">
          {step > 1 ? (
            <button onClick={() => setStep(s => s - 1)} className="btn-ghost">Back</button>
          ) : <div />}

          {step < 5 ? (
            <button onClick={() => setStep(s => s + 1)} className="btn-primary">Continue</button>
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

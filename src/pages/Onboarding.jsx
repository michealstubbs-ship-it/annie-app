import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { SECTOR_TAXONOMY } from '../lib/sectorTaxonomy'
import { FUNCTION_TAXONOMY } from '../lib/functionTaxonomy'
import SectorPicker from '../components/SectorPicker'
import { withTimeout, TIMEOUT_MESSAGE } from '../lib/withTimeout'
import { trackEvent } from '../lib/analytics'

const LOCATIONS = ['United Kingdom', 'UAE / GCC', 'Europe', 'United States', 'Asia Pacific', 'Global']

// Onboarding answers are saved to localStorage as the user goes, keyed per
// user id, so a refresh/crash mid-form (e.g. on question 3) resumes exactly
// where they left off instead of forcing them to start over. Cleared once
// the form is actually submitted, or after 7 days so a very stale draft
// doesn't reappear and silently override taxonomy changes.
const DRAFT_KEY_PREFIX = 'annie_onboarding_draft_'
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function loadDraft(userId) {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(DRAFT_KEY_PREFIX + userId)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.savedAt || Date.now() - parsed.savedAt > DRAFT_MAX_AGE_MS) {
      localStorage.removeItem(DRAFT_KEY_PREFIX + userId)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function saveDraft(userId, step, form) {
  if (!userId) return
  try {
    localStorage.setItem(DRAFT_KEY_PREFIX + userId, JSON.stringify({ step, form, savedAt: Date.now() }))
  } catch {
    // Private/incognito mode or storage full — draft resume just won't work, not fatal.
  }
}

function clearDraft(userId) {
  if (!userId) return
  try {
    localStorage.removeItem(DRAFT_KEY_PREFIX + userId)
  } catch {}
}

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

  const [step, setStep] = useState(() => {
    const draft = loadDraft(user?.id)
    const n = Number(draft?.step)
    return n >= 1 && n <= 5 ? n : 1
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resumed, setResumed] = useState(() => !!loadDraft(user?.id))

  const [form, setForm] = useState(() => {
    const draft = loadDraft(user?.id)
    return {
      firmName: draft?.form?.firmName ?? (profile?.firm_name || ''),
      sectors: draft?.form?.sectors ?? [],
      functions: draft?.form?.functions ?? [],
      locations: draft?.form?.locations ?? [],
      tone: draft?.form?.tone ?? 'professional',
    }
  })

  // Persist on every change so a refresh (even mid-question) can resume.
  useEffect(() => {
    saveDraft(user?.id, step, form)
  }, [user?.id, step, form])

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

  // Required-field gate per step so "Continue"/"Launch Annie" can't be
  // clicked past a blank step — otherwise handleFinish() happily submits
  // empty sectors/functions/locations, and the scan pipeline downstream has
  // nothing to search against with no clear error surfaced to the user.
  function isStepValid(s, f) {
    switch (s) {
      case 1: return f.firmName.trim().length > 0
      case 2: return f.sectors.length > 0
      case 3: return f.functions.length > 0
      case 4: return f.locations.length > 0
      case 5: return !!f.tone
      default: return true
    }
  }

  const STEP_HINTS = {
    1: 'Enter your firm name to continue',
    2: 'Select at least one sector to continue',
    3: 'Select at least one function to continue',
    4: 'Select at least one market to continue',
    5: 'Select a communication tone to continue',
  }

  const canContinue = isStepValid(step, form)

  async function handleFinish() {
    setLoading(true)
    setError('')
    try {
      // Routed through our own domain (netlify/functions/save-onboarding.js)
      // rather than calling supabase.co directly from the browser. Some
      // antivirus "web protection" / corporate network filters silently
      // block background API writes to third-party domains even while the
      // site itself loads fine — that was the actual cause of onboarding
      // never completing. A same-origin POST to app.meetannie.ai isn't
      // filtered the same way.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('Your session has expired. Please log in again.')

      const resp = await withTimeout(
        fetch('/.netlify/functions/save-onboarding', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({
            firmName: form.firmName,
            sectors: form.sectors,
            functions: form.functions,
            locations: form.locations,
            tone: form.tone,
          }),
        }),
        15000,
        'onboarding-save',
      )
      const result = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(result.error || 'Could not save your answers. Please try again.')

      trackEvent('onboarding_completed', { sectors: form.sectors, functions: form.functions })

      // Kick off Annie's first research scan for this account right now,
      // without waiting for it — otherwise the only research that ever runs
      // is the shared 4-hourly cron job, which means a brand new customer
      // could land on an empty dashboard for hours. This is a background
      // function (runs up to 15 min server-side) and usually finishes well
      // within the time it takes to get through the next screen, so real
      // signals are already there by the time the dashboard loads.
      fetch('/.netlify/functions/scan-now-background', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => {})
      try { localStorage.setItem('annie_scan_started_' + user?.id, String(Date.now())) } catch {}

      // The save already succeeded at this point — that's the part that
      // matters. refreshProfile() just re-pulls the profile row so the rest
      // of the app immediately knows onboarding is done; if it's slow or
      // gets blocked (same class of issue the save itself used to hit) we
      // still move the user on rather than leaving them stuck on this
      // screen. The next page load re-fetches the profile anyway.
      clearDraft(user?.id)
      try {
        await withTimeout(refreshProfile(), 8000, 'post-onboarding-profile-refresh')
      } catch (refreshErr) {
        console.warn('[Onboarding] profile refresh after save was slow/blocked, continuing anyway:', refreshErr)
      }
      navigate('/import')
    } catch (err) {
      console.error('[Onboarding] handleFinish failed:', err)
      if (err.message?.startsWith('TIMEOUT:')) {
        setError(TIMEOUT_MESSAGE)
      } else {
        setError(err.message || 'Something went wrong. Please try again.')
      }
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

        {resumed && !error && (
          <div className="bg-blue-50 border border-blue-100 text-blue-700 rounded-lg px-4 py-2.5 text-xs mb-4 flex items-center justify-between gap-3">
            <span>Picked up where you left off, your earlier answers are still here.</span>
            <button onClick={() => setResumed(false)} className="text-blue-400 hover:text-blue-600 font-bold flex-shrink-0" aria-label="Dismiss">✕</button>
          </div>
        )}

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

        <div className="mt-8">
          {!canContinue && (
            <p className="text-xs text-gold-ink mb-2 text-right">{STEP_HINTS[step]}</p>
          )}
          <div className="flex justify-between items-center">
            {step > 1 ? (
              <button onClick={() => setStep(s => s - 1)} className="btn-ghost">Back</button>
            ) : <div />}

            {step < 5 ? (
              <button onClick={() => setStep(s => s + 1)} disabled={!canContinue} className="btn-primary">Continue</button>
            ) : (
              <button onClick={handleFinish} disabled={loading || !canContinue} className="btn-primary">
                {loading ? 'Setting up Annie...' : 'Launch Annie'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

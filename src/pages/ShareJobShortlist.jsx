import React, { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { currencySymbol } from '../lib/invoiceCalc'

// 2026-09-06, gap-analysis batch 1 ("client-facing shortlist link"): the
// page a client opens with no Annie account and no login — a deliberately
// public route (see App.jsx), reading only from the public-job-shortlist
// function, which itself only ever returns the hand-picked safe fields
// (see that function's own header comment). Never imports supabase
// directly — this page has no session to use it with.
const STAGE_ORDER = ['In review', 'Shortlisted', 'Presented to you', 'Interviewing', 'Offer stage', 'Placed']
const STAGE_COLOR = {
  'In review': 'bg-slate-100 text-slate-600',
  'Shortlisted': 'bg-purple-100 text-purple-700',
  'Presented to you': 'bg-amber-100 text-amber-700',
  'Interviewing': 'bg-orange-100 text-orange-700',
  'Offer stage': 'bg-emerald-100 text-emerald-700',
  'Placed': 'bg-yellow-100 text-gold',
}

function initials(name) { return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() }

export default function ShareJobShortlist() {
  const { token } = useParams()
  const [state, setState] = useState({ loading: true, error: '', data: null })

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const resp = await fetch(`/.netlify/functions/public-job-shortlist?token=${encodeURIComponent(token)}`)
        const body = await resp.json().catch(() => ({}))
        if (cancelled) return
        if (!resp.ok) {
          setState({ loading: false, error: body?.error || 'This link is not active.', data: null })
          return
        }
        setState({ loading: false, error: '', data: body })
      } catch {
        if (!cancelled) setState({ loading: false, error: 'Could not load this shortlist right now — please try again shortly.', data: null })
      }
    }
    load()
    return () => { cancelled = true }
  }, [token])

  const sorted = state.data
    ? [...state.data.candidates].sort((a, b) => STAGE_ORDER.indexOf(b.stage) - STAGE_ORDER.indexOf(a.stage))
    : []

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-navy text-white">
        <div className="max-w-3xl mx-auto px-6 py-5 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-gold" />
          <span className="font-bold tracking-wide">Annie</span>
          <span className="text-white/60 text-sm">· Candidate shortlist</span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-10">
        {state.loading && <p className="text-gray-400">Loading your shortlist…</p>}

        {!state.loading && state.error && (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
            <div className="text-3xl mb-3">🔒</div>
            <h1 className="font-bold text-navy text-lg mb-1">Link not available</h1>
            <p className="text-gray-500 text-sm">{state.error}</p>
          </div>
        )}

        {!state.loading && state.data && (
          <>
            <h1 className="text-2xl font-bold text-navy">{state.data.jobTitle}</h1>
            {state.data.companyName && <p className="text-gray-500 mt-1">{state.data.companyName}</p>}
            <p className="text-xs text-gray-400 mt-1">Live shortlist — updates automatically as your recruiter progresses candidates. Refresh this page any time.</p>

            {sorted.length === 0 ? (
              <div className="bg-white border border-gray-200 rounded-xl p-8 text-center mt-6">
                <p className="text-gray-500 text-sm">No candidates on the shortlist yet — check back soon.</p>
              </div>
            ) : (
              <div className="grid gap-3 mt-6">
                {sorted.map((c, i) => (
                  <div key={i} className="bg-white border border-gray-200 rounded-xl p-4 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-navy/10 text-navy font-bold text-sm flex items-center justify-center flex-shrink-0">
                      {initials(c.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-navy text-sm">{c.name}</div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {c.wantSalary ? `${currencySymbol(c.wantSalaryCurrency) || ''}${Number(c.wantSalary).toLocaleString()}` : ''}
                        {c.interviewAt ? `${c.wantSalary ? ' · ' : ''}Interview: ${new Date(c.interviewAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                      </div>
                    </div>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full flex-shrink-0 ${STAGE_COLOR[c.stage] || 'bg-gray-100 text-gray-500'}`}>{c.stage}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

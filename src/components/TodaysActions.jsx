import React, { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

export default function TodaysActions() {
  const { user, profile } = useAuth()
  const [actions, setActions] = useState([])
  const [loading, setLoading] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [error, setError] = useState('')
  const [onboarding, setOnboarding] = useState(null)

  useEffect(() => {
    loadCachedActions()
    loadOnboarding()
  }, [user])

  async function loadOnboarding() {
    const { data } = await supabase.from('onboarding').select('*').eq('user_id', user.id).single()
    setOnboarding(data)
  }

  async function loadCachedActions() {
    const { data } = await supabase
      .from('actions_cache')
      .select('*')
      .eq('user_id', user.id)
      .gt('expires_at', new Date().toISOString())
      .order('generated_at', { ascending: false })
      .limit(1)
      .single()

    if (data?.actions) {
      setActions(data.actions)
      setGenerated(true)
    }
  }

  async function generate() {
    setLoading(true)
    setError('')
    try {
      const { data: contacts } = await supabase
        .from('contacts')
        .select('name, company, title, status, last_contacted, notes')
        .eq('user_id', user.id)
        .limit(50)

      const { data: deals } = await supabase
        .from('deals')
        .select('company, stage, value, next_action, next_action_date')
        .eq('user_id', user.id)
        .limit(20)

      const systemPrompt = `You are Annie, a BD intelligence engine for recruitment firms.
The user is ${profile?.full_name} at ${profile?.firm_name || onboarding?.firm_name || 'their recruitment firm'}.
Their sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Their target markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Their BD goals: ${onboarding?.bd_goals || 'Win new clients and grow the business'}.
Their communication tone: ${onboarding?.tone || 'professional'}.
Target companies: ${onboarding?.target_companies?.join(', ') || 'Various'}.

Today is ${new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

Contacts in their CRM: ${JSON.stringify(contacts || [])}
Active deals: ${JSON.stringify(deals || [])}

Generate exactly 5 high-priority BD actions for today. Each action should be specific, actionable, and focused on winning new business or progressing existing deals.

Return a JSON array of exactly 5 objects with this structure:
[{
  "priority": 1,
  "type": "outreach|follow_up|research|meeting|proposal",
  "headline": "Short action headline (max 8 words)",
  "detail": "Specific detail about what to do and why (2-3 sentences)",
  "company": "Company name if applicable",
  "contact": "Contact name if applicable",
  "why_now": "Why this matters today specifically (1 sentence)"
}]

Only return the JSON array, nothing else.`

      const resp = await fetch('/.netlify/functions/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Generate my top 5 BD actions for today.' }],
          systemOverride: systemPrompt,
          maxTokens: 2000,
          model: 'claude-haiku-4-5-20251001',
        }),
      })

      if (!resp.ok) throw new Error('Failed to generate actions')

      const text = await resp.text()
      let parsed
      try {
        const match = text.match(/\[[\s\S]*\]/)
        parsed = JSON.parse(match ? match[0] : text)
      } catch {
        throw new Error('Could not parse AI response')
      }

      setActions(parsed)
      setGenerated(true)

      // Cache for 24 hours
      await supabase.from('actions_cache').upsert({
        user_id: user.id,
        actions: parsed,
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: 'user_id' })

    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const typeColors = {
    outreach: 'bg-blue-100 text-blue-700',
    follow_up: 'bg-amber-100 text-amber-700',
    research: 'bg-purple-100 text-purple-700',
    meeting: 'bg-green-100 text-green-700',
    proposal: 'bg-red-100 text-red-700',
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-navy">Good morning, {profile?.full_name?.split(' ')[0] || 'there'}</h1>
        <p className="text-gray-500 mt-1">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {!generated && !loading && (
        <div className="card p-10 text-center">
          <div className="text-5xl mb-4">⚡</div>
          <h2 className="text-xl font-bold text-navy mb-2">Ready to generate your actions?</h2>
          <p className="text-gray-500 mb-6 max-w-sm mx-auto">Annie will analyse your contacts, deals and BD goals to give you today's top 5 priorities.</p>
          <button onClick={generate} className="btn-primary">Generate Today's Actions</button>
        </div>
      )}

      {loading && (
        <div className="card p-10 text-center">
          <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-navy font-semibold">Annie is thinking...</p>
          <p className="text-gray-500 text-sm mt-1">Analysing your contacts and pipeline</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>
      )}

      {generated && actions.length > 0 && (
        <div className="space-y-4">
          {actions.map((action, i) => (
            <div key={i} className="card p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full bg-navy text-gold flex items-center justify-center font-bold text-sm flex-shrink-0 mt-0.5">
                  {action.priority}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="font-bold text-navy">{action.headline}</h3>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${typeColors[action.type] || 'bg-gray-100 text-gray-600'}`}>
                      {action.type?.replace('_', ' ')}
                    </span>
                  </div>
                  {(action.company || action.contact) && (
                    <p className="text-xs text-gold font-semibold mb-1.5">
                      {[action.contact, action.company].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  <p className="text-gray-600 text-sm mb-2">{action.detail}</p>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 text-xs text-amber-700 font-medium">
                    Why now: {action.why_now}
                  </div>
                </div>
              </div>
            </div>
          ))}

          <button onClick={generate} disabled={loading} className="btn-ghost text-sm mt-2">
            Regenerate actions
          </button>
        </div>
      )}
    </div>
  )
}

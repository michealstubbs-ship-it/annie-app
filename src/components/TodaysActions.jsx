import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { buildDormantPool, buildMeetingPool, buildRelationshipPool, buildNewClientPool, selectDailyItems } from '../lib/actionsEngine'
import { buildEnrichmentPrompt, buildSourcingPrompt } from '../lib/actionsCopy'

const BADGE = {
  dormant: { label: 're-engage', className: 'bg-amber-100 text-amber-700' },
  meeting: { label: 'meeting', className: 'bg-green-100 text-green-700' },
  relationship: { label: 'relationship', className: 'bg-purple-100 text-purple-700' },
  new_client: { label: 'new client', className: 'bg-blue-100 text-blue-700' },
  sourced: { label: 'sourced by annie', className: 'bg-navy text-gold' },
}

async function callChat({ messages, systemOverride, maxTokens, model, webSearch }) {
  const resp = await fetch('/.netlify/functions/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, systemOverride, maxTokens, model, webSearch }),
  })
  if (!resp.ok) throw new Error('Request failed')
  const { text } = await resp.json()
  return text
}

function extractJson(text) {
  const match = text.match(/\[[\s\S]*\]/)
  return JSON.parse(match ? match[0] : text)
}

export default function TodaysActions() {
  const { user, profile } = useAuth()
  const [actions, setActions] = useState([])
  const [loading, setLoading] = useState(false)
  const [generated, setGenerated] = useState(false)
  const [error, setError] = useState('')
  const [onboarding, setOnboarding] = useState(null)
  const [openIndex, setOpenIndex] = useState(null)

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

    if (data?.actions?.length) {
      setActions(data.actions)
      setGenerated(true)
    }
  }

  async function generate() {
    setLoading(true)
    setError('')
    try {
      const [{ data: contacts }, { data: deals }, { data: signals }, { data: freshOnboarding }] = await Promise.all([
        supabase.from('contacts').select('*').eq('user_id', user.id).limit(500),
        supabase.from('deals').select('*').eq('user_id', user.id).limit(200),
        supabase.from('signals').select('*').eq('user_id', user.id).limit(200),
        supabase.from('onboarding').select('*').eq('user_id', user.id).single(),
      ])

      const ob = freshOnboarding || onboarding
      const targetCompanies = ob?.target_companies || []

      // Step 1: deterministic pool building, no AI involved
      const pools = {
        dormant: buildDormantPool(contacts || [], targetCompanies),
        meeting: buildMeetingPool(deals || [], contacts || []),
        relationship: buildRelationshipPool(signals || [], contacts || [], targetCompanies),
        new_client: buildNewClientPool(contacts || [], deals || [], targetCompanies),
      }
      const selected = selectDailyItems(pools)

      // Step 2: AI writes copy for the already-selected CRM items (batched, one call)
      let enriched = []
      if (selected.length) {
        const prompt = buildEnrichmentPrompt(selected, ob, profile)
        const text = await callChat({
          messages: [{ role: 'user', content: 'Write the copy for these items.' }],
          systemOverride: prompt,
          maxTokens: 2500,
          model: 'claude-haiku-4-5-20251001',
        })
        try {
          enriched = extractJson(text)
        } catch {
          enriched = selected.map(() => null)
        }
      }

      const crmActions = selected.map((item, i) => ({
        source: 'crm',
        category: item.category,
        headline: enriched[i]?.headline || 'Follow up',
        detail: enriched[i]?.detail || '',
        moveForward: enriched[i]?.moveForward || [],
        signals: item.signals,
        company: item.contact?.company || item.deal?.company || item.signal?.company,
        contact: item.contact?.name || item.deal?.contact_name || '',
        title: item.contact?.title || '',
      }))

      // Step 3: sourced leads, real web search, only for companies not already known
      const existingCompanies = (contacts || []).map(c => c.company).filter(Boolean)
      let sourcedActions = []
      try {
        const sourcingPrompt = buildSourcingPrompt(ob, existingCompanies)
        const sourcingText = await callChat({
          messages: [{ role: 'user', content: 'Find genuine BD opportunities for today.' }],
          systemOverride: sourcingPrompt,
          maxTokens: 2000,
          model: 'claude-haiku-4-5-20251001',
          webSearch: true,
        })
        const sourcedRaw = extractJson(sourcingText)
        sourcedActions = (sourcedRaw || []).map(s => ({
          source: 'sourced',
          category: 'sourced',
          headline: s.headline,
          detail: s.whatAnnieFound,
          company: s.company,
          sourceUrl: s.sourceUrl,
          sourceLabel: s.sourceLabel,
          whoToApproach: s.whoToApproach,
          candidateAngle: s.candidateAngle,
        }))
      } catch {
        sourcedActions = []
      }

      const combined = [...crmActions, ...sourcedActions]

      setActions(combined)
      setGenerated(true)

      await supabase.from('actions_cache').upsert({
        user_id: user.id,
        actions: combined,
        generated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: 'user_id' })

    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-navy">Good morning, {profile?.full_name?.split(' ')[0] || 'there'}</h1>
        <p className="text-gray-500 mt-1">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {!generated && !loading && (
        <div className="card p-10 text-center">
          <div className="text-5xl mb-4">⚡</div>
          <h2 className="text-xl font-bold text-navy mb-2">Ready to generate your actions?</h2>
          <p className="text-gray-500 mb-6 max-w-sm mx-auto">Annie will analyse your contacts, pipeline, and the wider market to give you everything genuinely worth acting on today, sized by real opportunity, not a fixed number.</p>
          <button onClick={generate} className="btn-primary">Generate Today's Actions</button>
        </div>
      )}

      {loading && (
        <div className="card p-10 text-center">
          <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-navy font-semibold">Annie is thinking...</p>
          <p className="text-gray-500 text-sm mt-1">Analysing your pipeline and researching the market, this can take a moment</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>
      )}

      {generated && actions.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500 mb-2">Annie found <span className="font-semibold text-navy">{actions.length} thing{actions.length === 1 ? '' : 's'} worth your attention today</span>, sized by what's genuinely urgent, not a fixed number.</p>

          {actions.map((action, i) => {
            const badge = BADGE[action.category] || BADGE.new_client
            const isOpen = openIndex === i
            const isSourced = action.source === 'sourced'
            return (
              <div
                key={i}
                onClick={() => setOpenIndex(isOpen ? null : i)}
                className={`card p-4 cursor-pointer hover:shadow-md transition-shadow ${isSourced ? 'border-2 border-gold/40 bg-yellow-50/30' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-full bg-navy text-gold flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-navy text-sm">{action.headline}</h3>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${badge.className}`}>{badge.label}</span>
                    </div>
                    {(action.contact || action.company) && (
                      <p className="text-xs text-gold font-semibold mt-1">
                        {[action.contact, action.title, action.company].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    <p className="text-gray-600 text-sm mt-1.5">{action.detail}</p>

                    {isOpen && (
                      <div className="mt-3 pt-3 border-t border-gray-100" onClick={e => e.stopPropagation()}>
                        {isSourced ? (
                          <>
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">What Annie found</div>
                            {action.sourceUrl && (
                              <a href={action.sourceUrl} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline block mb-3">
                                🔗 {action.sourceLabel || action.sourceUrl}
                              </a>
                            )}
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Who to approach, and why</div>
                            <p className="text-xs text-gray-600 mb-3">{action.whoToApproach}</p>
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Candidate angle</div>
                            <p className="text-xs text-navy italic border-l-2 border-gold pl-3">{action.candidateAngle}</p>
                          </>
                        ) : (
                          <>
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Why this made the list</div>
                            <div className="space-y-1 mb-3">
                              {Object.entries(action.signals || {}).map(([k, v]) => (
                                <div key={k} className="flex justify-between text-xs">
                                  <span className="text-gray-400">{k}</span>
                                  <span className="text-navy font-semibold">{v}</span>
                                </div>
                              ))}
                            </div>
                            {action.moveForward?.length > 0 && (
                              <>
                                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Ways to move this forward</div>
                                <div className="space-y-1.5">
                                  {action.moveForward.map((m, mi) => (
                                    <div key={mi} className="bg-page-bg rounded-lg px-3 py-2 text-xs text-gray-600">{m}</div>
                                  ))}
                                </div>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

          <button onClick={generate} disabled={loading} className="btn-ghost text-sm mt-2">
            Regenerate actions
          </button>
        </div>
      )}

      {generated && actions.length === 0 && !loading && (
        <div className="card p-10 text-center">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-bold text-navy mb-1">Nothing urgent today</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">Your pipeline is quiet and Annie couldn't find a genuinely strong sourced lead right now. Check back tomorrow, or import more LinkedIn contacts to give Annie more to work with.</p>
        </div>
      )}
    </div>
  )
}

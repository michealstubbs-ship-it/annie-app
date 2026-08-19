import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { buildDormantPool, buildMeetingPool, buildRelationshipPool, buildNewClientPool, buildSourcedPool, selectDailyItems } from '../lib/actionsEngine'
import { buildEnrichmentPrompt } from '../lib/actionsCopy'

const BADGE = {
  dormant: { label: 're-engage', className: 'bg-amber-100 text-amber-700' },
  meeting: { label: 'meeting', className: 'bg-green-100 text-green-700' },
  relationship: { label: 'relationship', className: 'bg-purple-100 text-purple-700' },
  new_client: { label: 'new client', className: 'bg-blue-100 text-blue-700' },
  sourced: { label: 'sourced by annie', className: 'bg-navy text-gold' },
}

async function callChat({ messages, systemOverride, maxTokens, model }) {
  const resp = await fetch('/.netlify/functions/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, systemOverride, maxTokens, model }),
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
      const [{ data: contacts }, { data: deals }, { data: intelSignals }, { data: freshOnboarding }] = await Promise.all([
        supabase.from('contacts').select('*').eq('user_id', user.id).limit(500),
        supabase.from('deals').select('*').eq('user_id', user.id).limit(200),
        // Reads what the background scan already found, no search happens here.
        supabase.from('intelligence_signals').select('*').eq('user_id', user.id).neq('status', 'actioned').order('found_at', { ascending: false }).limit(300),
        supabase.from('onboarding').select('*').eq('user_id', user.id).single(),
      ])

      const ob = freshOnboarding || onboarding

      // Step 1: deterministic pool building + selection, no AI involved. Every pool,
      // including sourced leads, is scored on the same scale and ranked by urgency
      // first, then value. No cap on how many show, no guaranteed slot per category.
      const pools = {
        dormant: buildDormantPool(contacts || []),
        meeting: buildMeetingPool(deals || [], contacts || []),
        relationship: buildRelationshipPool(intelSignals || [], contacts || []),
        new_client: buildNewClientPool(contacts || [], deals || []),
        sourced: buildSourcedPool(intelSignals || [], contacts || []),
      }
      const selected = selectDailyItems(pools)

      // Step 2: AI writes copy only for the CRM-derived items. Sourced items already
      // have their headline/why-it-matters/candidate angle written by the scan that
      // found them, no second AI call needed for those.
      const crmItems = selected.filter(i => i.category !== 'sourced')
      let enrichedList = []
      if (crmItems.length) {
        const prompt = buildEnrichmentPrompt(crmItems, ob, profile)
        const text = await callChat({
          messages: [{ role: 'user', content: 'Write the copy for these items.' }],
          systemOverride: prompt,
          maxTokens: 2500,
          model: 'claude-haiku-4-5-20251001',
        })
        try {
          enrichedList = extractJson(text)
        } catch {
          enrichedList = crmItems.map(() => null)
        }
      }
      const enrichedByItem = new Map(crmItems.map((item, i) => [item, enrichedList[i] || null]))

      // Step 3: reassemble in the ranked order decided in step 1, whether an item is
      // a CRM follow-up or a sourced lead makes no difference to where it lands.
      const combined = selected.map(item => {
        if (item.category === 'sourced') {
          const s = item.signal
          return {
            source: 'sourced',
            category: 'sourced',
            urgency: item.urgency,
            headline: s.headline,
            detail: s.why_it_matters,
            company: s.company_name,
            companyLogo: s.company_logo_url,
            sourceUrl: s.source_url,
            sourceLabel: s.source_label,
            whoToApproach: s.who_to_approach,
            candidateAngle: s.candidate_angle,
            verifiedContact: s.contact_verified ? { name: s.contact_name, title: s.contact_title, linkedin_url: s.contact_linkedin_url } : null,
            signalId: s.id,
          }
        }
        const enriched = enrichedByItem.get(item)
        return {
          source: 'crm',
          category: item.category,
          urgency: item.urgency,
          headline: enriched?.headline || 'Follow up',
          detail: enriched?.detail || '',
          moveForward: enriched?.moveForward || [],
          signals: item.signals,
          company: item.contact?.company || item.deal?.company || item.signal?.company_name,
          contact: item.contact?.name || item.deal?.contact_name || '',
          title: item.contact?.title || '',
          signalId: item.category === 'relationship' ? item.signal?.id : null,
        }
      })

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

  async function markDone(action, index) {
    if (action.signalId) {
      await supabase.from('intelligence_signals').update({ status: 'actioned' }).eq('id', action.signalId)
    }
    const next = actions.filter((_, i) => i !== index)
    setActions(next)
    await supabase.from('actions_cache').upsert({
      user_id: user.id,
      actions: next,
      generated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'user_id' })
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
          <h2 className="text-xl font-bold text-navy mb-2">Ready to see today's actions?</h2>
          <p className="text-gray-500 mb-6 max-w-sm mx-auto">Annie is already researching your market around the clock. This pulls together everything genuinely worth acting on today, sized by real opportunity, not a fixed number.</p>
          <button onClick={generate} className="btn-primary">Show Today's Actions</button>
        </div>
      )}

      {loading && (
        <div className="card p-10 text-center">
          <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-navy font-semibold">Annie is thinking...</p>
          <p className="text-gray-500 text-sm mt-1">Scoring your pipeline against what she's already found</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>
      )}

      {generated && actions.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-gray-500 mb-2">Annie found <span className="font-semibold text-navy">{actions.length} thing{actions.length === 1 ? '' : 's'} worth your attention today</span>, ranked by what's most time-sensitive first, sized by what's genuinely urgent, not a fixed number.</p>

          {actions.map((action, i) => {
            const badge = BADGE[action.category] || BADGE.new_client
            const isOpen = openIndex === i
            const isSourced = action.source === 'sourced'
            return (
              <div
                key={i}
                onClick={() => setOpenIndex(isOpen ? null : i)}
                className={`card p-4 cursor-pointer hover:shadow-md transition-shadow ${isSourced ? 'border-2 border-gold/40 bg-yellow-50/30' : ''} ${action.urgency >= 2 ? 'ring-1 ring-gold' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-full bg-navy text-gold flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-navy text-sm">{action.headline}</h3>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${badge.className}`}>{badge.label}</span>
                      {action.urgency >= 2 && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gold text-navy">time-sensitive</span>}
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
                            {action.verifiedContact ? (
                              <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-3">
                                <div className="flex items-center gap-1.5 mb-1">
                                  <span className="text-[9px] font-bold text-green-700 uppercase tracking-wider">Verified via Apollo</span>
                                </div>
                                <p className="text-xs font-semibold text-navy">{action.verifiedContact.name}{action.verifiedContact.title ? `, ${action.verifiedContact.title}` : ''}</p>
                                {action.verifiedContact.linkedin_url && (
                                  <a href={action.verifiedContact.linkedin_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline">View LinkedIn profile</a>
                                )}
                                <p className="text-xs text-gray-600 mt-1.5">{action.whoToApproach}</p>
                              </div>
                            ) : (
                              <p className="text-xs text-gray-600 mb-3">{action.whoToApproach} <span className="text-gray-400">(no verified contact found yet, approach by role)</span></p>
                            )}
                            {action.candidateAngle && (
                              <>
                                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Candidate angle</div>
                                <p className="text-xs text-navy italic border-l-2 border-gold pl-3 mb-3">{action.candidateAngle}</p>
                              </>
                            )}
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
                                <div className="space-y-1.5 mb-3">
                                  {action.moveForward.map((m, mi) => (
                                    <div key={mi} className="bg-page-bg rounded-lg px-3 py-2 text-xs text-gray-600">{m}</div>
                                  ))}
                                </div>
                              </>
                            )}
                          </>
                        )}
                        <button onClick={() => markDone(action, i)} className="text-xs font-semibold text-gray-400 hover:text-navy">Mark done</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

          <button onClick={generate} disabled={loading} className="btn-ghost text-sm mt-2">
            Refresh
          </button>
        </div>
      )}

      {generated && actions.length === 0 && !loading && (
        <div className="card p-10 text-center">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-bold text-navy mb-1">Nothing urgent today</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">Your pipeline is quiet and Annie's ongoing scan hasn't turned up anything strong enough yet. Check back later, she's still watching in the background.</p>
        </div>
      )}
    </div>
  )
}

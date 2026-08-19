import React, { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

export default function Chat() {
  const { user, profile } = useAuth()
  const location = useLocation()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [onboarding, setOnboarding] = useState(null)
  const bottomRef = useRef(null)

  useEffect(() => { loadHistory(); loadOnboarding() }, [user])

  // Arriving from Intelligence Feed's "Draft outreach" button, prefill the input
  // with context so the recruiter doesn't retype what Annie already knows.
  useEffect(() => {
    if (location.state?.prefill) setInput(location.state.prefill)
  }, [location.state])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function loadOnboarding() {
    const { data } = await supabase.from('onboarding').select('*').eq('user_id', user.id).single()
    setOnboarding(data)
  }

  async function loadHistory() {
    const { data } = await supabase.from('chat_messages').select('*').eq('user_id', user.id).order('created_at', { ascending: true }).limit(50)
    if (data?.length) setMessages(data.map(m => ({ role: m.role, content: m.content })))
  }

  async function send() {
    if (!input.trim() || loading) return
    const userMsg = { role: 'user', content: input.trim() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      await supabase.from('chat_messages').insert({ user_id: user.id, role: 'user', content: userMsg.content })

      const systemPrompt = `You are Annie, an expert BD intelligence assistant for ${profile?.full_name || 'a recruiter'} at ${profile?.firm_name || 'their recruitment firm'}.
Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.

You help with: BD strategy, outreach messages, market intelligence, interview prep, candidate pitches, objection handling, and anything recruitment business development related.
Be specific, actionable and concise. No waffle.`

      const resp = await fetch('/.netlify/functions/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
          systemOverride: systemPrompt,
          maxTokens: 1500,
        }),
      })

      const { text } = await resp.json()
      const assistantMsg = { role: 'assistant', content: text }
      setMessages(prev => [...prev, assistantMsg])
      await supabase.from('chat_messages').insert({ user_id: user.id, role: 'assistant', content: text })
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }])
    } finally {
      setLoading(false)
    }
  }

  const QUICK = ['Draft an outreach email to a new prospect', 'Help me prepare for a BD call', 'What should I say to re-engage a cold contact?', 'Write a LinkedIn message for a warm lead']

  return (
    <div className="flex flex-col h-screen max-h-screen p-8 pb-0">
      <div className="mb-4">
        <h1 className="text-3xl font-bold text-navy">Ask Annie</h1>
        <p className="text-gray-500 mt-1">Your personal BD intelligence assistant</p>
      </div>

      {messages.length === 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2">
          {QUICK.map(q => (
            <button key={q} onClick={() => { setInput(q); }} className="card p-3 text-left text-sm text-gray-600 hover:border-gold hover:text-navy transition-all border border-gray-100">
              {q}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap
              ${m.role === 'user' ? 'bg-navy text-white rounded-br-sm' : 'bg-white border border-gray-100 text-gray-700 rounded-bl-sm shadow-sm'}`}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
              <div className="flex gap-1">
                {[0,1,2].map(i => <div key={i} className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />)}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="py-4 border-t border-gray-100 bg-page-bg">
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="Ask Annie anything..." value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()} />
          <button onClick={send} disabled={loading || !input.trim()} className="btn-primary px-5">Send</button>
        </div>
      </div>
    </div>
  )
}

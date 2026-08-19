import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function Insights() {
  const [topics, setTopics] = useState([])
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('topics')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [{ data: topicData, error: topicErr }, { data: convoData, error: convoErr }] = await Promise.all([
        supabase.rpc('get_support_insights'),
        supabase.rpc('get_support_conversations'),
      ])
      if (topicErr) throw topicErr
      if (convoErr) throw convoErr
      setTopics(topicData || [])
      setConversations(convoData || [])
    } catch (err) {
      setError(err.message || 'Could not load insights.')
    } finally {
      setLoading(false)
    }
  }

  const maxCount = Math.max(1, ...topics.map(t => Number(t.occurrences)))

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-navy">Customer insights</h1>
        <p className="text-gray-500 mt-1">What customers are asking Annie support, across every account</p>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>}

      <div className="flex gap-2 mb-5">
        <button onClick={() => setTab('topics')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'topics' ? 'bg-navy text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>Topics</button>
        <button onClick={() => setTab('conversations')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'conversations' ? 'bg-navy text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>Recent conversations</button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" /></div>
      ) : tab === 'topics' ? (
        topics.length === 0 ? (
          <div className="card p-12 text-center">
            <h3 className="font-bold text-navy mb-1">No support questions yet</h3>
            <p className="text-gray-500 text-sm max-w-sm mx-auto">As customers use the support chat, common topics will show up here so you can see what's confusing people.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {topics.map(t => (
              <div key={t.topic} className="card p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-navy text-sm capitalize">{t.topic}</span>
                  <span className="text-xs text-gray-400">{t.occurrences} time{t.occurrences === 1 ? '' : 's'} · last {new Date(t.last_seen).toLocaleDateString('en-GB')}</span>
                </div>
                <div className="w-full bg-page-bg rounded-full h-2 mb-2">
                  <div className="bg-gold h-2 rounded-full" style={{ width: `${(Number(t.occurrences) / maxCount) * 100}%` }} />
                </div>
                <p className="text-xs text-gray-500 italic">"{t.sample_content}"</p>
              </div>
            ))}
          </div>
        )
      ) : (
        conversations.length === 0 ? (
          <div className="card p-12 text-center">
            <h3 className="font-bold text-navy mb-1">No conversations yet</h3>
          </div>
        ) : (
          <div className="space-y-2">
            {conversations.map((c, i) => (
              <div key={i} className={`card p-3.5 ${c.role === 'user' ? 'border-l-4 border-gold' : 'opacity-70'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-navy">{c.firm_name || 'Unknown firm'}</span>
                  <span className="text-[11px] text-gray-400">{new Date(c.created_at).toLocaleString('en-GB')}</span>
                </div>
                <p className="text-xs text-gray-600">{c.content}</p>
                {c.topic && <span className="inline-block mt-1.5 text-[10px] bg-yellow-50 text-navy px-2 py-0.5 rounded-full font-medium capitalize">{c.topic}</span>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import AdminOverview from './AdminOverview'

export default function Insights() {
  const [topics, setTopics] = useState([])
  const [conversations, setConversations] = useState([])
  const [errors, setErrors] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 2026-08-24: "Overview" (AdminOverview.jsx — MRR, accounts, signup
  // funnel, at-risk accounts, OpEx, platform health) is now the default
  // tab. Topics/conversations/errors are unchanged below it, still their
  // own tab each, still loaded eagerly the same way they always were —
  // Overview loads its own data independently inside AdminOverview so
  // switching to it never waits on the support-insights RPCs below.
  const [tab, setTab] = useState('overview')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const [{ data: topicData, error: topicErr }, { data: convoData, error: convoErr }, { data: errorData, error: errorErr }] = await Promise.all([
        supabase.rpc('get_support_insights'),
        supabase.rpc('get_support_conversations'),
        supabase.rpc('get_error_logs'),
      ])
      if (topicErr) throw topicErr
      if (convoErr) throw convoErr
      if (errorErr) throw errorErr
      setTopics(topicData || [])
      setConversations(convoData || [])
      setErrors(errorData || [])
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
        <h1 className="text-3xl font-bold text-navy">{tab === 'overview' ? 'Operator dashboard' : 'Customer insights'}</h1>
        <p className="text-gray-500 mt-1">
          {tab === 'overview' ? 'Annie, across every customer' : 'What customers are asking Annie support, across every account'}
        </p>
      </div>

      <ErrorBanner>{error}</ErrorBanner>

      <div className="flex gap-2 mb-5">
        <button onClick={() => setTab('overview')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'overview' ? 'bg-navy text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>Overview</button>
        <button onClick={() => setTab('topics')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'topics' ? 'bg-navy text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>Topics</button>
        <button onClick={() => setTab('conversations')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'conversations' ? 'bg-navy text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>Recent conversations</button>
        <button onClick={() => setTab('errors')} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === 'errors' ? 'bg-navy text-white' : 'bg-white border border-gray-200 text-gray-600'}`}>
          Errors{errors.length > 0 && <span className="ml-1.5 text-xs opacity-75">({errors.length})</span>}
        </button>
      </div>

      {tab === 'overview' ? (
        <AdminOverview onOpenErrors={() => setTab('errors')} />
      ) : loading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
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
      ) : tab === 'conversations' ? (
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
      ) : (
        errors.length === 0 ? (
          <div className="card p-12 text-center">
            <h3 className="font-bold text-navy mb-1">No errors logged</h3>
            <p className="text-gray-500 text-sm max-w-sm mx-auto">Client and server errors will show up here as soon as anything breaks.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {errors.map(e => (
              <div key={e.id} className="card p-3.5 border-l-4 border-red-400">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-navy">
                    {e.source === 'function' ? e.fn_name || 'function' : 'client'}
                  </span>
                  <span className="text-[11px] text-gray-400">{new Date(e.created_at).toLocaleString('en-GB')}</span>
                </div>
                <p className="text-xs text-red-700">{e.message}</p>
                {e.url && <p className="text-[11px] text-gray-400 mt-1 truncate">{e.url}</p>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

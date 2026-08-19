import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import InfoTip from './InfoTip'

const TYPE_ICONS = { job_move: '🚀', funding: '💰', news: '📰', expansion: '🌍', leadership: '👔', other: '📌' }
const TYPE_LABELS = { job_move: 'Job Move', funding: 'Funding', news: 'News', expansion: 'Expansion', leadership: 'Leadership Change', other: 'Other' }

export default function Signals() {
  const { user } = useAuth()
  const [signals, setSignals] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { load() }, [user])

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('signals').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
    setSignals(data || [])
    setLoading(false)
  }

  async function markActioned(id) {
    await supabase.from('signals').update({ is_actioned: true, actioned_at: new Date().toISOString() }).eq('id', id)
    setSignals(prev => prev.map(s => s.id === id ? { ...s, is_actioned: true } : s))
  }

  const active = signals.filter(s => !s.is_actioned)
  const done = signals.filter(s => s.is_actioned)

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-navy flex items-center">
          Signals
          <InfoTip text="A signal is a BD trigger Annie has spotted, like a job move, funding round, or leadership change at one of your contacts or target companies. She generates outreach ideas from these." />
        </h1>
        <p className="text-gray-500 mt-1">{active.length} active triggers waiting for action</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" /></div>
      ) : signals.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🔔</div>
          <h3 className="font-bold text-navy mb-1">No signals yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-1">Signals appear here automatically once Annie has contacts to monitor, things like job moves, funding rounds, leadership changes and expansions.</p>
          <p className="text-gray-400 text-xs max-w-sm mx-auto">Haven't imported your contacts yet? Head to Contacts to bring in your LinkedIn connections so Annie has something to watch.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Active Signals</h2>
              <div className="space-y-3">
                {active.map(s => (
                  <div key={s.id} className="card p-4 border-l-4 border-gold">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <span className="text-2xl">{TYPE_ICONS[s.type] || '📌'}</span>
                        <div>
                          <div className="flex items-center gap-2 mb-0.5">
                            <h3 className="font-bold text-navy text-sm">{s.title}</h3>
                            <span className="text-xs bg-amber-100 text-amber-700 font-semibold px-2 py-0.5 rounded-full">{TYPE_LABELS[s.type] || s.type}</span>
                          </div>
                          {s.company && <p className="text-xs text-gold font-semibold mb-1">{s.company}</p>}
                          {s.description && <p className="text-sm text-gray-600">{s.description}</p>}
                          <p className="text-xs text-gray-400 mt-1">{new Date(s.created_at).toLocaleDateString('en-GB')}</p>
                        </div>
                      </div>
                      <button onClick={() => markActioned(s.id)} className="btn-primary text-xs px-3 py-1.5 flex-shrink-0">
                        Mark done
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {done.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Actioned</h2>
              <div className="space-y-2">
                {done.map(s => (
                  <div key={s.id} className="card p-4 opacity-60">
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{TYPE_ICONS[s.type] || '📌'}</span>
                      <div>
                        <h3 className="font-semibold text-navy text-sm line-through">{s.title}</h3>
                        {s.company && <p className="text-xs text-gray-400">{s.company}</p>}
                      </div>
                      <span className="ml-auto text-xs text-green-600 font-semibold">Done</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

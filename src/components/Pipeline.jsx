import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import InfoTip from './InfoTip'

const STAGES = ['prospect', 'approached', 'meeting_booked', 'pitch_sent', 'negotiating', 'won', 'lost']
const STAGE_LABELS = { prospect: 'Prospect', approached: 'Approached', meeting_booked: 'Meeting Booked', pitch_sent: 'Pitch Sent', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' }
const STAGE_COLORS = { prospect: 'bg-gray-100 text-gray-600', approached: 'bg-blue-100 text-blue-700', meeting_booked: 'bg-purple-100 text-purple-700', pitch_sent: 'bg-amber-100 text-amber-700', negotiating: 'bg-orange-100 text-orange-700', won: 'bg-green-100 text-green-700', lost: 'bg-red-100 text-red-700' }
const EMPTY = { company: '', role: '', stage: 'prospect', value: '', probability: 25, notes: '', next_action: '', next_action_date: '' }

export default function Pipeline() {
  const { user } = useAuth()
  const [deals, setDeals] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [user])

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('deals').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
    setDeals(data || [])
    setLoading(false)
  }

  function openAdd() { setForm(EMPTY); setEditId(null); setShowModal(true) }
  function openEdit(d) { setForm({ company: d.company, role: d.role || '', stage: d.stage, value: d.value || '', probability: d.probability || 25, notes: d.notes || '', next_action: d.next_action || '', next_action_date: d.next_action_date || '' }); setEditId(d.id); setShowModal(true) }

  async function save() {
    setSaving(true)
    const payload = { ...form, value: parseFloat(form.value) || 0, probability: parseInt(form.probability) || 0 }
    if (editId) await supabase.from('deals').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', editId)
    else await supabase.from('deals').insert({ ...payload, user_id: user.id })
    await load()
    setShowModal(false)
    setSaving(false)
  }

  async function del(id) {
    if (!confirm('Delete this deal?')) return
    await supabase.from('deals').delete().eq('id', id)
    setDeals(prev => prev.filter(d => d.id !== id))
  }

  const totalValue = deals.filter(d => d.stage !== 'lost').reduce((sum, d) => sum + (d.value || 0), 0)
  const wonValue = deals.filter(d => d.stage === 'won').reduce((sum, d) => sum + (d.value || 0), 0)

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            BD Pipeline
            <InfoTip text="Track every deal from first contact to signed client here. Move deals through stages as conversations progress, and set a probability to estimate what's likely to close." />
          </h1>
          <p className="text-gray-500 mt-1">{deals.length} deals tracked</p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ Add Deal</button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Pipeline Value', value: `£${totalValue.toLocaleString()}`, color: 'text-navy' },
          { label: 'Won', value: `£${wonValue.toLocaleString()}`, color: 'text-green-600' },
          { label: 'Active Deals', value: deals.filter(d => !['won','lost'].includes(d.stage)).length, color: 'text-navy' },
        ].map(s => (
          <div key={s.label} className="card p-4">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-gray-500 text-sm mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" /></div>
      ) : deals.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">📈</div>
          <h3 className="font-bold text-navy mb-1">No deals yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">When a conversation with a contact turns into a real opportunity, add it here to track it through to close.</p>
          <button onClick={openAdd} className="btn-primary">Add your first deal</button>
        </div>
      ) : (
        <div className="space-y-3">
          {deals.map(d => (
            <div key={d.id} className="card p-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="font-bold text-navy">{d.company}</h3>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STAGE_COLORS[d.stage]}`}>{STAGE_LABELS[d.stage]}</span>
                  </div>
                  {d.role && <p className="text-sm text-gray-500 mb-1">{d.role}</p>}
                  {d.next_action && <p className="text-sm text-gray-600">Next: {d.next_action}</p>}
                </div>
                <div className="text-right flex-shrink-0">
                  {d.value > 0 && <div className="font-bold text-navy">£{Number(d.value).toLocaleString()}</div>}
                  <div className="text-xs text-gray-400 mt-0.5">{d.probability}% probability</div>
                  <div className="flex gap-2 justify-end mt-2">
                    <button onClick={() => openEdit(d)} className="text-xs text-gold font-semibold hover:underline">Edit</button>
                    <button onClick={() => del(d.id)} className="text-xs text-red-400 font-semibold hover:underline">Delete</button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-navy mb-4">{editId ? 'Edit Deal' : 'Add Deal'}</h2>
            <div className="space-y-3">
              {[['company','Company *','text'],['role','Role/Position','text'],['next_action','Next Action','text']].map(([f,l,t]) => (
                <div key={f}><label className="label">{l}</label><input className="input" type={t} value={form[f]} onChange={e => setForm(p => ({ ...p, [f]: e.target.value }))} /></div>
              ))}
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Value (£)</label><input className="input" type="number" value={form.value} onChange={e => setForm(p => ({ ...p, value: e.target.value }))} /></div>
                <div><label className="label">Probability (%)</label><input className="input" type="number" min="0" max="100" value={form.probability} onChange={e => setForm(p => ({ ...p, probability: e.target.value }))} /></div>
              </div>
              <div><label className="label">Stage</label>
                <select className="input" value={form.stage} onChange={e => setForm(p => ({ ...p, stage: e.target.value }))}>
                  {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                </select>
              </div>
              <div><label className="label">Next action date</label><input className="input" type="date" value={form.next_action_date} onChange={e => setForm(p => ({ ...p, next_action_date: e.target.value }))} /></div>
              <div><label className="label">Notes</label><textarea className="input resize-none" rows={3} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} /></div>
            </div>
            <div className="flex gap-3 justify-end mt-5">
              <button onClick={() => setShowModal(false)} className="btn-ghost">Cancel</button>
              <button onClick={save} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

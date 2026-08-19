import React, { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import InfoTip from './InfoTip'

const PRIORITY_COLOR = {
  high: 'bg-red-100 text-red-700',
  normal: 'bg-blue-100 text-blue-700',
  low: 'bg-gray-100 text-gray-500',
}

const EMPTY = { title: '', notes: '', due_date: '', priority: 'normal', contact_id: '', candidate_id: '' }

export default function Tasks() {
  const { user } = useAuth()
  const [tasks, setTasks] = useState([])
  const [contacts, setContacts] = useState([])
  const [candidates, setCandidates] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showDone, setShowDone] = useState(false)

  useEffect(() => { load() }, [user])

  async function load() {
    setLoading(true)
    const [{ data: t }, { data: c }, { data: cd }] = await Promise.all([
      supabase.from('bd_tasks').select('*, contacts(name, company), candidates(name)').eq('user_id', user.id).order('due_date', { ascending: true, nullsFirst: false }),
      supabase.from('contacts').select('id, name, company').eq('user_id', user.id).order('name'),
      supabase.from('candidates').select('id, name').eq('user_id', user.id).order('name'),
    ])
    setTasks(t || [])
    setContacts(c || [])
    setCandidates(cd || [])
    setLoading(false)
  }

  const { overdue, today, upcoming, noDate, done } = useMemo(() => {
    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)
    const open = tasks.filter(t => t.status !== 'done')
    const done = tasks.filter(t => t.status === 'done')
    const overdue = open.filter(t => t.due_date && t.due_date < todayStr)
    const today = open.filter(t => t.due_date === todayStr)
    const upcoming = open.filter(t => t.due_date && t.due_date > todayStr)
    const noDate = open.filter(t => !t.due_date)
    return { overdue, today, upcoming, noDate, done }
  }, [tasks])

  function openAdd() { setForm(EMPTY); setEditId(null); setError(''); setShowModal(true) }
  function openEdit(t) {
    setForm({
      title: t.title || '', notes: t.notes || '', due_date: t.due_date || '',
      priority: t.priority || 'normal', contact_id: t.contact_id || '', candidate_id: t.candidate_id || '',
    })
    setEditId(t.id)
    setError('')
    setShowModal(true)
  }

  async function save() {
    if (!form.title.trim()) return setError('Title is required')
    setSaving(true)
    setError('')
    try {
      const row = {
        title: form.title.trim(),
        notes: form.notes.trim() || null,
        due_date: form.due_date || null,
        priority: form.priority,
        contact_id: form.contact_id || null,
        candidate_id: form.candidate_id || null,
        updated_at: new Date().toISOString(),
      }
      if (editId) {
        await supabase.from('bd_tasks').update(row).eq('id', editId)
      } else {
        await supabase.from('bd_tasks').insert({ ...row, user_id: user.id })
      }
      await load()
      setShowModal(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function toggleDone(t) {
    const status = t.status === 'done' ? 'open' : 'done'
    setTasks(prev => prev.map(x => x.id === t.id ? { ...x, status } : x))
    await supabase.from('bd_tasks').update({ status, updated_at: new Date().toISOString() }).eq('id', t.id)
  }

  async function del(id) {
    if (!confirm('Delete this task?')) return
    await supabase.from('bd_tasks').delete().eq('id', id)
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  function TaskRow({ t }) {
    const isDone = t.status === 'done'
    return (
      <div className="card p-3.5 flex items-start gap-3">
        <button
          onClick={() => toggleDone(t)}
          className={`mt-0.5 w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all ${isDone ? 'bg-gold border-gold' : 'border-gray-300 hover:border-gold'}`}
        >
          {isDone && <span className="text-white text-[10px]">✓</span>}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`font-semibold text-sm ${isDone ? 'text-gray-400 line-through' : 'text-navy'}`}>{t.title}</span>
            {t.priority && t.priority !== 'normal' && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase ${PRIORITY_COLOR[t.priority]}`}>{t.priority}</span>
            )}
          </div>
          {(t.contacts?.name || t.candidates?.name) && (
            <p className="text-xs text-gray-500 mt-0.5">
              {t.contacts?.name && `👤 ${t.contacts.name}${t.contacts.company ? ' · ' + t.contacts.company : ''}`}
              {t.candidates?.name && `🧑‍💼 ${t.candidates.name}`}
            </p>
          )}
          {t.notes && <p className="text-xs text-gray-500 mt-1">{t.notes}</p>}
          {t.due_date && <p className={`text-[11px] font-semibold mt-1 ${!isDone && t.due_date < new Date().toISOString().slice(0,10) ? 'text-red-500' : 'text-gray-400'}`}>Due {new Date(t.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</p>}
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <button onClick={() => openEdit(t)} className="text-xs text-gold font-semibold hover:underline">Edit</button>
          <button onClick={() => del(t.id)} className="text-xs text-red-400 font-semibold hover:underline">Delete</button>
        </div>
      </div>
    )
  }

  const totalOpen = overdue.length + today.length + upcoming.length + noDate.length

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            Tasks
            <InfoTip text="Keep track of follow-ups and to-dos, optionally linked to a contact or candidate, so nothing falls through the cracks." />
          </h1>
          <p className="text-gray-500 mt-1">{totalOpen} open{overdue.length > 0 ? `, ${overdue.length} overdue` : ''}</p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ Add Task</button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" /></div>
      ) : tasks.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">✅</div>
          <h3 className="font-bold text-navy mb-1">No tasks yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Add follow-ups and to-dos here, link them to a contact or candidate if relevant.</p>
          <button onClick={openAdd} className="btn-primary">Add a task</button>
        </div>
      ) : (
        <div className="space-y-6">
          {overdue.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-red-500 uppercase tracking-wider mb-3">Overdue</h2>
              <div className="space-y-2">{overdue.map(t => <TaskRow key={t.id} t={t} />)}</div>
            </div>
          )}
          {today.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Today</h2>
              <div className="space-y-2">{today.map(t => <TaskRow key={t.id} t={t} />)}</div>
            </div>
          )}
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Upcoming</h2>
              <div className="space-y-2">{upcoming.map(t => <TaskRow key={t.id} t={t} />)}</div>
            </div>
          )}
          {noDate.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">No due date</h2>
              <div className="space-y-2">{noDate.map(t => <TaskRow key={t.id} t={t} />)}</div>
            </div>
          )}
          {done.length > 0 && (
            <div>
              <button onClick={() => setShowDone(s => !s)} className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3 hover:text-gray-600">
                {showDone ? '▾' : '▸'} Done ({done.length})
              </button>
              {showDone && <div className="space-y-2">{done.map(t => <TaskRow key={t.id} t={t} />)}</div>}
            </div>
          )}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4 py-8">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-navy mb-4">{editId ? 'Edit Task' : 'Add Task'}</h2>
            {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{error}</div>}
            <div className="space-y-3">
              <div>
                <label className="label">Title *</label>
                <input className="input" value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="e.g. Follow up on proposal" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Due date</label>
                  <input className="input" type="date" value={form.due_date} onChange={e => setForm(p => ({ ...p, due_date: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Priority</label>
                  <select className="input" value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}>
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Contact</label>
                  <select className="input" value={form.contact_id} onChange={e => setForm(p => ({ ...p, contact_id: e.target.value }))}>
                    <option value="">None</option>
                    {contacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ''}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Candidate</label>
                  <select className="input" value={form.candidate_id} onChange={e => setForm(p => ({ ...p, candidate_id: e.target.value }))}>
                    <option value="">None</option>
                    {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea className="input resize-none" rows={2} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
              </div>
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

import React, { useState, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import InfoTip from './InfoTip'
import ConfirmDialog from './ConfirmDialog'

const TYPE_LABEL = { call: 'Call', video: 'Video', in_person: 'In person' }
const TYPE_ICON = { call: '📞', video: '💻', in_person: '🤝' }

const EMPTY = { title: '', meeting_type: 'call', meeting_date: '', contact_id: '', outcome: '', next_steps: '', follow_up_date: '', notes: '' }

function toLocalInput(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function Meetings() {
  const { user } = useAuth()
  const location = useLocation()
  const [meetings, setMeetings] = useState([])
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  useEffect(() => { load() }, [user])
  useEffect(() => { if (location.state?.autoOpenAdd) openAdd() }, [location.state])

  async function load() {
    setLoading(true)
    const [{ data: m }, { data: c }] = await Promise.all([
      supabase.from('meetings').select('*, contacts(name, company)').eq('user_id', user.id).order('meeting_date', { ascending: false }),
      supabase.from('contacts').select('id, name, company').eq('user_id', user.id).order('name'),
    ])
    setMeetings(m || [])
    setContacts(c || [])
    setLoading(false)
  }

  const { upcoming, past } = useMemo(() => {
    const now = Date.now()
    const upcoming = meetings.filter(m => new Date(m.meeting_date).getTime() >= now).sort((a, b) => new Date(a.meeting_date) - new Date(b.meeting_date))
    const past = meetings.filter(m => new Date(m.meeting_date).getTime() < now)
    return { upcoming, past }
  }, [meetings])

  function openAdd() { setForm({ ...EMPTY, meeting_date: toLocalInput(new Date().toISOString()) }); setEditId(null); setError(''); setShowModal(true) }
  function openEdit(m) {
    setForm({
      title: m.title || '', meeting_type: m.meeting_type || 'call', meeting_date: toLocalInput(m.meeting_date),
      contact_id: m.contact_id || '', outcome: m.outcome || '', next_steps: m.next_steps || '',
      follow_up_date: m.follow_up_date || '', notes: m.notes || '',
    })
    setEditId(m.id)
    setError('')
    setShowModal(true)
  }

  async function save() {
    if (!form.title.trim()) return setError('Title is required')
    if (!form.meeting_date) return setError('Date and time is required')
    setSaving(true)
    setError('')
    try {
      const row = {
        title: form.title.trim(),
        meeting_type: form.meeting_type,
        meeting_date: new Date(form.meeting_date).toISOString(),
        contact_id: form.contact_id || null,
        outcome: form.outcome.trim() || null,
        next_steps: form.next_steps.trim() || null,
        follow_up_date: form.follow_up_date || null,
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      }
      if (editId) {
        const { error: err } = await supabase.from('meetings').update(row).eq('id', editId)
        if (err) throw err
      } else {
        const { error: err } = await supabase.from('meetings').insert({ ...row, user_id: user.id })
        if (err) throw err
      }
      await load()
      setShowModal(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function del(id) {
    setListError('')
    const { error: err } = await supabase.from('meetings').delete().eq('id', id)
    if (err) return setListError(err.message)
    setMeetings(prev => prev.filter(m => m.id !== id))
  }

  function MeetingCard({ m }) {
    return (
      <div className="card p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-3">
            <span className="text-xl">{TYPE_ICON[m.meeting_type] || '📌'}</span>
            <div>
              <h3 className="font-bold text-navy text-sm">{m.title}</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {new Date(m.meeting_date).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                {m.contacts?.name && ` · ${m.contacts.name}${m.contacts.company ? ' (' + m.contacts.company + ')' : ''}`}
              </p>
              {m.outcome && <p className="text-xs text-gray-600 mt-1.5"><span className="font-semibold text-gray-500">Outcome: </span>{m.outcome}</p>}
              {m.next_steps && <p className="text-xs text-gray-600 mt-1"><span className="font-semibold text-gray-500">Next steps: </span>{m.next_steps}</p>}
              {m.follow_up_date && <p className="text-[11px] text-gold font-semibold mt-1">Follow up {new Date(m.follow_up_date).toLocaleDateString('en-GB')}</p>}
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={() => openEdit(m)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
            <button onClick={() => setConfirmDeleteId(m.id)} className="text-xs text-red-400 font-semibold hover:underline">Delete</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            Meetings
            <InfoTip text="Log every BD call, video call and in-person meeting, with outcomes and next steps, so nothing said in a conversation gets lost." />
          </h1>
          <p className="text-gray-500 mt-1">{meetings.length} logged, {upcoming.length} upcoming</p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ Log Meeting</button>
      </div>

      {listError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-4">{listError}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-20"><div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" /></div>
      ) : meetings.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">📅</div>
          <h3 className="font-bold text-navy mb-1">No meetings logged yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Log your BD calls and meetings here, outcomes and next steps included, so your pipeline reflects what's actually being said.</p>
          <button onClick={openAdd} className="btn-primary">Log a meeting</button>
        </div>
      ) : (
        <div className="space-y-6">
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Upcoming</h2>
              <div className="space-y-3">{upcoming.map(m => <MeetingCard key={m.id} m={m} />)}</div>
            </div>
          )}
          {past.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Past</h2>
              <div className="space-y-3">{past.map(m => <MeetingCard key={m.id} m={m} />)}</div>
            </div>
          )}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4 py-8">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-navy mb-4">{editId ? 'Edit Meeting' : 'Log Meeting'}</h2>
            {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{error}</div>}
            <form onSubmit={e => { e.preventDefault(); save() }}>
              <div className="space-y-3">
                <div>
                  <label className="label">Title *</label>
                  <input className="input" required value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="e.g. Intro call with Wio Bank" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Type</label>
                    <select className="input" value={form.meeting_type} onChange={e => setForm(p => ({ ...p, meeting_type: e.target.value }))}>
                      {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Date & time *</label>
                    <input className="input" type="datetime-local" required value={form.meeting_date} onChange={e => setForm(p => ({ ...p, meeting_date: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <label className="label">Contact</label>
                  <select className="input" value={form.contact_id} onChange={e => setForm(p => ({ ...p, contact_id: e.target.value }))}>
                    <option value="">Not linked to a contact</option>
                    {contacts.map(c => <option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ''}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Outcome</label>
                  <textarea className="input resize-none" rows={2} value={form.outcome} onChange={e => setForm(p => ({ ...p, outcome: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Next steps</label>
                  <textarea className="input resize-none" rows={2} value={form.next_steps} onChange={e => setForm(p => ({ ...p, next_steps: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Follow-up date</label>
                  <input className="input" type="date" value={form.follow_up_date} onChange={e => setForm(p => ({ ...p, follow_up_date: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Notes</label>
                  <textarea className="input resize-none" rows={2} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                </div>
              </div>
              <div className="flex gap-3 justify-end mt-5">
                <button type="button" onClick={() => setShowModal(false)} className="btn-ghost">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => del(confirmDeleteId)}
        title="Delete meeting?"
        message="This can't be undone."
        confirmLabel="Delete"
      />
    </div>
  )
}

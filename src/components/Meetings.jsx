import React, { useState, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { listMeetingsWithContacts, createMeeting, updateMeeting, deleteMeeting } from '../lib/data/meetings'
import { listContactsMinimal } from '../lib/data/contacts'
import { listCandidatesMinimal, appendCandidateNote } from '../lib/data/candidates'
import { createContactNote } from '../lib/data/contactNotes'
import ConfirmDialog from './ConfirmDialog'
import Modal from './Modal'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import ContactSearchSelect from './ContactSearchSelect'

// 'interview' added 2026-09-03 — the Job Pipeline feature's own interview
// scheduling (updatePipelineLinkInterview in pipelineLinks.js) creates a
// real meetings row of this type so it appears here too, not just on
// Overview's Today's schedule.
const TYPE_LABEL = { call: 'Call', video: 'Video', in_person: 'In person', interview: 'Interview' }
const TYPE_ICON = { call: '📞', video: '💻', in_person: '🤝', interview: '🎯' }

// 2026-09-08, gap-analysis batch 9 ("interview notes typed on the Meetings
// page don't show up anywhere for that candidate"): candidate_id joins
// contact_id as a second, independent link a meeting can carry — the
// underlying `meetings` table already had this column (interviews created
// via updatePipelineLinkInterview in pipelineLinks.js set it), this form
// just never surfaced it.
const EMPTY = { title: '', meeting_type: 'call', meeting_date: '', contact_id: '', candidate_id: '', outcome: '', next_steps: '', follow_up_date: '', notes: '' }

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
  const [candidates, setCandidates] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [editId, setEditId] = useState(null)
  // 2026-09-01: the meeting's own Outcome/Next steps as they were BEFORE
  // this edit — save() diffs against these so re-saving a meeting whose
  // outcome/next_steps didn't actually change doesn't append a duplicate
  // identical note to the contact every time (e.g. just fixing the date).
  const [editingOriginal, setEditingOriginal] = useState({ outcome: '', next_steps: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [listError, setListError] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  useEffect(() => { load() }, [user])
  useEffect(() => { if (location.state?.autoOpenAdd) openAdd() }, [location.state])

  async function load() {
    setLoading(true)
    setListError('')
    // 2026-08-24 Task 2: routed through lib/data/* (previously duplicated
    // inline here) so this table's query shape lives in exactly one place.
    // 2026-08-26 audit fix: each of these now throws on a real Supabase
    // error instead of quietly returning [] — previously that looked
    // identical to "you have no meetings/contacts yet".
    try {
      const [m, c, cd] = await Promise.all([
        listMeetingsWithContacts(user.id),
        listContactsMinimal(user.id),
        listCandidatesMinimal(user.id),
      ])
      setMeetings(m)
      setContacts(c)
      setCandidates(cd)
    } catch (err) {
      setListError(err.message || 'Could not load your meetings. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const { upcoming, past } = useMemo(() => {
    const now = Date.now()
    const upcoming = meetings.filter(m => new Date(m.meeting_date).getTime() >= now).sort((a, b) => new Date(a.meeting_date) - new Date(b.meeting_date))
    const past = meetings.filter(m => new Date(m.meeting_date).getTime() < now)
    return { upcoming, past }
  }, [meetings])

  function openAdd() { setForm({ ...EMPTY, meeting_date: toLocalInput(new Date().toISOString()) }); setEditId(null); setEditingOriginal({ outcome: '', next_steps: '' }); setError(''); setShowModal(true) }
  function openEdit(m) {
    setForm({
      title: m.title || '', meeting_type: m.meeting_type || 'call', meeting_date: toLocalInput(m.meeting_date),
      contact_id: m.contact_id || '', candidate_id: m.candidate_id || '', outcome: m.outcome || '', next_steps: m.next_steps || '',
      follow_up_date: m.follow_up_date || '', notes: m.notes || '',
    })
    setEditId(m.id)
    setEditingOriginal({ outcome: m.outcome || '', next_steps: m.next_steps || '' })
    setError('')
    setShowModal(true)
  }

  // 2026-09-01, Michael: "Same with outcome and next steps, that should be
  // the same as point 2 [the contact notes log], saves as a note next to
  // that contact." Only fires when the meeting is linked to a contact AND
  // outcome/next_steps actually changed from what was there before this
  // save — editing an unrelated field (the date, say) and re-saving
  // shouldn't append a duplicate note every time.
  //
  // 2026-09-08, gap-analysis batch 9 ("interview notes typed on the
  // Meetings page don't show up anywhere for that candidate"): a
  // candidate-linked meeting (every interview scheduled from the pipeline
  // board is one) used to fall straight through the `if (!contactId) return`
  // above and log nothing at all, anywhere — the recruiter's own typed
  // outcome/next steps just vanished the moment they clicked away. This adds
  // the same auto-log for candidateId, via appendCandidateNote (candidates
  // have no separate notes table, so it appends to their single notes
  // field instead — see that function's own header comment). A meeting can
  // in principle carry both a contact and a candidate; both get logged.
  async function logMeetingNoteIfChanged(contactId, candidateId, outcome, nextSteps) {
    const outcomeChanged = outcome.trim() !== editingOriginal.outcome.trim()
    const nextStepsChanged = nextSteps.trim() !== editingOriginal.next_steps.trim()
    if (!outcomeChanged && !nextStepsChanged) return
    const parts = []
    if (outcome.trim()) parts.push(`Meeting outcome: ${outcome.trim()}`)
    if (nextSteps.trim()) parts.push(`Next steps: ${nextSteps.trim()}`)
    if (!parts.length) return
    const body = parts.join('\n')
    if (contactId) {
      try {
        await createContactNote(contactId, user.id, body)
      } catch (err) {
        // Non-fatal — the meeting itself already saved successfully; losing
        // the auto-logged note shouldn't be reported as the save having
        // failed.
        console.error('[Meetings] could not log meeting note to contact:', err.message)
      }
    }
    if (candidateId) {
      try {
        await appendCandidateNote(candidateId, body)
      } catch (err) {
        console.error('[Meetings] could not log meeting note to candidate:', err.message)
      }
    }
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
        candidate_id: form.candidate_id || null,
        outcome: form.outcome.trim() || null,
        next_steps: form.next_steps.trim() || null,
        follow_up_date: form.follow_up_date || null,
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      }
      if (editId) {
        const { error: err } = await updateMeeting(editId, row)
        if (err) throw err
      } else {
        const { error: err } = await createMeeting(row, user.id)
        if (err) throw err
      }
      await logMeetingNoteIfChanged(form.contact_id, form.candidate_id, form.outcome, form.next_steps)
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
    const { error: err } = await deleteMeeting(id)
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
                {/* 2026-09-08, gap-analysis batch 9: every interview scheduled
                    from the pipeline board is a candidate_id-linked meeting
                    with no contact_id at all — this used to render with a
                    blank "who this was with" line. */}
                {m.candidates?.name && ` · ${m.candidates.name}`}
              </p>
              {m.outcome && <p className="text-xs text-gray-600 mt-1.5"><span className="font-semibold text-gray-500">Outcome: </span>{m.outcome}</p>}
              {m.next_steps && <p className="text-xs text-gray-600 mt-1"><span className="font-semibold text-gray-500">Next steps: </span>{m.next_steps}</p>}
              {m.follow_up_date && <p className="text-[11px] text-gold font-semibold mt-1">Follow up {new Date(m.follow_up_date).toLocaleDateString('en-GB')}</p>}
            </div>
          </div>
          {/* 2026-08-29 audit fix: same Delete-styled-like-a-routine-action
              issue fixed across the rest of the CRM this pass, applied here
              for consistency. */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => openEdit(m)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
            <div className="pl-2 ml-1 border-l border-gray-200">
              <button onClick={() => setConfirmDeleteId(m.id)} className="text-xs text-red-500 font-semibold hover:underline">Delete</button>
            </div>
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
          </h1>
          <p className="text-gray-500 mt-1">{meetings.length} logged, {upcoming.length} upcoming</p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ Log Meeting</button>
      </div>

      <ErrorBanner>{listError}</ErrorBanner>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Spinner /></div>
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

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editId ? 'Edit Meeting' : 'Log Meeting'} maxWidth="max-w-lg">
            <ErrorBanner>{error}</ErrorBanner>
            <form onSubmit={e => { e.preventDefault(); save() }}>
              <div className="space-y-3">
                <div>
                  <label className="label" htmlFor="meeting-title">Title *</label>
                  <input id="meeting-title" className="input" required value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="e.g. Intro call with Wio Bank" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label" htmlFor="meeting-type">Type</label>
                    <select id="meeting-type" className="input" value={form.meeting_type} onChange={e => setForm(p => ({ ...p, meeting_type: e.target.value }))}>
                      {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="meeting-date">Date & time *</label>
                    <input id="meeting-date" className="input" type="datetime-local" required value={form.meeting_date} onChange={e => setForm(p => ({ ...p, meeting_date: e.target.value }))} />
                  </div>
                </div>
                <div>
                  <label className="label" htmlFor="meeting-contact">Contact</label>
                  <ContactSearchSelect id="meeting-contact" contacts={contacts} value={form.contact_id} onChange={id => setForm(p => ({ ...p, contact_id: id }))} />
                </div>
                {/* 2026-09-08, gap-analysis batch 9 ("interview notes typed
                    on the Meetings page don't show up anywhere for that
                    candidate"): meetings could already carry a candidate_id
                    (every auto-scheduled interview does), this form just
                    never let a recruiter set or even see it. A plain select
                    rather than a second search component — this list is
                    usually far shorter than the contact list it sits next
                    to, and doesn't need its own dedicated component yet. */}
                <div>
                  <label className="label" htmlFor="meeting-candidate">Candidate</label>
                  <select id="meeting-candidate" className="input" value={form.candidate_id} onChange={e => setForm(p => ({ ...p, candidate_id: e.target.value }))}>
                    <option value="">No candidate linked</option>
                    {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="meeting-outcome">Outcome</label>
                  <textarea id="meeting-outcome" className="input resize-none" rows={2} value={form.outcome} onChange={e => setForm(p => ({ ...p, outcome: e.target.value }))} />
                </div>
                <div>
                  <label className="label" htmlFor="meeting-next-steps">Next steps</label>
                  <textarea id="meeting-next-steps" className="input resize-none" rows={2} value={form.next_steps} onChange={e => setForm(p => ({ ...p, next_steps: e.target.value }))} />
                </div>
                <div>
                  <label className="label" htmlFor="meeting-follow-up-date">Follow-up date</label>
                  <input id="meeting-follow-up-date" className="input" type="date" value={form.follow_up_date} onChange={e => setForm(p => ({ ...p, follow_up_date: e.target.value }))} />
                </div>
                <div>
                  <label className="label" htmlFor="meeting-notes">Notes</label>
                  <textarea id="meeting-notes" className="input resize-none" rows={2} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                </div>
              </div>
              <div className="flex gap-3 justify-end mt-5">
                <button type="button" onClick={() => setShowModal(false)} className="btn-ghost">Cancel</button>
                <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save'}</button>
              </div>
            </form>
      </Modal>

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

import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import InfoTip from './InfoTip'
import ConfirmDialog from './ConfirmDialog'
import { logSignalOutcome } from '../lib/signalOutcomes'
import { companiesMatch } from '../lib/companyMatch'
import Modal from './Modal'
import ErrorBanner from './ErrorBanner'

const STAGES = ['sourced', 'screening', 'shortlisted', 'presented', 'interviewing', 'offer', 'placed', 'rejected', 'withdrawn']
const STAGE_LABEL = { sourced: 'Sourced', screening: 'Screening', shortlisted: 'Shortlisted', presented: 'Presented', interviewing: 'Interviewing', offer: 'Offer', placed: 'Placed', rejected: 'Rejected', withdrawn: 'Withdrawn' }
const STAGE_COLOR = {
  sourced: 'bg-slate-100 text-slate-600',
  screening: 'bg-blue-100 text-blue-700',
  shortlisted: 'bg-purple-100 text-purple-700',
  presented: 'bg-amber-100 text-amber-700',
  interviewing: 'bg-orange-100 text-orange-700',
  offer: 'bg-emerald-100 text-emerald-700',
  placed: 'bg-yellow-100 text-gold',
  rejected: 'bg-red-100 text-red-600',
  withdrawn: 'bg-gray-100 text-gray-500',
}

const EMPTY = {
  name: '', role: '', company: '', location: '', industry: '', email: '', phone: '',
  curr_sal: '', want_sal: '', notice_period: '', availability: '', linkedin_url: '',
  status: 'sourced', source: '', follow_up_date: '', notes: '', job_id: '',
}

function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

export default function Candidates() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [candidates, setCandidates] = useState([])
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [cvFile, setCvFile] = useState(null)
  const [existingCvPath, setExistingCvPath] = useState(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [listError, setListError] = useState('')

  useEffect(() => { load() }, [user])

  async function load() {
    setLoading(true)
    const [{ data }, { data: j }] = await Promise.all([
      supabase.from('candidates').select('*, jobs(title, companies(name))').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('jobs').select('id, title, companies(name)').eq('user_id', user.id).in('status', ['active', 'onhold']).order('title'),
    ])
    setCandidates(data || [])
    setJobs(j || [])
    setLoading(false)
  }

  const metrics = useMemo(() => {
    const active = candidates.filter(c => !['placed', 'rejected', 'withdrawn'].includes(c.status))
    const interviewing = candidates.filter(c => ['interviewing', 'offer'].includes(c.status))
    const placed = candidates.filter(c => c.status === 'placed')
    return { total: candidates.length, active: active.length, interviewing: interviewing.length, placed: placed.length }
  }, [candidates])

  const filtered = filter === 'all' ? candidates : candidates.filter(c => c.status === filter)

  function openAdd() { setForm(EMPTY); setEditId(null); setCvFile(null); setExistingCvPath(null); setError(''); setShowModal(true) }
  function openEdit(c) {
    setForm({
      name: c.name || '', role: c.role || '', company: c.company || '', location: c.location || '', industry: c.industry || '',
      email: c.email || '', phone: c.phone || '', curr_sal: c.curr_sal || '', want_sal: c.want_sal || '',
      notice_period: c.notice_period || '', availability: c.availability || '', linkedin_url: c.linkedin_url || '',
      status: c.status || 'sourced', source: c.source || '', follow_up_date: c.follow_up_date || '', notes: c.notes || '', job_id: c.job_id || '',
    })
    setEditId(c.id)
    setCvFile(null)
    setExistingCvPath(c.cv_path || null)
    setError('')
    setShowModal(true)
  }

  // The single highest-value data point for the signal flywheel is a real
  // placement, but nobody's going to manually go link a candidate back to
  // the signal that started it. This infers it instead: the moment a
  // candidate's status flips to "placed", check whether Annie ever surfaced
  // a live signal for that same company, and if so, log it as the outcome.
  // Best-effort and company-name-fuzzy, not a guarantee, still far better
  // than having no placement data at all to eventually weight signals by.
  async function maybeLogPlacement(row, previousStatus) {
    if (row.status !== 'placed' || previousStatus === 'placed' || !row.company) return
    try {
      const { data: recentSignals } = await supabase
        .from('intelligence_signals')
        .select('id, company_name, signal_type')
        .eq('user_id', user.id)
        .order('found_at', { ascending: false })
        .limit(300)
      const match = (recentSignals || []).find(s => companiesMatch(s.company_name, row.company))
      if (match) logSignalOutcome(user, match, 'placed')
    } catch {
      // Best-effort, never let this block or fail the actual candidate save.
    }
  }

  async function save() {
    if (!form.name.trim()) return setError('Name is required')
    setSaving(true)
    setError('')
    try {
      let cvPath = existingCvPath
      if (cvFile) {
        const ext = cvFile.name.split('.').pop()
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabase.storage.from('candidate-cvs').upload(path, cvFile, { upsert: true, contentType: cvFile.type })
        if (upErr) throw new Error('CV upload failed: ' + upErr.message)
        cvPath = path
      }

      const row = {
        ...form,
        curr_sal: form.curr_sal ? parseInt(form.curr_sal) : null,
        want_sal: form.want_sal ? parseInt(form.want_sal) : null,
        follow_up_date: form.follow_up_date || null,
        job_id: form.job_id || null,
        cv_path: cvPath,
        updated_at: new Date().toISOString(),
      }

      const previousStatus = editId ? candidates.find(c => c.id === editId)?.status : null

      if (editId) {
        const { error: err } = await supabase.from('candidates').update(row).eq('id', editId)
        if (err) throw err
      } else {
        const { error: err } = await supabase.from('candidates').insert({ ...row, user_id: user.id })
        if (err) throw err
      }
      maybeLogPlacement(row, previousStatus)
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
    const { error: err } = await supabase.from('candidates').delete().eq('id', id)
    if (err) return setListError('Could not delete candidate: ' + err.message)
    setCandidates(prev => prev.filter(c => c.id !== id))
  }

  async function viewCv(path) {
    if (!path) return
    const { data, error } = await supabase.storage.from('candidate-cvs').createSignedUrl(path, 3600)
    if (error) return alert('Could not open CV: ' + error.message)
    window.open(data.signedUrl, '_blank')
  }

  function askAnnie(c) {
    const prefill = `Help me with ${c.name}, a candidate ${c.role ? `for ${c.role}` : ''}${c.company ? ` currently at ${c.company}` : ''}, stage: ${STAGE_LABEL[c.status] || c.status}. ${c.notes ? 'Notes: ' + c.notes : ''}`.trim()
    navigate('/dashboard/chat', { state: { prefill } })
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            Candidates
            <InfoTip text="Your candidate pipeline, from sourced through to placed. Attach a CV, track salary expectations and notice period, and hand off to Ask Annie for pitch help." />
          </h1>
          <p className="text-gray-500 mt-1">{metrics.total} candidates, {metrics.active} active</p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ Add Candidate</button>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card p-4">
          <div className="text-2xl font-bold text-navy">{metrics.total}</div>
          <div className="text-xs text-gray-500 mt-0.5">Total candidates</div>
          <div className="text-[11px] text-gray-400">{metrics.active} active</div>
        </div>
        <div className="card p-4">
          <div className="text-2xl font-bold text-navy">{metrics.interviewing}</div>
          <div className="text-xs text-gray-500 mt-0.5">Interviewing / offer</div>
          <div className="text-[11px] text-gray-400">hot pipeline</div>
        </div>
        <div className="card p-4">
          <div className="text-2xl font-bold text-navy">{metrics.placed}</div>
          <div className="text-xs text-gray-500 mt-0.5">Placed</div>
          <div className="text-[11px] text-gray-400">all time</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-6">
        <button onClick={() => setFilter('all')} className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${filter === 'all' ? 'bg-navy border-navy text-white' : 'border-gray-200 text-gray-600'}`}>All</button>
        {STAGES.map(s => (
          <button key={s} onClick={() => setFilter(s)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${filter === s ? 'bg-navy border-navy text-white' : 'border-gray-200 text-gray-600'}`}>
            {STAGE_LABEL[s]}
          </button>
        ))}
      </div>

      {listError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{listError}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🧑‍💼</div>
          <h3 className="font-bold text-navy mb-1">{filter === 'all' ? 'No candidates yet' : `No candidates in ${STAGE_LABEL[filter]}`}</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Add candidates as you source them, track them through to placement, and keep their CV attached.</p>
          {filter === 'all' && <button onClick={openAdd} className="btn-primary">Add a candidate</button>}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(c => (
            <div key={c.id} className={`card p-4 border-l-4 ${STAGE_COLOR[c.status]?.split(' ')[0]?.replace('bg-', 'border-') || 'border-gray-200'}`}>
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${STAGE_COLOR[c.status] || 'bg-gray-100 text-gray-500'}`}>
                  {initials(c.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-navy text-sm">{c.name}</h3>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${STAGE_COLOR[c.status] || 'bg-gray-100 text-gray-500'}`}>{STAGE_LABEL[c.status] || c.status}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">{[c.role, c.company].filter(Boolean).join(' · ')}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {c.want_sal && <div className="text-xs font-bold text-navy">AED {Number(c.want_sal).toLocaleString()}</div>}
                      {c.notice_period && <div className="text-[11px] text-gray-400">{c.notice_period} notice</div>}
                    </div>
                  </div>

                  {c.notes && <p className="text-xs text-gray-600 mt-1.5 line-clamp-2">{c.notes}</p>}
                  {c.jobs?.title && <p className="text-[11px] text-gold font-semibold mt-1">💼 {c.jobs.title}{c.jobs.companies?.name ? ` @ ${c.jobs.companies.name}` : ''}</p>}

                  <div className="flex items-center gap-2 flex-wrap mt-2.5">
                    {c.location && <span className="text-[10px] bg-page-bg text-gray-500 px-2 py-1 rounded-md">📍 {c.location}</span>}
                    {c.industry && <span className="text-[10px] bg-page-bg text-gray-500 px-2 py-1 rounded-md">🏢 {c.industry}</span>}
                    {c.linkedin_url && (
                      <a href={c.linkedin_url.startsWith('http') ? c.linkedin_url : `https://${c.linkedin_url}`} target="_blank" rel="noreferrer" className="text-[10px] font-semibold px-2 py-1 rounded-md bg-[#0077b5] text-white">LinkedIn</a>
                    )}
                    {c.email && <a href={`mailto:${c.email}`} className="text-[10px] font-semibold px-2 py-1 rounded-md border border-gray-200 text-gray-600">Email</a>}
                    {c.cv_path && <button onClick={() => viewCv(c.cv_path)} className="text-[10px] font-semibold px-2 py-1 rounded-md border border-green-300 text-green-700">📄 CV</button>}
                    <button onClick={() => openEdit(c)} className="text-[10px] font-semibold px-2 py-1 rounded-md border border-gray-200 text-gray-600">Edit</button>
                    <button onClick={() => askAnnie(c)} className="text-[10px] font-semibold px-2 py-1 rounded-md bg-navy text-gold">Ask Annie</button>
                    <button onClick={() => setConfirmDeleteId(c.id)} className="text-[10px] font-semibold px-2 py-1 rounded-md text-red-400 ml-auto">Delete</button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editId ? 'Edit Candidate' : 'Add Candidate'} maxWidth="max-w-2xl">
            <ErrorBanner>{error}</ErrorBanner>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="label">Name *</label>
                <input className="input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <label className="label">Role</label>
                <input className="input" value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))} />
              </div>
              <div>
                <label className="label">Current company</label>
                <input className="input" value={form.company} onChange={e => setForm(p => ({ ...p, company: e.target.value }))} />
              </div>
              <div>
                <label className="label">Location</label>
                <input className="input" value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))} />
              </div>
              <div>
                <label className="label">Industry</label>
                <input className="input" value={form.industry} onChange={e => setForm(p => ({ ...p, industry: e.target.value }))} />
              </div>
              <div>
                <label className="label">Email</label>
                <input className="input" type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
              </div>
              <div>
                <label className="label">Phone</label>
                <input className="input" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
              </div>
              <div>
                <label className="label">Current salary (AED)</label>
                <input className="input" type="number" value={form.curr_sal} onChange={e => setForm(p => ({ ...p, curr_sal: e.target.value }))} />
              </div>
              <div>
                <label className="label">Desired salary (AED)</label>
                <input className="input" type="number" value={form.want_sal} onChange={e => setForm(p => ({ ...p, want_sal: e.target.value }))} />
              </div>
              <div>
                <label className="label">Notice period</label>
                <input className="input" value={form.notice_period} onChange={e => setForm(p => ({ ...p, notice_period: e.target.value }))} />
              </div>
              <div>
                <label className="label">Availability</label>
                <input className="input" value={form.availability} onChange={e => setForm(p => ({ ...p, availability: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="label">LinkedIn URL</label>
                <input className="input" value={form.linkedin_url} onChange={e => setForm(p => ({ ...p, linkedin_url: e.target.value }))} />
              </div>
              <div>
                <label className="label">Stage</label>
                <select className="input" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                  {STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Source</label>
                <input className="input" value={form.source} onChange={e => setForm(p => ({ ...p, source: e.target.value }))} />
              </div>
              <div>
                <label className="label">Follow-up date</label>
                <input className="input" type="date" value={form.follow_up_date} onChange={e => setForm(p => ({ ...p, follow_up_date: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="label">Job / mandate they're being considered for</label>
                <select className="input" value={form.job_id} onChange={e => setForm(p => ({ ...p, job_id: e.target.value }))}>
                  <option value="">Not tied to a specific job</option>
                  {jobs.map(j => <option key={j.id} value={j.id}>{j.title}{j.companies?.name ? ` @ ${j.companies.name}` : ''}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="label">Notes</label>
                <textarea className="input resize-none" rows={3} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="label">CV</label>
                {existingCvPath && !cvFile ? (
                  <div className="flex items-center gap-2 bg-page-bg rounded-lg px-3 py-2">
                    <span className="text-xs text-gray-600 flex-1 truncate">CV on file</span>
                    <button type="button" onClick={() => viewCv(existingCvPath)} className="text-xs font-semibold text-gold-ink">View</button>
                    <button type="button" onClick={() => setExistingCvPath(null)} className="text-xs font-semibold text-red-400">Remove</button>
                  </div>
                ) : (
                  <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center">
                    <input type="file" accept=".pdf,.doc,.docx" onChange={e => setCvFile(e.target.files?.[0] || null)} className="text-xs" />
                    <p className="text-[11px] text-gray-400 mt-1">{cvFile ? cvFile.name + ' ready to upload' : 'PDF or Word doc, max 20MB'}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3 justify-end mt-5">
              <button onClick={() => setShowModal(false)} className="btn-ghost">Cancel</button>
              <button onClick={save} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save candidate'}</button>
            </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => del(confirmDeleteId)}
        title="Delete this candidate?"
        message="This can't be undone."
        confirmLabel="Delete"
      />
    </div>
  )
}

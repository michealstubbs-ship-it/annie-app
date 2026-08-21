import React, { useState, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import InfoTip from './InfoTip'
import JobFormModal from './JobFormModal'
import ConfirmDialog from './ConfirmDialog'

const STATUS_LABEL = { active: 'Active', onhold: 'On hold', filled: 'Filled', lost: 'Lost' }
const STATUS_COLOR = {
  active: 'bg-green-100 text-green-700',
  onhold: 'bg-amber-100 text-amber-700',
  filled: 'bg-yellow-100 text-gold',
  lost: 'bg-gray-100 text-gray-500',
}
const TYPE_LABEL = { permanent: 'Permanent', contract: 'Contract', interim: 'Interim' }

function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n) }

export default function Jobs() {
  const { user } = useAuth()
  const location = useLocation()
  const [jobs, setJobs] = useState([])
  const [candCounts, setCandCounts] = useState({})
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editJob, setEditJob] = useState(null)
  const [showClosed, setShowClosed] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [listError, setListError] = useState('')

  useEffect(() => { load() }, [user])
  useEffect(() => { if (location.state?.autoOpenAdd) openAdd() }, [location.state])

  async function load() {
    setLoading(true)
    const [{ data: j }, { data: c }] = await Promise.all([
      supabase.from('jobs').select('*, companies(name, industry, location)').eq('user_id', user.id).order('created_at', { ascending: false }),
      supabase.from('candidates').select('job_id').eq('user_id', user.id).not('job_id', 'is', null),
    ])
    setJobs(j || [])
    const counts = {}
    ;(c || []).forEach(row => { counts[row.job_id] = (counts[row.job_id] || 0) + 1 })
    setCandCounts(counts)
    setLoading(false)
  }

  const { open, closed } = useMemo(() => {
    const open = jobs.filter(j => j.status === 'active' || j.status === 'onhold')
    const closed = jobs.filter(j => j.status === 'filled' || j.status === 'lost')
    return { open, closed }
  }, [jobs])

  function openAdd() { setEditJob(null); setShowModal(true) }
  function openEdit(j) { setEditJob(j); setShowModal(true) }

  async function del(id) {
    setListError('')
    const { error: err } = await supabase.from('jobs').delete().eq('id', id)
    if (err) return setListError('Could not delete job: ' + err.message)
    setJobs(prev => prev.filter(j => j.id !== id))
  }

  function JobCard({ j }) {
    const count = candCounts[j.id] || 0
    return (
      <div className="card p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-navy text-sm">{j.title}</h3>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${STATUS_COLOR[j.status]}`}>{STATUS_LABEL[j.status]}</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {j.companies?.name || 'No company'}{j.industry ? ` · ${j.industry}` : ''} · {TYPE_LABEL[j.job_type] || j.job_type}
            </p>
            <p className="text-xs text-amber-500 mt-1">{stars(j.likelihood || 3)}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
              {j.salary_num ? <span>AED {Number(j.salary_num).toLocaleString()}</span> : null}
              {j.fee_value ? <span className="font-semibold text-navy">Fee: AED {Number(j.fee_value).toLocaleString()}</span> : null}
              {j.deadline ? <span>Due {new Date(j.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span> : null}
              <span>{count} candidate{count === 1 ? '' : 's'} shortlisted</span>
            </div>
            {j.notes && <p className="text-xs text-gray-500 mt-2 line-clamp-2">{j.notes}</p>}
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={() => openEdit(j)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
            <button onClick={() => setConfirmDeleteId(j.id)} className="text-xs text-red-400 font-semibold hover:underline">Delete</button>
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
            Jobs & Mandates
            <InfoTip text="Every job attaches to a real company record, picked from a dropdown, so the same client never gets created twice under a different spelling. Link candidates to a job from the Candidates page." />
          </h1>
          <p className="text-gray-500 mt-1">{open.length} open, {closed.length} closed</p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ Add Job</button>
      </div>

      {listError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-4">{listError}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-20"><div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" /></div>
      ) : jobs.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">💼</div>
          <h3 className="font-bold text-navy mb-1">No jobs yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Add your first mandate. Pick the client from your companies, or add a new one on the spot.</p>
          <button onClick={openAdd} className="btn-primary">Add a job</button>
        </div>
      ) : (
        <div className="space-y-6">
          {open.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Open</h2>
              <div className="space-y-3">{open.map(j => <JobCard key={j.id} j={j} />)}</div>
            </div>
          )}
          {closed.length > 0 && (
            <div>
              <button onClick={() => setShowClosed(s => !s)} className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3 hover:text-gray-600">
                {showClosed ? '▾' : '▸'} Closed ({closed.length})
              </button>
              {showClosed && <div className="space-y-3">{closed.map(j => <JobCard key={j.id} j={j} />)}</div>}
            </div>
          )}
        </div>
      )}

      <JobFormModal
        open={showModal}
        editJob={editJob}
        onClose={() => setShowModal(false)}
        onSaved={() => load()}
      />

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => del(confirmDeleteId)}
        title="Delete this job?"
        message="This can't be undone."
        confirmLabel="Delete"
      />
    </div>
  )
}

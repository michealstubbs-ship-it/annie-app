import React, { useState, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { listJobsWithCompanies, deleteJob } from '../lib/data/jobs'
import { listCandidateJobLinks, listCandidatesForMatching } from '../lib/data/candidates'
import { prepareCandidatesForMatching, matchPreparedCandidatesToJob } from '../lib/candidateMatch'
import InfoTip from './InfoTip'
import JobFormModal from './JobFormModal'
import ConfirmDialog from './ConfirmDialog'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'

const STATUS_LABEL = { active: 'Active', onhold: 'On hold', filled: 'Filled', lost: 'Lost' }
const STATUS_COLOR = {
  active: 'bg-green-100 text-green-700',
  onhold: 'bg-amber-100 text-amber-700',
  filled: 'bg-yellow-100 text-gold',
  lost: 'bg-gray-100 text-gray-500',
}
const TYPE_LABEL = { permanent: 'Permanent', contract: 'Contract', interim: 'Interim' }

function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n) }

// 2026-08-29, flagged directly: candidate-to-job matching didn't exist
// anywhere in the app — the only link was manual, one candidate at a time
// (the "job they're being considered for" picker on the candidate form).
// This surfaces "who in my CRM might actually fit this job" using the exact
// matching engine already built and proven for Today's Actions
// (candidateMatch.js), pointed at title/industry/notes instead of a BD
// signal — no new matching logic, same reasoning as Contacts.jsx/
// Companies.jsx reusing lib/*View.js helpers.
//
// Matches are computed lazily, only for an expanded card — cheap either way
// once candidates are prepared once (see Jobs()'s own load()), but there's
// no reason to compute or render suggestions for a card nobody asked to see.
function JobCard({ j, count, expanded, onToggleExpand, matches }) {
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
        {/* 2026-08-29 audit fix: same Delete-styled-like-a-routine-action
            issue fixed on Invoices.jsx, applied here for consistency. */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => onToggleExpand.edit(j)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
          <div className="pl-2 ml-1 border-l border-gray-200">
            <button onClick={() => onToggleExpand.delete(j.id)} className="text-xs text-red-500 font-semibold hover:underline">Delete</button>
          </div>
        </div>
      </div>

      <button onClick={() => onToggleExpand.match(j.id)} className="text-xs font-semibold text-gold-ink mt-3 hover:underline">
        {expanded ? '▾ Hide suggested candidates' : '▸ Suggested candidates'}
      </button>
      {expanded && (
        <div className="mt-2 pt-3 border-t border-gray-100 space-y-2">
          {matches.length === 0 ? (
            <p className="text-xs text-gray-400">No obvious matches in your CRM yet — Annie checks role, industry, and notes on file against this job's title, industry, and brief.</p>
          ) : (
            matches.map(c => (
              <div key={c.id} className="flex items-center justify-between text-xs bg-page-bg rounded-lg px-3 py-2 gap-2">
                <span className="min-w-0 truncate">
                  <span className="font-semibold text-navy">{c.name}</span>
                  {[c.role, c.company].filter(Boolean).length > 0 && <span className="text-gray-500"> — {[c.role, c.company].filter(Boolean).join(' · ')}</span>}
                </span>
                <span className="text-[10px] text-gray-400 uppercase tracking-wide flex-shrink-0">{c.status}</span>
              </div>
            ))
          )}
          <p className="text-[10px] text-gray-400 mt-1">💡 Annie's suggestion, based on what's on file — not a guarantee of fit.</p>
        </div>
      )}
    </div>
  )
}

export default function Jobs() {
  const { user } = useAuth()
  const location = useLocation()
  const [jobs, setJobs] = useState([])
  const [candCounts, setCandCounts] = useState({})
  const [preparedCandidates, setPreparedCandidates] = useState([])
  const [expandedJobIds, setExpandedJobIds] = useState(() => new Set())
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
    setListError('')
    // 2026-08-24 Task 2: routed through lib/data/* (previously duplicated
    // inline here) so this table's query shape lives in exactly one place.
    // 2026-08-26 audit fix: each of these now throws on a real Supabase
    // error instead of quietly returning [] — previously that looked
    // identical to "you have no jobs yet".
    // 2026-08-29: also loads the same candidate pool Today's Actions
    // matches against (listCandidatesForMatching, deliberately uncapped —
    // see that function's own comment) and prepares it once here, so every
    // job's "Suggested candidates" panel reuses the same tokenized pool
    // instead of re-tokenizing per job.
    try {
      const [j, c, matchCandidates] = await Promise.all([
        listJobsWithCompanies(user.id),
        listCandidateJobLinks(user.id),
        listCandidatesForMatching(user.id),
      ])
      setJobs(j)
      const counts = {}
      c.forEach(row => { counts[row.job_id] = (counts[row.job_id] || 0) + 1 })
      setCandCounts(counts)
      setPreparedCandidates(prepareCandidatesForMatching(matchCandidates))
    } catch (err) {
      setListError(err.message || 'Could not load your jobs. Please try again.')
    } finally {
      setLoading(false)
    }
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
    const { error: err } = await deleteJob(id)
    if (err) return setListError('Could not delete job: ' + err.message)
    setJobs(prev => prev.filter(j => j.id !== id))
  }

  // Expand/collapse state lives here, in the parent, rather than as local
  // state inside JobCard — JobCard is re-rendered (and, before this fix,
  // would have been redefined and remounted) every time this component's
  // own state changes, e.g. after any save/delete triggers load(). Local
  // state inside JobCard would have silently collapsed every expanded panel
  // on the next unrelated save.
  function toggleMatch(jobId) {
    setExpandedJobIds(prev => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })
  }
  const cardActions = { edit: openEdit, delete: (id) => setConfirmDeleteId(id), match: toggleMatch }

  function renderJobCard(j) {
    const expanded = expandedJobIds.has(j.id)
    return (
      <JobCard
        key={j.id}
        j={j}
        count={candCounts[j.id] || 0}
        expanded={expanded}
        onToggleExpand={cardActions}
        matches={expanded ? matchPreparedCandidatesToJob(j, preparedCandidates) : []}
      />
    )
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            Jobs & Mandates
            <InfoTip text="Every job attaches to a real company record, picked from a dropdown, so the same client never gets created twice under a different spelling. Link candidates to a job from the Candidates page, or check Suggested candidates on a job for who in your CRM might already fit." />
          </h1>
          <p className="text-gray-500 mt-1">{open.length} open, {closed.length} closed</p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ Add Job</button>
      </div>

      <ErrorBanner>{listError}</ErrorBanner>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Spinner /></div>
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
              <div className="space-y-3">{open.map(renderJobCard)}</div>
            </div>
          )}
          {closed.length > 0 && (
            <div>
              <button onClick={() => setShowClosed(s => !s)} className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3 hover:text-gray-600">
                {showClosed ? '▾' : '▸'} Closed ({closed.length})
              </button>
              {showClosed && <div className="space-y-3">{closed.map(renderJobCard)}</div>}
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

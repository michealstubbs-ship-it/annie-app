import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { getJob, updateJob } from '../lib/data/jobs'
import {
  listPipelineForJob,
  listOtherPipelinesForCandidate,
  createPipelineLink,
  updatePipelineLinkStage,
  updatePipelineLinkInterview,
  countPipelinesPerCandidate,
  listCandidatesForPipelinePicker,
} from '../lib/data/pipelineLinks'
import { createCandidate } from '../lib/data/candidates'
import { listTeamMembers, nameForMember } from '../lib/data/teamMembers'
import { reassignOwner } from '../lib/data/ownership'
import { STAGES, STAGE_LABEL, STAGE_COLOR } from '../lib/candidatesView'
import { currencySymbol } from '../lib/invoiceCalc'
import { useMarketCurrency } from '../lib/useMarketCurrency'
import OwnerFilter from './OwnerFilter'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import Modal from './Modal'

// 2026-09-03, Michael: "we got distracted, you have to go back and build
// the whole job mock you created" — the real build behind
// mockups/pipeline-v2-mockup.html, backed by the many-to-many
// candidate_job_links table Michael chose ("Build it properly") over a
// single-job-only first pass. Real 9-stage STAGES/STAGE_LABEL/STAGE_COLOR
// from candidatesView.js throughout — deliberately NOT the mockup's own
// simplified 6-stage list, which was just a mockup convenience.

// The board's "Advance stage" (single-card and bulk) walks a candidate
// forward along the real hiring progression only — rejected/withdrawn are
// off-ramps a recruiter chooses explicitly (drag a card there, or the
// stage picker below), never somewhere "Advance" walks them into.
const MAIN_STAGES = STAGES.filter(s => s !== 'rejected' && s !== 'withdrawn')
function nextStage(stage) {
  const idx = MAIN_STAGES.indexOf(stage)
  if (idx === -1 || idx === MAIN_STAGES.length - 1) return null
  return MAIN_STAGES[idx + 1]
}

function initials(name) {
  return (name || '?').split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

// Mirrors Candidates.jsx's own salaryPrefix (also kept local there, not
// exported) — the same small "AED 55,000" vs "£55,000" spacing rule, in
// its second place rather than a shared import neither page needs
// elsewhere yet.
function salaryPrefix(code, fallbackPrefix) {
  if (!code) return fallbackPrefix
  const symbol = currencySymbol(code)
  return symbol.length > 1 ? `${symbol} ` : symbol
}

// 2026-09-06: a Ramadan/Eid-aware version of this (regionalCalendar.js)
// was built and then pulled — Michael: "too smart... overkill". Plain
// calendar-day diff, same as before that build.
function daysInStage(stageChangedAt) {
  if (!stageChangedAt) return 0
  const start = new Date(stageChangedAt)
  const now = new Date()
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.max(0, Math.round((nowDay - startDay) / 86400000))
}
function ageClass(days) {
  if (days <= 2) return 'bg-green-100 text-green-700'
  if (days <= 6) return 'bg-amber-100 text-amber-700'
  if (days <= 10) return 'bg-orange-100 text-orange-700'
  return 'bg-red-100 text-red-700'
}
function ageLabel(days) { return days === 0 ? 'Today' : `${days}d in stage` }
function ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th` }
function isToday(iso) {
  if (!iso) return false
  const d = new Date(iso), n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}
function formatInterviewShort(iso) {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return isToday(iso) ? `Today, ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}
function toLocalDatetimeInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function JobPipeline() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { currencyPrefix } = useMarketCurrency() // fallback prefix when a candidate has no per-candidate currency saved

  const [job, setJob] = useState(null)
  const [links, setLinks] = useState([])
  const [teamMembers, setTeamMembers] = useState([])
  const [otherCounts, setOtherCounts] = useState({}) // candidate_id -> total pipeline count (including this job)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  // 2026-09-06, gap-analysis batch 1 ("client-facing shortlist link"):
  // 'idle' | 'copied' | 'error' — feedback for the "Client link" button.
  const [shareState, setShareState] = useState('idle')

  const [view, setView] = useState('board') // 'board' | 'candidates'
  const [search, setSearch] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('all')
  const [selected, setSelected] = useState(() => new Set())
  const [dragOverStage, setDragOverStage] = useState(null)

  const [detailLinkId, setDetailLinkId] = useState(null)
  const [detailOther, setDetailOther] = useState([])
  const [detailOtherLoading, setDetailOtherLoading] = useState(false)
  const [interviewForm, setInterviewForm] = useState({ round: '1', at: '' })
  const [interviewSaving, setInterviewSaving] = useState(false)
  const [ownerSaving, setOwnerSaving] = useState(false)
  const [detailError, setDetailError] = useState('')

  // 2026-09-07, Michael, real report, looking at the pipeline stage
  // checklist: "when you move to interviewing, it should have a pop up
  // where you set the interview date and time, and as we may have coded
  // already that will show up in todays schedule on overview." The
  // scheduling itself, and the Today's Schedule wiring, already existed
  // (updatePipelineLinkInterview creates a `meetings` row for a today-dated
  // interview, see its own header in pipelineLinks.js). It just only ever
  // ran from inside the detail side panel, which nothing prompted a
  // recruiter to open right after a move. This popup is the missing
  // prompt: it fires the instant a single card lands on Interviewing (drag
  // a card there, or "Advance stage" from the detail panel), reusing the
  // same updatePipelineLinkInterview call the detail panel's own interview
  // form already uses. Deliberately NOT fired from bulkAdvance (see its
  // own `{ silent: true }` call below). Popping one modal per candidate
  // in a multi-select bulk move would just be a wall of interruptions; a
  // bulk-moved card still lands on the board showing "Not scheduled" so
  // nothing is silently lost, it's just set from the card/detail panel
  // afterward instead.
  const [scheduleModalLink, setScheduleModalLink] = useState(null)
  const [scheduleForm, setScheduleForm] = useState({ round: '1', at: '' })
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState('')

  const [addOpen, setAddOpen] = useState(false)
  const [addSearch, setAddSearch] = useState('')
  const [addCandidates, setAddCandidates] = useState(null) // null = not loaded yet
  const [addSavingId, setAddSavingId] = useState(null)

  // 2026-09-07, Michael, real report: "when you have an option to add
  // candidate to pipeline, you should have the option to add a candidate to
  // the system and the job at the same time. Not only the option to add a
  // candidate that is already on the system." Nested inside the same
  // "Add candidate to pipeline" modal, same "pick existing, or add new"
  // shape as CompanySelect.jsx's own "+ Add new company..." pattern.
  const [addCreateOpen, setAddCreateOpen] = useState(false)
  const [newCandForm, setNewCandForm] = useState({ name: '', role: '', company: '', email: '', phone: '' })
  const [newCandSaving, setNewCandSaving] = useState(false)
  const [newCandError, setNewCandError] = useState('')

  const [candViewData, setCandViewData] = useState({}) // candidate_id -> other links (loaded lazily)
  const [candViewLoading, setCandViewLoading] = useState(false)

  useEffect(() => { load() }, [jobId])

  async function load() {
    setLoading(true)
    setListError('')
    try {
      const [jobRow, linkRows, members] = await Promise.all([
        getJob(jobId),
        listPipelineForJob(jobId),
        listTeamMembers(),
      ])
      setJob(jobRow)
      setLinks(linkRows)
      setTeamMembers(members)
      const candidateIds = [...new Set(linkRows.map(l => l.candidate_id).filter(Boolean))]
      setOtherCounts(await countPipelinesPerCandidate(candidateIds))
    } catch (err) {
      setListError(err.message || 'Could not load this pipeline. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const filteredLinks = useMemo(() => {
    const q = search.trim().toLowerCase()
    return links.filter(l => {
      if (ownerFilter !== 'all' && l.owner_id !== ownerFilter) return false
      if (!q) return true
      const c = l.candidates
      return [c?.name, c?.role, c?.company].some(f => f?.toLowerCase().includes(q))
    })
  }, [links, search, ownerFilter])

  const columns = useMemo(() => STAGES.map(stage => ({
    stage,
    label: STAGE_LABEL[stage],
    items: filteredLinks.filter(l => l.stage === stage),
  })), [filteredLinks])

  const stats = useMemo(() => {
    const inPipeline = links.length
    const interviewingCount = links.filter(l => l.stage === 'interviewing').length
    const offersOut = links.filter(l => l.stage === 'offer').length
    const avgDays = inPipeline ? (links.reduce((sum, l) => sum + daysInStage(l.stage_changed_at), 0) / inPipeline) : 0
    const aging = links.filter(l => daysInStage(l.stage_changed_at) > 7).length
    return { inPipeline, interviewingCount, offersOut, avgDays, aging }
  }, [links])

  // ---- stage moves (drag-and-drop + Advance stage) ----

  const moveLinkToStage = useCallback(async (link, newStage, { silent } = {}) => {
    if (link.stage === newStage) return
    const stampedAt = new Date().toISOString()
    setLinks(prev => prev.map(l => (l.id === link.id ? { ...l, stage: newStage, stage_changed_at: stampedAt } : l)))
    try {
      await updatePipelineLinkStage(link.id, newStage, { isPrimary: link.is_primary, candidateId: link.candidate_id })
      if (newStage === 'interviewing' && !silent) {
        setScheduleForm({ round: '1', at: '' })
        setScheduleError('')
        setScheduleModalLink({ ...link, stage: newStage, stage_changed_at: stampedAt })
      }
    } catch (err) {
      setListError(err.message || 'Could not move this candidate. Please try again.')
      await load() // revert to the real server state rather than leave an unsaved optimistic move on screen
    }
  }, [])

  function handleDrop(stage, e) {
    e.preventDefault()
    setDragOverStage(null)
    const linkId = e.dataTransfer.getData('text/plain')
    const link = links.find(l => l.id === linkId)
    if (link) moveLinkToStage(link, stage)
  }

  // ---- selection + bulk actions ----

  function toggleSelect(linkId, checked) {
    setSelected(prev => {
      const next = new Set(prev)
      checked ? next.add(linkId) : next.delete(linkId)
      return next
    })
  }
  function clearSelection() { setSelected(new Set()) }

  // 2026-09-06, gap-analysis batch 1 ("client-facing shortlist link"):
  // every job already has a public_share_token by default (see the
  // migration) — this only ever needs to flip share_enabled on (never
  // regenerate the token) and copy the resulting URL. share_enabled is
  // never turned off here — a recruiter who wants to revoke a link does
  // so explicitly elsewhere (a link staying "on" once shared matches how
  // Vincere's own LiveList and most client-portal links behave).
  async function getOrEnableClientLink() {
    setShareState('idle')
    try {
      if (!job.share_enabled) {
        const { error: err } = await updateJob(job.id, { share_enabled: true })
        if (err) throw err
        setJob(prev => ({ ...prev, share_enabled: true }))
      }
      const url = `${window.location.origin}/share/job/${job.public_share_token}`
      await navigator.clipboard.writeText(url)
      setShareState('copied')
      setTimeout(() => setShareState('idle'), 2500)
    } catch {
      setShareState('error')
      setTimeout(() => setShareState('idle'), 2500)
    }
  }

  async function bulkAdvance() {
    const targets = [...selected].map(id => links.find(l => l.id === id)).filter(Boolean)
    await Promise.all(targets.map(link => {
      const next = nextStage(link.stage)
      // silent: a bulk move never pops the schedule-interview modal (see
      // scheduleModalLink's own header comment above). One popup per
      // candidate in a multi-select move would just be a wall of
      // interruptions, and the board card itself already shows "Not
      // scheduled" for anyone who lands on Interviewing without a time set.
      return next ? moveLinkToStage(link, next, { silent: true }) : Promise.resolve()
    }))
    clearSelection()
  }

  async function bulkReassign(newOwnerId) {
    if (!newOwnerId) return
    const targets = [...selected].map(id => links.find(l => l.id === id)).filter(Boolean)
    try {
      await Promise.all(targets.map(link =>
        link.owner_id === newOwnerId ? Promise.resolve() : reassignOwner('candidate_job_links', link.id, newOwnerId, user.id, link.owner_id)
      ))
      setLinks(prev => prev.map(l => (selected.has(l.id) ? { ...l, owner_id: newOwnerId } : l)))
    } catch (err) {
      setListError(err.message || 'Could not reassign owner for the selected candidates.')
    }
    clearSelection()
  }

  // ---- detail panel ----

  const detailLink = links.find(l => l.id === detailLinkId) || null

  function openDetail(link) {
    setDetailLinkId(link.id)
    setDetailError('')
    setInterviewForm({ round: String(link.interview_round || 1), at: toLocalDatetimeInput(link.interview_at) })
    setDetailOther([])
    setDetailOtherLoading(true)
    listOtherPipelinesForCandidate(link.candidate_id, jobId)
      .then(setDetailOther)
      .catch(err => setDetailError(err.message || 'Could not load this candidate\'s other pipelines.'))
      .finally(() => setDetailOtherLoading(false))
  }
  function closeDetail() { setDetailLinkId(null) }

  async function saveInterview() {
    if (!detailLink) return
    setInterviewSaving(true)
    setDetailError('')
    try {
      const atIso = interviewForm.at ? new Date(interviewForm.at).toISOString() : null
      await updatePipelineLinkInterview(detailLink.id, {
        round: interviewForm.round ? Number(interviewForm.round) : null,
        at: atIso,
        candidateId: detailLink.candidate_id,
        candidateName: detailLink.candidates?.name,
        jobTitle: job?.title,
        userId: user.id,
      })
      setLinks(prev => prev.map(l => (l.id === detailLink.id ? { ...l, interview_round: interviewForm.round ? Number(interviewForm.round) : null, interview_at: atIso } : l)))
    } catch (err) {
      setDetailError(err.message || 'Could not save the interview time.')
    } finally {
      setInterviewSaving(false)
    }
  }

  // ---- schedule-interview popup (fires right after a single card lands on
  // Interviewing, see scheduleModalLink's own header comment above) ----

  function closeScheduleModal() { setScheduleModalLink(null); setScheduleError('') }

  async function saveScheduleModal() {
    if (!scheduleModalLink) return
    setScheduleSaving(true)
    setScheduleError('')
    try {
      const atIso = scheduleForm.at ? new Date(scheduleForm.at).toISOString() : null
      await updatePipelineLinkInterview(scheduleModalLink.id, {
        round: scheduleForm.round ? Number(scheduleForm.round) : null,
        at: atIso,
        candidateId: scheduleModalLink.candidate_id,
        candidateName: scheduleModalLink.candidates?.name,
        jobTitle: job?.title,
        userId: user.id,
      })
      setLinks(prev => prev.map(l => (l.id === scheduleModalLink.id ? { ...l, interview_round: scheduleForm.round ? Number(scheduleForm.round) : null, interview_at: atIso } : l)))
      setScheduleModalLink(null)
    } catch (err) {
      setScheduleError(err.message || 'Could not save the interview time.')
    } finally {
      setScheduleSaving(false)
    }
  }

  async function reassignDetailOwner(newOwnerId) {
    if (!detailLink || !newOwnerId || newOwnerId === detailLink.owner_id) return
    setOwnerSaving(true)
    setDetailError('')
    try {
      await reassignOwner('candidate_job_links', detailLink.id, newOwnerId, user.id, detailLink.owner_id)
      setLinks(prev => prev.map(l => (l.id === detailLink.id ? { ...l, owner_id: newOwnerId } : l)))
    } catch (err) {
      setDetailError(err.message || 'Could not reassign owner.')
    } finally {
      setOwnerSaving(false)
    }
  }

  async function advanceDetail() {
    if (!detailLink) return
    const next = nextStage(detailLink.stage)
    if (next) await moveLinkToStage(detailLink, next)
  }

  // ---- add candidate to pipeline ----

  async function openAddPicker() {
    setAddOpen(true)
    setAddSearch('')
    if (addCandidates === null) {
      try {
        setAddCandidates(await listCandidatesForPipelinePicker())
      } catch (err) {
        setListError(err.message || 'Could not load candidates.')
        setAddCandidates([])
      }
    }
  }
  const addPickerResults = useMemo(() => {
    const q = addSearch.trim().toLowerCase()
    const already = new Set(links.map(l => l.candidate_id))
    return (addCandidates || [])
      .filter(c => !already.has(c.id))
      .filter(c => !q || [c.name, c.role, c.company].some(f => f?.toLowerCase().includes(q)))
      .slice(0, 30)
  }, [addCandidates, addSearch, links])

  async function addToPipeline(candidateId) {
    setAddSavingId(candidateId)
    try {
      const newLink = await createPipelineLink(candidateId, jobId, job.team_id, user.id)
      setLinks(prev => [newLink, ...prev])
      setOtherCounts(prev => ({ ...prev, [candidateId]: (prev[candidateId] || 0) + 1 }))
      setAddOpen(false)
    } catch (err) {
      setListError(err.message || 'Could not add this candidate to the pipeline.')
    } finally {
      setAddSavingId(null)
    }
  }

  function openCreateCandidate() {
    setNewCandForm({ name: '', role: '', company: '', email: '', phone: '' })
    setNewCandError('')
    setAddCreateOpen(true)
  }

  // Sets job_id directly on the new candidate, the same field
  // Candidates.jsx's own "Job / mandate" picker writes. That's what makes
  // this their PRIMARY pipeline link, auto-inserted by the
  // trg_sync_primary_candidate_job_link trigger (see
  // supabase-migrations/2026-09-03-candidate-job-pipeline-links.sql's own
  // header), not a second createPipelineLink call. Deliberately NOT the
  // createPipelineLink path createPipelineLink/addToPipeline above use for
  // an EXISTING candidate, which inserts a secondary (is_primary: false)
  // link, and the migration's own comment is explicit that the app must
  // never write is_primary: true directly, only ever via candidates.job_id
  // through this trigger. Reloads from the server afterward (`load()`)
  // rather than constructing a synthetic link locally, since the trigger's
  // insert happens server-side and this is the simplest way to get back
  // its real id/stage/stage_changed_at.
  async function saveNewCandidateToPipeline() {
    const name = newCandForm.name.trim()
    if (!name) return setNewCandError('Name is required')
    setNewCandSaving(true)
    setNewCandError('')
    try {
      const { error: err } = await createCandidate({
        name,
        role: newCandForm.role.trim() || null,
        company: newCandForm.company.trim() || null,
        email: newCandForm.email.trim() || null,
        phone: newCandForm.phone.trim() || null,
        status: 'shortlisted',
        source: 'Added from job pipeline',
        job_id: jobId,
      }, user.id)
      if (err) throw err
      setAddCreateOpen(false)
      setAddOpen(false)
      await load()
    } catch (err) {
      setNewCandError(err.message || 'Could not create this candidate.')
    } finally {
      setNewCandSaving(false)
    }
  }

  // ---- candidate view (multi-pipeline) ----

  async function switchToCandidateView() {
    setView('candidates')
    const withOthers = links.filter(l => (otherCounts[l.candidate_id] || 1) - 1 > 0 && !candViewData[l.candidate_id])
    if (!withOthers.length) return
    setCandViewLoading(true)
    try {
      const entries = await Promise.all(withOthers.map(async l => [l.candidate_id, await listOtherPipelinesForCandidate(l.candidate_id, jobId)]))
      setCandViewData(prev => ({ ...prev, ...Object.fromEntries(entries) }))
    } catch (err) {
      setListError(err.message || 'Could not load candidate view.')
    } finally {
      setCandViewLoading(false)
    }
  }

  const multiPipelineLinks = useMemo(
    () => links.filter(l => (otherCounts[l.candidate_id] || 1) - 1 > 0),
    [links, otherCounts]
  )

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Spinner /></div>
  }
  if (!job) {
    return <div className="p-8"><ErrorBanner>{listError || 'This job could not be found.'}</ErrorBanner></div>
  }

  return (
    <div className="p-8">
      <button onClick={() => navigate('/dashboard/jobs')} className="text-xs text-gray-400 hover:text-navy font-semibold mb-3">‹ Jobs &amp; Mandates</button>

      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-bold text-navy flex items-center">
            {job.title}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            <b className="text-navy font-semibold">{job.companies?.name || 'No company'}</b>
            {job.received && <> · opened {new Date(job.received).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</>}
            {job.deadline && <> · target close {new Date(job.deadline).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</>}
            {job.owner_id && <> · owner <b className="text-navy font-semibold">{nameForMember(teamMembers, job.owner_id)}</b></>}
          </p>
          <button onClick={getOrEnableClientLink} className="text-xs font-semibold text-gold-ink hover:underline mt-2">
            {shareState === 'copied' ? '✓ Link copied' : shareState === 'error' ? 'Could not copy — try again' : job.share_enabled ? '🔗 Copy client link' : '🔗 Get client link'}
          </button>
        </div>
        <div className="flex gap-2 flex-wrap">
          {[
            ['In pipeline', stats.inPipeline, false],
            ['Interviewing', stats.interviewingCount, false],
            ['Offers out', stats.offersOut, false],
            ['Avg. time in stage', `${stats.avgDays.toFixed(1)}d`, false],
            ['Aging >7d', stats.aging, stats.aging > 0],
          ].map(([label, n, flag]) => (
            <div key={label} className="card px-3.5 py-2 min-w-[92px]">
              <div className={`text-lg font-bold tabular-nums ${flag ? 'text-red-600' : 'text-navy'}`}>{n}</div>
              <div className="text-[10.5px] text-gray-400 uppercase tracking-wide mt-0.5">{label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex bg-gray-100 p-1 rounded-lg w-fit mb-4">
        <button onClick={() => setView('board')} className={`text-xs font-semibold px-3 py-1.5 rounded-md ${view === 'board' ? 'bg-navy text-white' : 'text-gray-500'}`}>Job pipeline</button>
        <button onClick={switchToCandidateView} className={`text-xs font-semibold px-3 py-1.5 rounded-md ${view === 'candidates' ? 'bg-navy text-white' : 'text-gray-500'}`}>Candidate view</button>
      </div>

      <ErrorBanner>{listError}</ErrorBanner>

      {view === 'board' ? (
        <>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <input className="input max-w-xs" placeholder="Find a candidate in this pipeline…" value={search} onChange={e => setSearch(e.target.value)} />
            <OwnerFilter value={ownerFilter} onChange={setOwnerFilter} teamMembers={teamMembers} />
            <button onClick={openAddPicker} className="btn-primary text-sm ml-auto">＋ Add candidate to pipeline</button>
          </div>

          {selected.size > 0 && (
            <div className="flex items-center gap-3 bg-navy text-white rounded-lg px-3.5 py-2 mb-3 text-sm flex-wrap">
              <span><b className="text-gold">{selected.size}</b> selected</span>
              <button onClick={bulkAdvance} className="bg-white/10 hover:border-gold border border-white/20 rounded-md px-3 py-1 text-xs font-semibold">Advance stage →</button>
              {teamMembers.length > 1 && (
                <select
                  className="bg-white/10 border border-white/20 rounded-md px-2 py-1 text-xs font-semibold text-white"
                  defaultValue=""
                  onChange={e => bulkReassign(e.target.value)}
                  aria-label="Reassign owner for selected candidates"
                >
                  <option value="" disabled>Reassign owner…</option>
                  {teamMembers.map(m => <option key={m.id} value={m.id} className="text-navy">{m.name}</option>)}
                </select>
              )}
              <button onClick={clearSelection} className="ml-auto text-xs text-gray-300 hover:text-white">Clear</button>
            </div>
          )}

          {links.length === 0 ? (
            <div className="card p-12 text-center">
              <div className="text-4xl mb-3">🗂️</div>
              <h3 className="font-bold text-navy mb-1">No one in this pipeline yet</h3>
              <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Add a candidate from your CRM to start tracking them through this job's stages.</p>
              <button onClick={openAddPicker} className="btn-primary">＋ Add candidate to pipeline</button>
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-3 items-start">
              {columns.map(col => (
                <div
                  key={col.stage}
                  className={`flex-none w-[258px] bg-gray-50 rounded-xl p-2.5 max-h-[calc(100vh-260px)] flex flex-col ${dragOverStage === col.stage ? 'outline outline-2 outline-gold-ink outline-offset-[-2px]' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOverStage(col.stage) }}
                  onDragLeave={() => setDragOverStage(prev => (prev === col.stage ? null : prev))}
                  onDrop={e => handleDrop(col.stage, e)}
                >
                  <div className="flex items-center justify-between px-1.5 pb-2">
                    <span className="text-[11.5px] font-bold uppercase tracking-wide text-gray-500 flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${STAGE_COLOR[col.stage]?.split(' ')[1]?.replace('text-', 'bg-') || 'bg-gray-400'}`} />
                      {col.label}
                    </span>
                    <span className={`text-[11px] font-bold rounded-full px-2 py-0.5 tabular-nums ${col.stage === 'rejected' || col.stage === 'withdrawn' ? 'bg-red-100 text-red-600' : 'bg-white border border-gray-200 text-gray-500'}`}>{col.items.length}</span>
                  </div>
                  <div className="flex flex-col gap-2 overflow-y-auto px-0.5">
                    {col.items.map(link => {
                      const c = link.candidates || {}
                      const days = daysInStage(link.stage_changed_at)
                      const otherCount = (otherCounts[link.candidate_id] || 1) - 1
                      return (
                        <div
                          key={link.id}
                          draggable
                          onDragStart={e => e.dataTransfer.setData('text/plain', link.id)}
                          onClick={() => openDetail(link)}
                          className="bg-white border border-gray-200 rounded-lg p-2.5 shadow-sm cursor-grab active:cursor-grabbing"
                        >
                          <div className="flex items-start gap-2">
                            <input type="checkbox" className="mt-1" checked={selected.has(link.id)} onClick={e => e.stopPropagation()} onChange={e => toggleSelect(link.id, e.target.checked)} />
                            <div className="w-7 h-7 rounded-full bg-navy text-white flex items-center justify-center text-[11px] font-bold flex-shrink-0">{initials(c.name)}</div>
                            <div className="min-w-0">
                              <div className="font-bold text-[13px] text-navy truncate">{c.name}</div>
                              <div className="text-[11.5px] text-gray-500 truncate">{[c.role, c.company].filter(Boolean).join(' · ')}</div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap mt-2">
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${ageClass(days)}`}>{ageLabel(days)}</span>
                            {link.stage === 'interviewing' && (
                              <>
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-navy text-white">{ordinal(link.interview_round || 1)} round</span>
                                {link.interview_at ? (
                                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${isToday(link.interview_at) ? 'bg-gold text-navy' : 'bg-gray-100 text-gray-500'}`}>{isToday(link.interview_at) ? '📅 ' : ''}{formatInterviewShort(link.interview_at)}</span>
                                ) : (
                                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-dashed border-gray-300 text-gray-400">Not scheduled</span>
                                )}
                              </>
                            )}
                            {otherCount > 0 && (
                              <button onClick={e => { e.stopPropagation(); switchToCandidateView() }} className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100 hover:border-gold-ink">
                                also in {otherCount} other pipeline{otherCount > 1 ? 's' : ''}
                              </button>
                            )}
                          </div>
                          <div className="flex items-center justify-between mt-2 text-[10.5px] text-gray-400">
                            <span className="font-semibold text-gray-600 tabular-nums">{c.want_sal ? `${salaryPrefix(c.want_sal_currency, currencyPrefix)}${Number(c.want_sal).toLocaleString()}` : '—'}</span>
                            <span>{c.source || ''}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div>
          <p className="text-sm text-gray-500 mb-4">Every candidate from this pipeline who's also active on another job — the "double-submitted" list Michael asked for, so it's never a guessing game.</p>
          {candViewLoading ? (
            <div className="flex justify-center py-12"><Spinner /></div>
          ) : multiPipelineLinks.length === 0 ? (
            <p className="text-gray-400 text-sm">No candidate in this pipeline is currently in more than one active pipeline.</p>
          ) : (
            <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {multiPipelineLinks.map(link => {
                const c = link.candidates || {}
                const others = candViewData[link.candidate_id] || []
                return (
                  <div key={link.id} className="card p-4">
                    <div className="flex items-center gap-2.5 mb-3">
                      <div className="w-9 h-9 rounded-full bg-navy text-white flex items-center justify-center text-xs font-bold flex-shrink-0">{initials(c.name)}</div>
                      <div className="min-w-0">
                        <div className="font-bold text-sm text-navy truncate">{c.name}</div>
                        <div className="text-xs text-gray-500 truncate">{[c.role, c.company].filter(Boolean).join(' · ')}</div>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs">
                        <span className="font-semibold text-navy truncate">{job.title}</span>
                        <span className="text-[10.5px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full flex-shrink-0">{STAGE_LABEL[link.stage]}</span>
                      </div>
                      {others.map(o => (
                        <div key={o.id} className="flex items-center justify-between border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs">
                          <span className="font-semibold text-navy truncate">{o.jobs?.title}{o.jobs?.companies?.name ? ` — ${o.jobs.companies.name}` : ''}</span>
                          <span className="text-[10.5px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full flex-shrink-0">{STAGE_LABEL[o.stage]}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ---- detail side panel ---- */}
      {detailLink && (
        <div className="fixed inset-0 bg-navy/25 z-30" onClick={closeDetail}>
          <div className="absolute top-0 right-0 bottom-0 w-full sm:w-[420px] bg-white shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3 p-5 border-b border-gray-100">
              <div className="w-10 h-10 rounded-full bg-navy text-white flex items-center justify-center text-sm font-bold flex-shrink-0">{initials(detailLink.candidates?.name)}</div>
              <div className="min-w-0">
                <h2 className="font-bold text-navy text-base truncate">{detailLink.candidates?.name}</h2>
                <p className="text-xs text-gray-500 truncate">{[detailLink.candidates?.role, detailLink.candidates?.company].filter(Boolean).join(' · ')}</p>
              </div>
              <button onClick={closeDetail} aria-label="Close" className="ml-auto text-gray-400 hover:text-navy text-xl leading-none">✕</button>
            </div>

            <div className="p-5 overflow-y-auto flex-1">
              {detailError && <ErrorBanner>{detailError}</ErrorBanner>}

              <div className="mb-5">
                <h3 className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mb-2">Details</h3>
                <dl className="grid grid-cols-[100px_1fr] gap-y-1.5 gap-x-2.5 text-[13px]">
                  <dt className="text-gray-400">Added by</dt><dd className="font-medium">{nameForMember(teamMembers, detailLink.added_by) || 'Unknown'}</dd>
                  <dt className="text-gray-400">Owner</dt>
                  <dd>
                    <select className="input py-1 px-2 text-xs w-auto" value={detailLink.owner_id || ''} disabled={ownerSaving} onChange={e => reassignDetailOwner(e.target.value)} aria-label="Reassign owner">
                      {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </dd>
                  <dt className="text-gray-400">Source</dt><dd className="font-medium">{detailLink.candidates?.source || '—'}</dd>
                  <dt className="text-gray-400">Salary exp.</dt>
                  <dd className="font-medium">{detailLink.candidates?.want_sal ? `${salaryPrefix(detailLink.candidates.want_sal_currency, currencyPrefix)}${Number(detailLink.candidates.want_sal).toLocaleString()}` : '—'}</dd>
                  <dt className="text-gray-400">Time in stage</dt><dd className="font-medium">{ageLabel(daysInStage(detailLink.stage_changed_at))}</dd>
                </dl>
              </div>

              <div className="mb-5">
                <h3 className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mb-2">Stage progress</h3>
                {MAIN_STAGES.map((s, i) => {
                  const idx = MAIN_STAGES.indexOf(detailLink.stage)
                  const done = idx >= 0 && i < idx
                  const current = s === detailLink.stage
                  return (
                    <div key={s} className={`flex items-center gap-2 text-[13px] py-1.5 border-b border-gray-50 last:border-0 ${done ? 'text-green-600' : current ? 'text-gold-ink font-bold' : 'text-gray-400'}`}>
                      <span>{done ? '✓' : current ? '●' : '○'}</span><span>{STAGE_LABEL[s]}</span>
                    </div>
                  )
                })}
                {(detailLink.stage === 'rejected' || detailLink.stage === 'withdrawn') && (
                  <div className="flex items-center gap-2 text-[13px] py-1.5 text-red-600 font-bold"><span>●</span><span>{STAGE_LABEL[detailLink.stage]}</span></div>
                )}
              </div>

              {detailLink.stage === 'interviewing' && (
                <div className="mb-5">
                  <h3 className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mb-2">Interview</h3>
                  <div className="grid grid-cols-2 gap-2 mb-2.5">
                    <div>
                      <label className="text-[11px] text-gray-400 block mb-1" htmlFor="pipeline-interview-round">Round</label>
                      <select id="pipeline-interview-round" className="input py-1.5 px-2 text-xs" value={interviewForm.round} onChange={e => setInterviewForm(p => ({ ...p, round: e.target.value }))}>
                        <option value="1">1st round</option>
                        <option value="2">2nd round</option>
                        <option value="3">3rd round</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] text-gray-400 block mb-1" htmlFor="pipeline-interview-at">Date &amp; time</label>
                      <input id="pipeline-interview-at" type="datetime-local" className="input py-1.5 px-2 text-xs" value={interviewForm.at} onChange={e => setInterviewForm(p => ({ ...p, at: e.target.value }))} />
                    </div>
                  </div>
                  <button onClick={saveInterview} disabled={interviewSaving} className="btn-primary w-full text-sm justify-center">{interviewSaving ? 'Saving…' : 'Save interview time'}</button>
                  <p className="text-[11.5px] text-gray-400 mt-2">Scheduling for today adds {detailLink.candidates?.name?.split(' ')[0] || 'this candidate'} to <b>Today's Schedule</b>, so you get a reminder to follow up after the interview.</p>
                  {detailLink.interview_at && isToday(detailLink.interview_at) && (
                    <div className="mt-2.5 bg-gold/10 border border-gold/40 text-gold-ink rounded-lg px-2.5 py-2 text-xs font-semibold">📅 On Today's Schedule — {formatInterviewShort(detailLink.interview_at)}</div>
                  )}
                </div>
              )}

              <div className="mb-5">
                <h3 className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mb-2">Other pipelines this candidate is in</h3>
                {detailOtherLoading ? (
                  <p className="text-xs text-gray-400">Loading…</p>
                ) : detailOther.length === 0 ? (
                  <p className="text-xs text-gray-400">Not currently in any other pipeline.</p>
                ) : (
                  <div className="space-y-1.5">
                    {detailOther.map(o => (
                      <div key={o.id} className="flex items-center justify-between border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs">
                        <span className="font-semibold text-navy truncate">{o.jobs?.title}{o.jobs?.companies?.name ? ` — ${o.jobs.companies.name}` : ''}</span>
                        <span className="text-[10.5px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full flex-shrink-0">{STAGE_LABEL[o.stage]}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 border-t border-gray-100 flex gap-2">
              <button onClick={closeDetail} className="btn-ghost flex-1 justify-center">Close</button>
              {nextStage(detailLink.stage) && <button onClick={advanceDetail} className="btn-primary flex-1 justify-center">Advance stage →</button>}
            </div>
          </div>
        </div>
      )}

      {/* ---- add candidate to pipeline ---- */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add candidate to pipeline" maxWidth="max-w-md">
        <input className="input mb-3" placeholder="Search your candidates…" value={addSearch} onChange={e => setAddSearch(e.target.value)} autoFocus />
        {/* 2026-09-07, Michael, real report: "when you have an option to add
            candidate to pipeline, you should have the option to add a
            candidate to the system and the job at the same time. Not only
            the option to add a candidate that is already on the system."
            Same "pick existing, or add new" pattern CompanySelect already
            established for companies elsewhere in the app, always visible,
            not just when a search comes up empty, since the recruiter often
            knows upfront this is a brand-new person, not an existing one. */}
        <button onClick={openCreateCandidate} className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-gray-300 text-gold-ink font-semibold text-sm hover:border-gold-ink hover:bg-gold/5 mb-2">
          ＋ Add a new candidate to this pipeline…
        </button>
        {addCandidates === null ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : addPickerResults.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">No existing candidate matches, add them as new above.</p>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {addPickerResults.map(c => (
              <button
                key={c.id}
                onClick={() => addToPipeline(c.id)}
                disabled={addSavingId === c.id}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-50 flex items-center justify-between gap-2 disabled:opacity-50"
              >
                <span className="min-w-0 truncate">
                  <span className="font-semibold text-navy">{c.name}</span>
                  {(c.role || c.company) && <span className="text-gray-500 text-sm"> — {[c.role, c.company].filter(Boolean).join(' · ')}</span>}
                </span>
                <span className="text-xs text-gold-ink font-semibold flex-shrink-0">{addSavingId === c.id ? 'Adding…' : 'Add'}</span>
              </button>
            ))}
          </div>
        )}
      </Modal>

      {/* ---- add a brand-new candidate, straight into this job's pipeline ---- */}
      <Modal open={addCreateOpen} onClose={() => setAddCreateOpen(false)} title="Add new candidate" maxWidth="max-w-sm">
        <p className="text-xs text-gray-500 mb-3">This creates a real candidate record in your CRM and submits them to {job.title} at the same time, same as adding them from the Candidates page first.</p>
        {newCandError && <ErrorBanner>{newCandError}</ErrorBanner>}
        <div className="space-y-3">
          <div><label className="label" htmlFor="pipeline-new-cand-name">Name *</label><input id="pipeline-new-cand-name" className="input" value={newCandForm.name} onChange={e => setNewCandForm(p => ({ ...p, name: e.target.value }))} autoFocus /></div>
          <div><label className="label" htmlFor="pipeline-new-cand-role">Role</label><input id="pipeline-new-cand-role" className="input" value={newCandForm.role} onChange={e => setNewCandForm(p => ({ ...p, role: e.target.value }))} /></div>
          <div><label className="label" htmlFor="pipeline-new-cand-company">Current company</label><input id="pipeline-new-cand-company" className="input" value={newCandForm.company} onChange={e => setNewCandForm(p => ({ ...p, company: e.target.value }))} /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className="label" htmlFor="pipeline-new-cand-email">Email</label><input id="pipeline-new-cand-email" type="email" className="input" value={newCandForm.email} onChange={e => setNewCandForm(p => ({ ...p, email: e.target.value }))} /></div>
            <div><label className="label" htmlFor="pipeline-new-cand-phone">Phone</label><input id="pipeline-new-cand-phone" className="input" value={newCandForm.phone} onChange={e => setNewCandForm(p => ({ ...p, phone: e.target.value }))} /></div>
          </div>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">The rest of their profile, CV, salary expectations, notice period, and so on, can be filled in any time from the Candidates page.</p>
        <div className="flex gap-3 justify-end mt-5">
          <button onClick={() => setAddCreateOpen(false)} className="btn-ghost">Cancel</button>
          <button onClick={saveNewCandidateToPipeline} disabled={newCandSaving} className="btn-primary">{newCandSaving ? 'Adding…' : 'Add to pipeline'}</button>
        </div>
      </Modal>

      {/* ---- schedule-interview popup, fires right after a move to Interviewing (see scheduleModalLink's own header comment) ---- */}
      <Modal
        open={!!scheduleModalLink}
        onClose={closeScheduleModal}
        title={scheduleModalLink?.candidates?.name ? `Schedule interview for ${scheduleModalLink.candidates.name}` : 'Schedule interview'}
        maxWidth="max-w-sm"
      >
        {scheduleError && <ErrorBanner>{scheduleError}</ErrorBanner>}
        <p className="text-sm text-gray-500 mb-3">
          {(scheduleModalLink?.candidates?.name?.split(' ')[0]) || 'This candidate'} just moved to Interviewing. Set the date and time now and it'll show up on <b>Today's Schedule</b> the day it happens, or skip this and set it later from the card.
        </p>
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className="text-[11px] text-gray-400 block mb-1" htmlFor="schedule-modal-round">Round</label>
            <select id="schedule-modal-round" className="input py-1.5 px-2 text-xs" value={scheduleForm.round} onChange={e => setScheduleForm(p => ({ ...p, round: e.target.value }))}>
              <option value="1">1st round</option>
              <option value="2">2nd round</option>
              <option value="3">3rd round</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] text-gray-400 block mb-1" htmlFor="schedule-modal-at">Date &amp; time</label>
            <input id="schedule-modal-at" type="datetime-local" className="input py-1.5 px-2 text-xs" value={scheduleForm.at} onChange={e => setScheduleForm(p => ({ ...p, at: e.target.value }))} autoFocus />
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={closeScheduleModal} className="btn-ghost flex-1 justify-center">I'll set this later</button>
          <button onClick={saveScheduleModal} disabled={scheduleSaving} className="btn-primary flex-1 justify-center">{scheduleSaving ? 'Saving…' : 'Save interview time'}</button>
        </div>
      </Modal>
    </div>
  )
}

import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { listCandidatesWithJobs, createCandidate, updateCandidate, deleteCandidate } from '../lib/data/candidates'
import { listActiveJobsForPicker } from '../lib/data/jobs'
import { STAGES, STAGE_LABEL, searchCandidates, filterCandidatesByStage, sortCandidates, groupCandidatesByStage } from '../lib/candidatesView'
import InfoTip from './InfoTip'
import ConfirmDialog from './ConfirmDialog'
import { logSignalOutcome } from '../lib/signalOutcomes'
import { companiesMatch } from '../lib/companyMatch'
import { findOrCreateCompany } from '../lib/data/companies'
import { createContact, findContactIdByCompanyAndName } from '../lib/data/contacts'
import Modal from './Modal'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import { useMarketCurrency } from '../lib/useMarketCurrency'
import { CURRENCY_OPTIONS, currencySymbol } from '../lib/invoiceCalc'

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
  name: '', role: '', company: '', location: '', industry: '', nationality: '', email: '', phone: '',
  curr_sal: '', curr_sal_currency: '', want_sal: '', want_sal_currency: '', notice_period: '', availability: '', linkedin_url: '',
  status: 'sourced', source: '', follow_up_date: '', notes: '', job_id: '', add_as_contact: false,
}

// A candidate's own quoted salary currency can differ from the firm's own
// market/invoicing default (useMarketCurrency) — a firm working the UK and
// UAE both might have one candidate quoting a GBP salary and another an
// AED one, same day. Same space-vs-no-space convention useMarketCurrency
// already settled on ("AED 300,000" vs "£300,000"), just resolved per
// candidate instead of once for the whole page.
function salaryPrefix(code, fallbackPrefix) {
  if (!code) return fallbackPrefix
  const symbol = currencySymbol(code)
  return symbol.length > 1 ? `${symbol} ` : symbol
}

function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

export default function Candidates() {
  // 2026-08-30: was a hardcoded 'AED' on the card and both salary labels.
  // 2026-09-04, Michael: "Need to be able to change the currency on Current
  // salary and desired salary" — currencyCode is now only the DEFAULT a
  // new candidate's salary fields start on (a firm working one market at a
  // time still gets it pre-filled correctly with zero extra clicks); each
  // candidate can now say a different one, stored per-row (see
  // curr_sal_currency/want_sal_currency below) rather than always reading
  // the firm's own single market/invoicing default.
  const { currencyPrefix, currencyLabel, currencyCode } = useMarketCurrency()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [candidates, setCandidates] = useState([])
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('recent')
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
    setListError('')
    // 2026-08-24 Task 2: routed through lib/data/* (previously duplicated
    // inline here) so this table's query shape lives in exactly one place.
    // 2026-08-26 audit fix: each of these now throws on a real Supabase
    // error instead of quietly returning [] — previously that looked
    // identical to "you have no candidates/jobs yet".
    try {
      const [data, j] = await Promise.all([
        listCandidatesWithJobs(user.id),
        listActiveJobsForPicker(user.id),
      ])
      setCandidates(data)
      setJobs(j)
    } catch (err) {
      setListError(err.message || 'Could not load your candidates. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const metrics = useMemo(() => {
    const active = candidates.filter(c => !['placed', 'rejected', 'withdrawn'].includes(c.status))
    const interviewing = candidates.filter(c => ['interviewing', 'offer'].includes(c.status))
    const placed = candidates.filter(c => c.status === 'placed')
    return { total: candidates.length, active: active.length, interviewing: interviewing.length, placed: placed.length }
  }, [candidates])

  // 2026-08-29 audit fix, flagged directly alongside the same fix already
  // shipped for Contacts.jsx/Companies.jsx: this page already had stage
  // filter chips, but no search box at all, and "All" was one
  // undifferentiated pile of cards in whatever order the database
  // returned — no grouping, no sort. Filtering/sorting/grouping logic
  // lives in lib/candidatesView.js so it's unit-tested rather than only
  // reachable through this render.
  const searched = useMemo(() => searchCandidates(candidates, search), [candidates, search])
  const stageCounts = useMemo(() => {
    const counts = {}
    for (const s of STAGES) counts[s] = searched.filter(c => c.status === s).length
    return counts
  }, [searched])
  const stageFiltered = useMemo(() => filterCandidatesByStage(searched, filter), [searched, filter])
  const sorted = useMemo(() => sortCandidates(stageFiltered, sortBy), [stageFiltered, sortBy])
  const groups = filter === 'all' ? groupCandidatesByStage(sorted) : null

  function openAdd() { setForm({ ...EMPTY, curr_sal_currency: currencyCode, want_sal_currency: currencyCode }); setEditId(null); setCvFile(null); setExistingCvPath(null); setError(''); setShowModal(true) }
  function openEdit(c) {
    setForm({
      name: c.name || '', role: c.role || '', company: c.company || '', location: c.location || '', industry: c.industry || '', nationality: c.nationality || '',
      email: c.email || '', phone: c.phone || '', curr_sal: c.curr_sal || '', curr_sal_currency: c.curr_sal_currency || currencyCode,
      want_sal: c.want_sal || '', want_sal_currency: c.want_sal_currency || currencyCode,
      notice_period: c.notice_period || '', availability: c.availability || '', linkedin_url: c.linkedin_url || '',
      status: c.status || 'sourced', source: c.source || '', follow_up_date: c.follow_up_date || '', notes: c.notes || '', job_id: c.job_id || '',
      add_as_contact: false,
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
      // 2026-08-24: intelligence_signals is team-scoped by RLS — no client-side user_id filter on top of it.
      const { data: recentSignals } = await supabase
        .from('intelligence_signals')
        .select('id, company_name, signal_type')
        .order('found_at', { ascending: false })
        .limit(300)
      const match = (recentSignals || []).find(s => companiesMatch(s.company_name, row.company))
      if (match) logSignalOutcome(user, match, 'placed')
    } catch {
      // Best-effort, never let this block or fail the actual candidate save.
    }
  }

  // 2026-09-04, Michael: "when you are adding a candidate, let us as an
  // extra function add it to a company as a contact" — best-effort, same
  // "never block the actual save" precedent as maybeLogPlacement above.
  // findOrCreateCompany/findContactIdByCompanyAndName are the exact same
  // dedupe primitives ContactFormModal/CompanySelect already use, so this
  // can never create a second company or a duplicate contact just because
  // the box was left checked across a couple of edits.
  async function maybeAddAsContact(row) {
    if (!row.add_as_contact || !row.name?.trim() || !row.company?.trim()) return
    try {
      const companyId = await findOrCreateCompany(row.company.trim(), user.id)
      if (!companyId) return
      const existingId = await findContactIdByCompanyAndName(companyId, row.name)
      if (existingId) return
      await createContact({
        name: row.name.trim(),
        email: row.email || null,
        phone: row.phone || null,
        title: row.role || null,
        company: row.company.trim(),
        company_id: companyId,
        status: 'warm',
        notes: `Also added as a candidate on ${new Date().toLocaleDateString('en-GB')}.`,
      }, user.id)
    } catch (err) {
      // Best-effort — the candidate itself already saved fine; surface this
      // as a non-blocking note rather than losing it silently.
      setListError(`Candidate saved, but could not also add as a contact: ${err.message}`)
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

      // add_as_contact is a form-only flag — never a candidates column —
      // so it's split off here rather than spread onto the row that
      // actually gets persisted.
      const { add_as_contact, ...formFields } = form
      const row = {
        ...formFields,
        curr_sal: form.curr_sal ? parseInt(form.curr_sal) : null,
        curr_sal_currency: form.curr_sal ? (form.curr_sal_currency || currencyCode) : null,
        want_sal: form.want_sal ? parseInt(form.want_sal) : null,
        want_sal_currency: form.want_sal ? (form.want_sal_currency || currencyCode) : null,
        follow_up_date: form.follow_up_date || null,
        job_id: form.job_id || null,
        cv_path: cvPath,
        updated_at: new Date().toISOString(),
      }

      const previousStatus = editId ? candidates.find(c => c.id === editId)?.status : null

      if (editId) {
        const { error: err } = await updateCandidate(editId, row)
        if (err) throw err
      } else {
        const { error: err } = await createCandidate(row, user.id)
        if (err) throw err
      }
      maybeLogPlacement(row, previousStatus)
      maybeAddAsContact({ ...row, add_as_contact: form.add_as_contact })
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
    const { error: err } = await deleteCandidate(id)
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

  function renderCard(c) {
    return (
      // 2026-09-01: click-to-expand — the card opens the same Edit form
      // (Michael: this pattern "should apply across all tabs"); the row of
      // links/buttons below stops the click from bubbling so those keep
      // their own distinct actions.
      <div key={c.id} onClick={() => openEdit(c)} className={`card p-4 border-l-4 cursor-pointer ${STAGE_COLOR[c.status]?.split(' ')[0]?.replace('bg-', 'border-') || 'border-gray-200'}`}>
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
                {c.want_sal && <div className="text-xs font-bold text-navy">{salaryPrefix(c.want_sal_currency, currencyPrefix)}{Number(c.want_sal).toLocaleString()}</div>}
                {c.notice_period && <div className="text-[11px] text-gray-400">{c.notice_period} notice</div>}
              </div>
            </div>

            {c.notes && <p className="text-xs text-gray-600 mt-1.5 line-clamp-2">{c.notes}</p>}
            {c.jobs?.title && <p className="text-[11px] text-gold font-semibold mt-1">💼 {c.jobs.title}{c.jobs.companies?.name ? ` @ ${c.jobs.companies.name}` : ''}</p>}

            <div className="flex items-center gap-2 flex-wrap mt-2.5" onClick={e => e.stopPropagation()}>
              {c.location && <span className="text-[10px] bg-page-bg text-gray-500 px-2 py-1 rounded-md">📍 {c.location}</span>}
              {c.industry && <span className="text-[10px] bg-page-bg text-gray-500 px-2 py-1 rounded-md">🏢 {c.industry}</span>}
              {c.nationality && <span className="text-[10px] bg-page-bg text-gray-500 px-2 py-1 rounded-md">🌍 {c.nationality}</span>}
              {c.linkedin_url && (
                <a href={c.linkedin_url.startsWith('http') ? c.linkedin_url : `https://${c.linkedin_url}`} target="_blank" rel="noreferrer" className="text-[10px] font-semibold px-2 py-1 rounded-md bg-[#0077b5] text-white">LinkedIn</a>
              )}
              {c.email && <a href={`mailto:${c.email}`} className="text-[10px] font-semibold px-2 py-1 rounded-md border border-gray-200 text-gray-600">Email</a>}
              {c.cv_path && <button onClick={() => viewCv(c.cv_path)} className="text-[10px] font-semibold px-2 py-1 rounded-md border border-green-300 text-green-700">📄 CV</button>}
              <button onClick={() => openEdit(c)} className="text-[10px] font-semibold px-2 py-1 rounded-md border border-gray-200 text-gray-600">Edit</button>
              <button onClick={() => askAnnie(c)} className="text-[10px] font-semibold px-2 py-1 rounded-md bg-navy text-gold">Ask Annie</button>
              {/* 2026-08-29 audit fix: ml-auto already pushed Delete
                  away from the other actions spatially, but it was
                  still styled the same faint red-400 as everything
                  else in this row — no signal that it's the one
                  irreversible action here. A left border + the
                  stronger red-500 used everywhere else this pass
                  makes that read at a glance, same as Invoices.jsx. */}
              <button onClick={() => setConfirmDeleteId(c.id)} className="text-[10px] font-semibold px-2 py-1 rounded-md text-red-500 ml-auto pl-3 border-l border-gray-200">Delete</button>
            </div>
          </div>
        </div>
      </div>
    )
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

      {/* 2026-08-31 audit fix, mobile: unlike Overview.jsx's own equivalent
          stat row (grid-cols-2 sm:grid-cols-4), this one never had a mobile
          variant at all — three cards jammed into one row at phone width,
          each too narrow for its own number to sit comfortably. Stacks to
          one column below the sm breakpoint, same 3-up from sm: up. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
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

      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <div className="flex flex-wrap items-center gap-3">
          <input className="input max-w-sm" placeholder="Search candidates..." value={search} onChange={e => setSearch(e.target.value)} />
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setFilter('all')} className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${filter === 'all' ? 'bg-navy border-navy text-white' : 'border-gray-200 text-gray-600'}`}>
              All <span className="opacity-70">({searched.length})</span>
            </button>
            {STAGES.map(s => (
              <button key={s} onClick={() => setFilter(s)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${filter === s ? 'bg-navy border-navy text-white' : 'border-gray-200 text-gray-600'}`}>
                {STAGE_LABEL[s]} <span className="opacity-70">({stageCounts[s] || 0})</span>
              </button>
            ))}
          </div>
        </div>
        <select className="input max-w-[190px]" value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label="Sort candidates">
          <option value="recent">Sort: Recently added</option>
          <option value="name">Sort: Name (A–Z)</option>
          <option value="salary">Sort: Highest desired salary</option>
        </select>
      </div>

      <ErrorBanner>{listError}</ErrorBanner>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner />
        </div>
      ) : candidates.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🧑‍💼</div>
          <h3 className="font-bold text-navy mb-1">No candidates yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Add candidates as you source them, track them through to placement, and keep their CV attached.</p>
          <button onClick={openAdd} className="btn-primary">Add a candidate</button>
        </div>
      ) : searched.length === 0 ? (
        // 2026-08-29 audit fix: same bug already fixed on Contacts.jsx/
        // Companies.jsx — a typo'd search against a non-empty list used to
        // render the identical "add your first candidate" empty state as a
        // genuinely empty list.
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-bold text-navy mb-1">No candidates match "{search}"</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different name, role, company, location, industry, or email — or clear the search to see all {candidates.length} candidates.</p>
          <button onClick={() => setSearch('')} className="btn-ghost">Clear search</button>
        </div>
      ) : stageFiltered.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🗂️</div>
          <h3 className="font-bold text-navy mb-1">No candidates in {STAGE_LABEL[filter]}{search ? ` matching "${search}"` : ''}</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different stage, or clear this filter to see all {searched.length} candidate{searched.length === 1 ? '' : 's'}{search ? ' matching your search' : ''}.</p>
          <button onClick={() => setFilter('all')} className="btn-ghost">Show all stages</button>
        </div>
      ) : (
        <div className="space-y-3">
          {groups
            ? groups.flatMap(g => [
                <div key={`group-${g.stage}`} className="flex items-center gap-2 pt-2 first:pt-0">
                  <span className={`text-xs font-bold px-2 py-1 rounded-full uppercase tracking-wider ${STAGE_COLOR[g.stage] || 'bg-gray-100 text-gray-500'}`}>{g.label}</span>
                  <span className="text-xs text-gray-400">{g.candidates.length} candidate{g.candidates.length === 1 ? '' : 's'}</span>
                </div>,
                ...g.candidates.map(renderCard),
              ])
            : sorted.map(renderCard)}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editId ? 'Edit Candidate' : 'Add Candidate'} maxWidth="max-w-2xl">
            <ErrorBanner>{error}</ErrorBanner>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="label" htmlFor="candidate-name">Name *</label>
                <input id="candidate-name" className="input" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-role">Role</label>
                <input id="candidate-role" className="input" value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-company">Current company</label>
                <input id="candidate-company" className="input" value={form.company} onChange={e => setForm(p => ({ ...p, company: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-location">Location</label>
                <input id="candidate-location" className="input" value={form.location} onChange={e => setForm(p => ({ ...p, location: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-industry">Industry</label>
                <input id="candidate-industry" className="input" value={form.industry} onChange={e => setForm(p => ({ ...p, industry: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-nationality">Nationality</label>
                <input id="candidate-nationality" className="input" value={form.nationality} onChange={e => setForm(p => ({ ...p, nationality: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-email">Email</label>
                <input id="candidate-email" className="input" type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-phone">Phone</label>
                <input id="candidate-phone" className="input" value={form.phone} onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-curr-sal">Current salary</label>
                <div className="flex gap-1.5">
                  <select
                    id="candidate-curr-sal-currency"
                    aria-label="Current salary currency"
                    className="input w-[5.5rem] flex-shrink-0 px-1.5"
                    value={form.curr_sal_currency || currencyCode}
                    onChange={e => setForm(p => ({ ...p, curr_sal_currency: e.target.value }))}
                  >
                    {CURRENCY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                  </select>
                  <input id="candidate-curr-sal" className="input flex-1 min-w-0" type="number" value={form.curr_sal} onChange={e => setForm(p => ({ ...p, curr_sal: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="candidate-want-sal">Desired salary</label>
                <div className="flex gap-1.5">
                  <select
                    id="candidate-want-sal-currency"
                    aria-label="Desired salary currency"
                    className="input w-[5.5rem] flex-shrink-0 px-1.5"
                    value={form.want_sal_currency || currencyCode}
                    onChange={e => setForm(p => ({ ...p, want_sal_currency: e.target.value }))}
                  >
                    {CURRENCY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
                  </select>
                  <input id="candidate-want-sal" className="input flex-1 min-w-0" type="number" value={form.want_sal} onChange={e => setForm(p => ({ ...p, want_sal: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="candidate-notice-period">Notice period</label>
                <input id="candidate-notice-period" className="input" value={form.notice_period} onChange={e => setForm(p => ({ ...p, notice_period: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-availability">Availability</label>
                <input id="candidate-availability" className="input" value={form.availability} onChange={e => setForm(p => ({ ...p, availability: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor="candidate-linkedin-url">LinkedIn URL</label>
                <input id="candidate-linkedin-url" className="input" value={form.linkedin_url} onChange={e => setForm(p => ({ ...p, linkedin_url: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-stage">Stage</label>
                <select id="candidate-stage" className="input" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                  {STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="candidate-source">Source</label>
                <input id="candidate-source" className="input" value={form.source} onChange={e => setForm(p => ({ ...p, source: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-follow-up-date">Follow-up date</label>
                <input id="candidate-follow-up-date" className="input" type="date" value={form.follow_up_date} onChange={e => setForm(p => ({ ...p, follow_up_date: e.target.value }))} />
              </div>
              {/* 2026-09-04, Michael: "when you are adding a candidate, let
                  us as an extra function add it to a company as a contact"
                  — a candidate is sometimes also a useful business contact
                  (a hiring manager on the move, a referral source), so this
                  offers to also create/link a real Contacts row at their
                  current company, without leaving this form. Disabled until
                  there's a company to attach to, since a contact with no
                  company would be an orphan the same way a bare free-text
                  company string used to be (see findOrCreateCompany's own
                  header comment). */}
              <div className="col-span-2">
                <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.add_as_contact}
                    disabled={!form.company.trim()}
                    onChange={e => setForm(p => ({ ...p, add_as_contact: e.target.checked }))}
                  />
                  Also add {form.name.trim() || 'this candidate'} as a contact{form.company.trim() ? ` at ${form.company.trim()}` : ''}
                </label>
                {!form.company.trim() && <p className="text-[11px] text-gray-400 mt-1">Add a current company above to enable this.</p>}
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor="candidate-job-id">Job / mandate they're being considered for</label>
                <select id="candidate-job-id" className="input" value={form.job_id} onChange={e => setForm(p => ({ ...p, job_id: e.target.value }))}>
                  <option value="">Not tied to a specific job</option>
                  {jobs.map(j => <option key={j.id} value={j.id}>{j.title}{j.companies?.name ? ` @ ${j.companies.name}` : ''}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor="candidate-notes">Notes</label>
                <textarea id="candidate-notes" className="input resize-none" rows={3} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor="candidate-cv">CV</label>
                {existingCvPath && !cvFile ? (
                  <div className="flex items-center gap-2 bg-page-bg rounded-lg px-3 py-2">
                    <span className="text-xs text-gray-600 flex-1 truncate">CV on file</span>
                    <button type="button" onClick={() => viewCv(existingCvPath)} className="text-xs font-semibold text-gold-ink">View</button>
                    <button type="button" onClick={() => setExistingCvPath(null)} className="text-xs font-semibold text-red-400">Remove</button>
                  </div>
                ) : (
                  <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center">
                    <input id="candidate-cv" type="file" accept=".pdf,.doc,.docx" onChange={e => setCvFile(e.target.files?.[0] || null)} className="text-xs" />
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

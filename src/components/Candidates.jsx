import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { listCandidatesWithJobs, createCandidate, updateCandidate, deleteCandidate, findCandidateDuplicateByEmail, findDuplicateSubmission, findCandidateIdByExactName } from '../lib/data/candidates'
import { listActiveJobsForPicker } from '../lib/data/jobs'
import { listTeamMembers, nameForMember } from '../lib/data/teamMembers'
import { STAGES, STAGE_LABEL, STAGE_COLOR, searchCandidates, filterCandidatesByStage, sortCandidates, groupCandidatesByStage, VISA_TYPE_LABEL, visaExpiryBadge } from '../lib/candidatesView'
import { searchCandidatesBoolean } from '../lib/booleanSearch'
import InfoTip from './InfoTip'
import ConfirmDialog from './ConfirmDialog'
import { logSignalOutcome } from '../lib/signalOutcomes'
import { companiesMatch } from '../lib/companyMatch'
import { findOrCreateCompany } from '../lib/data/companies'
import { createContact, findContactIdByCompanyAndName } from '../lib/data/contacts'
import Modal from './Modal'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import InvoiceFormModal from './InvoiceFormModal'
import OwnerFilter from './OwnerFilter'
import OwnershipPanel from './OwnershipPanel'
import { useMarketCurrency } from '../lib/useMarketCurrency'
import { CURRENCY_OPTIONS, currencySymbol } from '../lib/invoiceCalc'
import { parseCvViaAnnie, triggerBulkCvImport, fetchCvBulkStatus } from '../lib/cvParseClient'

const EMPTY = {
  name: '', role: '', company: '', location: '', industry: '', nationality: '', email: '', phone: '',
  curr_sal: '', curr_sal_currency: '', want_sal: '', want_sal_currency: '', notice_period: '', availability: '', linkedin_url: '',
  status: 'sourced', source: '', follow_up_date: '', notes: '', job_id: '', add_as_contact: false,
  // 2026-09-03, Michael's second oversights batch: counter_offer_risk is a
  // recruiter judgment call (no competitor CRM has this as a named field —
  // see counter_offer_risk's own column comment in the migration), and
  // is_hotlisted is the candidate-LED marketing flag (as opposed to every
  // other field on this form, which is about matching this person to a
  // specific job) — both nullable/false by default so an ordinary
  // candidate save is completely unaffected.
  counter_offer_risk: '', counter_offer_notes: '', is_hotlisted: false, hotlist_note: '',
  // 2026-09-05, item 3: Annie's own CV-parse read on every OTHER title/
  // industry this candidate's real experience could plausibly match —
  // additive to the role/industry fields above (which stay the single
  // value shown on the card), used only for matching (see
  // candidateMatch.js's prepareCandidatesForMatching).
  titles: [], industries: [],
  // 2026-09-06, gap-analysis batch 1 ("visa & sponsorship status
  // tracking"): the single field every GCC recruiter needs first and no
  // competitor CRM researched has as a real field. Nullable, same
  // unaffected-by-default shape as counter_offer_risk above.
  visa_status: '', visa_type: '', visa_sponsor: '', visa_expiry: '',
  // 2026-09-06, gap-analysis batch 2 ("referral program tracking"):
  // referrer_candidate_id is resolved best-effort in save() below, never
  // typed directly — the form only ever collects the free-text name.
  referrer_name: '', referrer_candidate_id: null,
  // 2026-09-06, gap-analysis batch 3 ("silver-medalist / job-change
  // reactivation alerts"): a manual "keep on my radar" flag, distinct from
  // is_hotlisted (candidate-LED proactive marketing) — see the
  // migration's own column comment for the honest scope of what this is
  // and isn't.
  watch_for_reactivation: false, reactivation_note: '',
}

// Friendly labels for the CV auto-fill banner ("Annie read this CV and
// filled in: name, role, ..."), not the raw form-field keys.
const CV_FIELD_LABEL = {
  name: 'name', role: 'role', company: 'current company', location: 'location',
  email: 'email', phone: 'phone', nationality: 'nationality', industry: 'industry',
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
  const { currencyPrefix, currencyLabel, currencyCode, isGccMarket: isGcc } = useMarketCurrency()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [candidates, setCandidates] = useState([])
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  // 2026-09-06, gap-analysis batch 2 ("real Boolean / X-ray search"):
  // opt-in — the plain substring search stays the default for everyone
  // who never needs AND/OR/NOT, same "additive, not a replacement"
  // reasoning as booleanSearch.js's own header comment.
  const [booleanMode, setBooleanMode] = useState(false)
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

  // 2026-09-05, item 3 (Michael: "add the CV which moves from the bottom to
  // the top, where if you add the profile, annie picks up all the
  // details... letting the customer know that if they add the CV that
  // info will be automatically generated"). uploadedCvPath tracks a file
  // uploaded THIS session via handleCvFileChange, separate from
  // existingCvPath (an already-saved candidate's prior CV) — save() prefers
  // this over re-uploading the same file a second time.
  const [uploadedCvPath, setUploadedCvPath] = useState(null)
  const [cvParsing, setCvParsing] = useState(false)
  const [cvAutoFillMessage, setCvAutoFillMessage] = useState('')
  const [cvParseError, setCvParseError] = useState('')

  // "Also, as an additional point, we need an option where you can dump
  // multiple CVs and Annie can add it for you" — a separate, smaller modal
  // rather than folding into the single-candidate form above, since its job
  // is fundamentally different (create several rows unattended vs. review
  // one before saving).
  const [showBulkModal, setShowBulkModal] = useState(false)
  const [bulkFiles, setBulkFiles] = useState([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState('')
  const [bulkStatus, setBulkStatus] = useState(null)

  // 2026-09-06, item 6/7 (Michael: candidate placement should prompt for an
  // invoice). placementPrompt holds the dismissible page-level banner's
  // content once a save() flips a candidate to "placed"; invoicePrefill is
  // what InvoiceFormModal opens pre-linked with if the recruiter accepts it.
  // Both are best-effort/ephemeral — no DB state, nothing to clean up if
  // the recruiter just ignores or dismisses it, same "never block/never
  // require" precedent as maybeLogPlacement/maybeAddAsContact below.
  const [placementPrompt, setPlacementPrompt] = useState(null)
  const [invoicePrefill, setInvoicePrefill] = useState(null)
  const [showInvoiceForm, setShowInvoiceForm] = useState(false)

  // 2026-09-03, Michael: "you need to see who added the candidate in case
  // there are any ownerships... a drop down to that specific license with
  // everyone on the license." teamMembers backs both the owner filter below
  // and the Added-by/Owner block in the edit modal; ownerFilter narrows the
  // list to one member's records (or 'all', the default). dupWarning holds
  // an existing-candidate match found by email when adding a brand-new one
  // (see maybeCheckDuplicate) — never blocks the save outright, just asks
  // once before creating what might be a second copy of someone a
  // teammate already added.
  const [teamMembers, setTeamMembers] = useState([])
  const [ownerFilter, setOwnerFilter] = useState('all')
  const [dupWarning, setDupWarning] = useState(null)
  const [dupChecking, setDupChecking] = useState(false)
  // 2026-09-03, Michael's second oversights batch: candidate-led marketing
  // ("hotlist") is independent of the stage/owner filters above — a
  // hotlisted candidate can sit at any stage — so this ANDs with them
  // rather than being folded into the STAGES filter chips.
  const [hotlistOnly, setHotlistOnly] = useState(false)
  // 2026-09-06, gap-analysis batch 3: same independent-of-stage reasoning
  // as hotlistOnly above — a watched candidate is very often 'rejected'.
  const [reactivationOnly, setReactivationOnly] = useState(false)

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
      const [data, j, tm] = await Promise.all([
        listCandidatesWithJobs(user.id),
        listActiveJobsForPicker(user.id),
        listTeamMembers(),
      ])
      setCandidates(data)
      setJobs(j)
      setTeamMembers(tm)
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
  const searched = useMemo(
    () => (booleanMode ? searchCandidatesBoolean(candidates, search) : searchCandidates(candidates, search)),
    [candidates, search, booleanMode]
  )
  const ownerFiltered = useMemo(
    () => (ownerFilter === 'all' ? searched : searched.filter(c => c.owner_id === ownerFilter)),
    [searched, ownerFilter]
  )
  const stageCounts = useMemo(() => {
    const counts = {}
    for (const s of STAGES) counts[s] = ownerFiltered.filter(c => c.status === s).length
    return counts
  }, [ownerFiltered])
  const hotlistFiltered = useMemo(
    () => (hotlistOnly ? ownerFiltered.filter(c => c.is_hotlisted) : ownerFiltered),
    [ownerFiltered, hotlistOnly]
  )
  const reactivationFiltered = useMemo(
    () => (reactivationOnly ? hotlistFiltered.filter(c => c.watch_for_reactivation) : hotlistFiltered),
    [hotlistFiltered, reactivationOnly]
  )
  const stageFiltered = useMemo(() => filterCandidatesByStage(reactivationFiltered, filter), [reactivationFiltered, filter])
  const sorted = useMemo(() => sortCandidates(stageFiltered, sortBy), [stageFiltered, sortBy])
  const groups = filter === 'all' ? groupCandidatesByStage(sorted) : null

  function openAdd() {
    setForm({ ...EMPTY, curr_sal_currency: currencyCode, want_sal_currency: currencyCode })
    setEditId(null)
    setCvFile(null)
    setExistingCvPath(null)
    setUploadedCvPath(null)
    setCvAutoFillMessage('')
    setCvParseError('')
    setError('')
    setDupWarning(null)
    setShowModal(true)
  }
  function openEdit(c) {
    setForm({
      name: c.name || '', role: c.role || '', company: c.company || '', location: c.location || '', industry: c.industry || '', nationality: c.nationality || '',
      email: c.email || '', phone: c.phone || '', curr_sal: c.curr_sal || '', curr_sal_currency: c.curr_sal_currency || currencyCode,
      want_sal: c.want_sal || '', want_sal_currency: c.want_sal_currency || currencyCode,
      notice_period: c.notice_period || '', availability: c.availability || '', linkedin_url: c.linkedin_url || '',
      status: c.status || 'sourced', source: c.source || '', follow_up_date: c.follow_up_date || '', notes: c.notes || '', job_id: c.job_id || '',
      add_as_contact: false,
      titles: Array.isArray(c.titles) ? c.titles : [], industries: Array.isArray(c.industries) ? c.industries : [],
      counter_offer_risk: c.counter_offer_risk || '', counter_offer_notes: c.counter_offer_notes || '',
      is_hotlisted: !!c.is_hotlisted, hotlist_note: c.hotlist_note || '',
      visa_status: c.visa_status || '', visa_type: c.visa_type || '', visa_sponsor: c.visa_sponsor || '', visa_expiry: c.visa_expiry || '',
      referrer_name: c.referrer_name || '', referrer_candidate_id: c.referrer_candidate_id || null,
      watch_for_reactivation: !!c.watch_for_reactivation, reactivation_note: c.reactivation_note || '',
    })
    setEditId(c.id)
    setCvFile(null)
    setExistingCvPath(c.cv_path || null)
    setUploadedCvPath(null)
    setCvAutoFillMessage('')
    setCvParseError('')
    setError('')
    setDupWarning(null)
    setShowModal(true)
  }

  // CV-first auto-fill: uploads immediately (rather than waiting for Save,
  // like every other field here) so Annie has real bytes to read before the
  // recruiter has typed anything else — this is the whole point of moving
  // the CV field to the top of the form. Only fills a field that's
  // currently BLANK, never overwrites something the recruiter already
  // typed (e.g. re-attaching a corrected CV on an in-progress edit).
  async function handleCvFileChange(file) {
    setCvFile(file)
    setUploadedCvPath(null)
    setCvAutoFillMessage('')
    setCvParseError('')
    if (!file) return

    setCvParsing(true)
    try {
      const ext = file.name.split('.').pop()
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await supabase.storage.from('candidate-cvs').upload(path, file, { upsert: true, contentType: file.type })
      if (upErr) { setCvParseError('CV upload failed: ' + upErr.message); return }
      setUploadedCvPath(path)

      const result = await parseCvViaAnnie(path)
      if (!result?.ok) {
        setCvParseError(result?.message || 'Annie couldn’t read this CV automatically — please fill in the details manually.')
        return
      }

      const p = result.parsed
      const filled = []
      setForm(prev => {
        const next = { ...prev }
        const maybeFill = (key, value) => {
          if (value && !String(prev[key] || '').trim()) { next[key] = value; filled.push(CV_FIELD_LABEL[key]) }
        }
        maybeFill('name', p.name)
        maybeFill('role', p.current_role)
        maybeFill('company', p.current_company)
        maybeFill('location', p.location)
        maybeFill('email', p.email)
        maybeFill('phone', p.phone)
        maybeFill('nationality', p.nationality)
        if (p.industries[0] && !prev.industry.trim()) { next.industry = p.industries[0]; filled.push(CV_FIELD_LABEL.industry) }
        if (p.titles.length) next.titles = p.titles
        if (p.industries.length) next.industries = p.industries
        return next
      })
      setCvAutoFillMessage(
        filled.length
          ? `Annie read this CV and filled in: ${filled.join(', ')}. Please check it over before saving.`
          : 'Annie read this CV — every field already had something in it, so nothing was overwritten, but she has picked up extra matching detail below.'
      )
    } catch (err) {
      setCvParseError(err.message || 'Annie couldn’t read this CV automatically — please fill in the details manually.')
    } finally {
      setCvParsing(false)
    }
  }

  // "we need an option where you can dump multiple CVs and Annie can add
  // it for you" — uploads every file first (so parse-cvs-bulk-background.js
  // only ever reads from storage, same as the single-CV path), fires the
  // background worker, then polls cv-bulk-status.js until it's done.
  async function startBulkImport() {
    if (!bulkFiles.length) return
    setBulkBusy(true)
    setBulkError('')
    setBulkStatus(null)
    try {
      const paths = []
      for (const file of bulkFiles) {
        const ext = file.name.split('.').pop()
        const path = `${user.id}/${crypto.randomUUID()}.${ext}`
        const { error: upErr } = await supabase.storage.from('candidate-cvs').upload(path, file, { upsert: true, contentType: file.type })
        if (upErr) throw new Error(`Couldn’t upload ${file.name}: ${upErr.message}`)
        paths.push(path)
      }
      const triggered = await triggerBulkCvImport(paths)
      if (!triggered) throw new Error('Couldn’t start the bulk import — please try again.')
      pollBulkStatus()
    } catch (err) {
      setBulkError(err.message)
      setBulkBusy(false)
    }
  }

  function pollBulkStatus() {
    const tick = async () => {
      const status = await fetchCvBulkStatus()
      setBulkStatus(status)
      if (status?.status === 'done') {
        setBulkBusy(false)
        load()
        return
      }
      setTimeout(tick, 3000)
    }
    setTimeout(tick, 2000)
  }

  function closeBulkModal() {
    setShowBulkModal(false)
    setBulkFiles([])
    setBulkError('')
    setBulkStatus(null)
    setBulkBusy(false)
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

  // "Add invoice prompt on candidate placement" — same trigger condition as
  // maybeLogPlacement above (status just flipped to "placed"), but this one
  // surfaces something the recruiter can act on immediately instead of a
  // silent background log. candidateId is only ever known for an edit
  // (editId); a brand-new row saved as already-placed has no id back from
  // createCandidate (it doesn't select() its insert) — the prompt still
  // fires, InvoiceFormModal's own "Candidate placed" dropdown just won't be
  // pre-selected, matching the same "best-effort, never block" precedent.
  function maybeOfferInvoicePrompt(row, previousStatus, candidateId, candidateName) {
    if (row.status !== 'placed' || previousStatus === 'placed' || !row.company) return
    setPlacementPrompt({ candidateId: candidateId || null, candidateName, company: row.company.trim(), jobId: row.job_id || null })
  }

  async function acceptInvoicePrompt() {
    if (!placementPrompt) return
    const { candidateId, candidateName, company, jobId } = placementPrompt
    setPlacementPrompt(null)
    let companyId = null
    try {
      companyId = await findOrCreateCompany(company, user.id)
    } catch {
      // Best-effort — the form still opens and the recruiter can pick the
      // company themselves via CompanySelect's own "+ Add company" option.
    }
    setInvoicePrefill({
      company_id: companyId || '',
      company_name: company,
      job_id: jobId || '',
      candidate_id: candidateId || '',
      bill_to_name: company,
    })
    setShowInvoiceForm(true)
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

  async function save({ skipDupCheck = false } = {}) {
    if (!form.name.trim()) return setError('Name is required')

    // 2026-09-03, Michael: "in case there are any ownerships" — checked once
    // per Save click for a brand-new candidate with an email on file, and
    // only skipped once the recruiter has explicitly clicked "Save as new
    // anyway" on the warning banner above.
    //
    // 2026-09-03 (second oversights batch, "double-submission warnings"):
    // when a job is selected, check the job-scoped duplicate FIRST —
    // findDuplicateSubmission is the more specific, more dangerous case
    // (this exact person already in THIS job's pipeline, possibly under a
    // different owner — the classic "two recruiters submit the same
    // candidate to the same client" landmine) and gets its own message
    // below. Only falls back to the general team-wide check when there's
    // no job-scoped match, so a genuine cross-job duplicate is still
    // caught even when this particular save isn't the double-submission
    // case.
    if (!editId && form.email.trim() && !skipDupCheck) {
      setDupChecking(true)
      try {
        const jobDup = form.job_id ? await findDuplicateSubmission(form.email, form.job_id) : null
        const dup = jobDup || await findCandidateDuplicateByEmail(form.email)
        if (dup) {
          setDupWarning({ id: dup.id, name: dup.name, ownerName: nameForMember(teamMembers, dup.owner_id), sameJob: !!jobDup })
          return
        }
      } catch {
        // Best-effort — never block a genuine save on a failed dup-check.
      } finally {
        setDupChecking(false)
      }
    }

    setSaving(true)
    setError('')
    try {
      // 2026-09-05: handleCvFileChange already uploaded the file the moment
      // it was selected (so it could hand real bytes to parse-cv.js for
      // auto-fill) — reuse that path rather than uploading the same file a
      // second time. Only falls back to uploading here if that earlier
      // upload never happened for some reason (e.g. it failed silently),
      // same upload call this always used to make unconditionally.
      let cvPath = existingCvPath
      if (uploadedCvPath) {
        cvPath = uploadedCvPath
      } else if (cvFile) {
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
        visa_status: form.visa_status || null,
        visa_type: form.visa_type || null,
        visa_sponsor: form.visa_sponsor?.trim() || null,
        visa_expiry: form.visa_expiry || null,
        referrer_name: form.referrer_name.trim() || null,
        // Best-effort re-resolve on every save (not just at typing time) —
        // cheap, and picks up a referrer who gets added to the CRM later.
        referrer_candidate_id: form.referrer_name.trim() ? await findCandidateIdByExactName(form.referrer_name).catch(() => null) : null,
        watch_for_reactivation: form.watch_for_reactivation,
        reactivation_note: form.reactivation_note.trim() || null,
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
      maybeOfferInvoicePrompt(row, previousStatus, editId, row.name)
      setDupWarning(null)
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
                  {c.is_hotlisted && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700" title={c.hotlist_note || 'Being proactively marketed'}>🔥 Hotlist</span>}
                  {c.counter_offer_risk && (
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${c.counter_offer_risk === 'high' ? 'bg-red-100 text-red-600' : c.counter_offer_risk === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}
                      title={c.counter_offer_notes || 'Counter-offer risk'}
                    >
                      ⚠️ {c.counter_offer_risk} counter-offer risk
                    </span>
                  )}
                  {/* 2026-09-06, Michael: "we can get rid of the visa
                      sponsorship badge... too smart, overkill" — the visa
                      expiry badge (GCC-only, below) and the underlying
                      visa fields on the form stay; this specific status
                      pill is removed. */}
                  {isGcc && (() => {
                    const badge = visaExpiryBadge(c.visa_expiry)
                    if (!badge) return null
                    const cls = badge.level === 'critical' ? 'bg-red-100 text-red-600' : badge.level === 'watch' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'
                    return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${cls}`} title={c.visa_type ? `${VISA_TYPE_LABEL[c.visa_type] || c.visa_type} visa` : ''}>🛂 {badge.label}</span>
                  })()}
                  {c.referrer_name && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-600" title={c.referrer_candidate_id ? 'Linked to an existing candidate record' : 'Referrer not yet in the CRM'}>🤝 Referred by {c.referrer_name}</span>
                  )}
                  {c.watch_for_reactivation && (
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700" title={c.reactivation_note || 'Flagged to revisit for a future role'}>👁️ Reactivation watch</span>
                  )}
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
        <div className="flex gap-2">
          <button onClick={() => setShowBulkModal(true)} className="btn-ghost">📥 Bulk import CVs</button>
          <button onClick={openAdd} className="btn-primary">+ Add Candidate</button>
        </div>
      </div>

      {placementPrompt && (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 mb-6 flex-wrap">
          <span className="text-sm text-emerald-800">
            🎉 <b>{placementPrompt.candidateName}</b> was placed at <b>{placementPrompt.company}</b>. Create an invoice for this placement?
          </span>
          <div className="flex gap-2 ml-auto">
            <button onClick={() => setPlacementPrompt(null)} className="text-xs font-semibold text-emerald-700 hover:underline px-2">Not now</button>
            <button onClick={acceptInvoicePrompt} className="btn-primary text-xs px-3 py-1.5">Create invoice</button>
          </div>
        </div>
      )}

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
          <input
            className="input max-w-sm"
            placeholder={booleanMode ? 'e.g. python AND (django OR flask) NOT contractor' : 'Search candidates...'}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button
            onClick={() => setBooleanMode(v => !v)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${booleanMode ? 'bg-navy border-navy text-white' : 'border-gray-200 text-gray-600'}`}
            title='Boolean / X-ray search: AND, OR, NOT, "exact phrases", and (grouping)'
          >
            {'{ }'} Boolean
          </button>
          <OwnerFilter value={ownerFilter} onChange={setOwnerFilter} teamMembers={teamMembers} />
          <button
            onClick={() => setHotlistOnly(v => !v)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${hotlistOnly ? 'bg-amber-500 border-amber-500 text-white' : 'border-gray-200 text-gray-600'}`}
            title="Candidate-led marketing: strong/available candidates being proactively marketed, regardless of stage"
          >
            🔥 Hotlist <span className="opacity-70">({ownerFiltered.filter(c => c.is_hotlisted).length})</span>
          </button>
          <button
            onClick={() => setReactivationOnly(v => !v)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${reactivationOnly ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-200 text-gray-600'}`}
            title="Candidates flagged to revisit for a future role, regardless of stage"
          >
            👁️ Reactivation <span className="opacity-70">({ownerFiltered.filter(c => c.watch_for_reactivation).length})</span>
          </button>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setFilter('all')} className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 ${filter === 'all' ? 'bg-navy border-navy text-white' : 'border-gray-200 text-gray-600'}`}>
              All <span className="opacity-70">({ownerFiltered.length})</span>
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
      ) : ownerFiltered.length === 0 ? (
        // Owner filter narrowed a non-empty search down to nobody — its own
        // empty state, same precedent as the stage/search ones above it,
        // rather than falling through to the stage-filter message below
        // (which would misleadingly blame the stage instead of the owner).
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🗂️</div>
          <h3 className="font-bold text-navy mb-1">No candidates owned by {teamMembers.find(m => m.id === ownerFilter)?.name || 'that team member'}{search ? ` matching "${search}"` : ''}</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different team member, or clear this filter to see all {searched.length} candidate{searched.length === 1 ? '' : 's'}{search ? ' matching your search' : ''}.</p>
          <button onClick={() => setOwnerFilter('all')} className="btn-ghost">Show everyone's candidates</button>
        </div>
      ) : stageFiltered.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🗂️</div>
          <h3 className="font-bold text-navy mb-1">No candidates in {STAGE_LABEL[filter]}{search ? ` matching "${search}"` : ''}</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different stage, or clear this filter to see all {ownerFiltered.length} candidate{ownerFiltered.length === 1 ? '' : 's'}{search ? ' matching your search' : ''}.</p>
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

            {editId && (
              <div className="mb-4">
                <OwnershipPanel
                  table="candidates"
                  record={candidates.find(c => c.id === editId)}
                  teamMembers={teamMembers}
                  onReassigned={updated => setCandidates(prev => prev.map(c => (c.id === updated.id ? { ...c, owner_id: updated.owner_id } : c)))}
                />
              </div>
            )}

            {/* 2026-09-03, Michael: "in case there are any ownerships" — a
                brand-new candidate whose email matches one someone else on
                the team already added. Never blocks outright (a genuine
                second candidate can share an inbox with a spouse, or the
                match can be a coincidence) — just makes sure it's a
                deliberate choice, once, before creating what might be a
                duplicate nobody else knows exists. */}
            {dupWarning && (
              <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 flex-wrap">
                <span className="text-sm text-amber-800">
                  {dupWarning.sameJob ? (
                    <>⚠️ <b>{dupWarning.name}</b> has already been submitted to this exact role with this email{dupWarning.ownerName ? ` by ${dupWarning.ownerName}` : ''} — submitting again risks a double-submission to the same client.</>
                  ) : (
                    <>⚠️ <b>{dupWarning.name}</b> is already in the CRM with this email{dupWarning.ownerName ? ` (owned by ${dupWarning.ownerName})` : ''}.</>
                  )}
                </span>
                <div className="flex gap-2 ml-auto">
                  <button
                    onClick={() => { setShowModal(false); setDupWarning(null); openEdit(candidates.find(c => c.id === dupWarning.id)) }}
                    className="text-xs font-semibold text-amber-800 hover:underline px-2"
                  >
                    View existing
                  </button>
                  <button onClick={() => { const w = dupWarning; setDupWarning(null); save({ skipDupCheck: true }) }} className="btn-primary text-xs px-3 py-1.5">
                    Save as new anyway
                  </button>
                </div>
              </div>
            )}

            {/* 2026-09-05, item 3, Michael: "add the CV which moves from
                the bottom to the top, where if you add the profile, annie
                picks up all the details... letting the customer know that
                if they add the CV that info will be automatically
                generated" — CV is now the FIRST thing in the form, and
                selecting one immediately uploads + reads it via
                handleCvFileChange, before anything else is typed. */}
            <div className="mb-4">
              <label className="label" htmlFor="candidate-cv">CV {!editId && <span className="text-gray-400 font-normal normal-case">— attach first and Annie will fill in what she can below</span>}</label>
              {existingCvPath && !cvFile ? (
                <div className="flex items-center gap-2 bg-page-bg rounded-lg px-3 py-2">
                  <span className="text-xs text-gray-600 flex-1 truncate">CV on file</span>
                  <button type="button" onClick={() => viewCv(existingCvPath)} className="text-xs font-semibold text-gold-ink">View</button>
                  <button type="button" onClick={() => setExistingCvPath(null)} className="text-xs font-semibold text-red-400">Remove</button>
                </div>
              ) : (
                <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center">
                  <input id="candidate-cv" type="file" accept=".pdf,.doc,.docx" onChange={e => handleCvFileChange(e.target.files?.[0] || null)} className="text-xs" disabled={cvParsing} />
                  <p className="text-[11px] text-gray-400 mt-1">
                    {cvParsing ? 'Annie is reading this CV...' : cvFile ? cvFile.name + ' uploaded' : 'PDF or Word doc, max 20MB'}
                  </p>
                </div>
              )}
              {cvAutoFillMessage && !cvParsing && (
                <p className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2 mt-2">✨ {cvAutoFillMessage}</p>
              )}
              {cvParseError && !cvParsing && (
                <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-2">{cvParseError}</p>
              )}
            </div>

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
                <label className="label" htmlFor="candidate-nationality">
                  Nationality
                  <InfoTip text="Saudi and Emirati candidates are only ever suggested for jobs based in Saudi Arabia or the UAE respectively — never elsewhere." />
                </label>
                <input id="candidate-nationality" className="input" value={form.nationality} onChange={e => setForm(p => ({ ...p, nationality: e.target.value }))} />
              </div>
              {/* 2026-09-05: Annie's own CV-parse read on every OTHER title/
                  industry this candidate's real experience could plausibly
                  match — read-only here (it's an AI inference used for
                  matching, not a field the recruiter fills in directly),
                  shown only once there's something to show. */}
              {(form.titles.length > 0 || form.industries.length > 0) && (
                <div className="col-span-2 text-xs text-gray-500 bg-page-bg rounded-lg px-3 py-2">
                  {form.titles.length > 0 && <p>💡 Also matched to jobs titled: {form.titles.join(', ')}</p>}
                  {form.industries.length > 0 && <p className={form.titles.length ? 'mt-1' : ''}>Relevant industries: {form.industries.join(', ')}</p>}
                </div>
              )}
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
              {/* 2026-09-06, gap-analysis batch 2: turns "Referral" from a
                  label in the source field above into an actual program —
                  who referred them, resolved to a real candidate record
                  automatically when that name matches one on save(). */}
              <div>
                <label className="label" htmlFor="candidate-referrer">Referred by (optional)</label>
                <input id="candidate-referrer" className="input" placeholder="Name of the person who referred them" value={form.referrer_name} onChange={e => setForm(p => ({ ...p, referrer_name: e.target.value }))} />
              </div>
              <div>
                <label className="label" htmlFor="candidate-follow-up-date">Follow-up date</label>
                <input id="candidate-follow-up-date" className="input" type="date" value={form.follow_up_date} onChange={e => setForm(p => ({ ...p, follow_up_date: e.target.value }))} />
              </div>
              {/* 2026-09-03, Michael's second oversights batch: no competitor
                  CRM (Bullhorn/JobAdder/Vincere/Loxo/Crelate) has a named
                  counter-offer-risk field per the same-day research — this
                  is a genuine differentiator, not catch-up, so it's a plain
                  recruiter judgment call rather than anything Annie infers
                  automatically. Left blank by default; only shown/relevant
                  once a candidate is far enough along to matter, but not
                  gated behind stage so a recruiter can flag it the moment
                  they sense it, however early. */}
              <div>
                <label className="label" htmlFor="candidate-counter-offer-risk">Counter-offer risk</label>
                <select id="candidate-counter-offer-risk" className="input" value={form.counter_offer_risk} onChange={e => setForm(p => ({ ...p, counter_offer_risk: e.target.value }))}>
                  <option value="">Not assessed</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
              {form.counter_offer_risk && (
                <div className="col-span-2">
                  <label className="label" htmlFor="candidate-counter-offer-notes">Why (optional)</label>
                  <input id="candidate-counter-offer-notes" className="input" placeholder="e.g. salary-driven, recent promotion talk, hesitant about reasons for leaving" value={form.counter_offer_notes} onChange={e => setForm(p => ({ ...p, counter_offer_notes: e.target.value }))} />
                </div>
              )}
              {/* Candidate-LED marketing (as opposed to every other field on
                  this form, which is about matching this person to a
                  specific job) — the researched "hotlist" pattern (Vincere):
                  tag a strong, available candidate for proactive marketing
                  to clients even with no open role for them yet. */}
              <div className="col-span-2 flex items-start gap-2">
                <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer mt-1.5">
                  <input type="checkbox" checked={form.is_hotlisted} onChange={e => setForm(p => ({ ...p, is_hotlisted: e.target.checked }))} />
                  🔥 Hotlist — market proactively, even without an open role
                </label>
              </div>
              {form.is_hotlisted && (
                <div className="col-span-2">
                  <label className="label" htmlFor="candidate-hotlist-note">Hotlist note (optional)</label>
                  <input id="candidate-hotlist-note" className="input" placeholder="What makes them worth marketing right now" value={form.hotlist_note} onChange={e => setForm(p => ({ ...p, hotlist_note: e.target.value }))} />
                </div>
              )}
              {/* 2026-09-06, gap-analysis batch 3 ("silver-medalist / job-
                  change reactivation alerts"): distinct from hotlist above —
                  this is specifically "didn't get this role, worth
                  revisiting for the next one", most useful once rejected. */}
              <div className="col-span-2 flex items-start gap-2">
                <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer mt-1.5">
                  <input type="checkbox" checked={form.watch_for_reactivation} onChange={e => setForm(p => ({ ...p, watch_for_reactivation: e.target.checked }))} />
                  👁️ Watch for reactivation — revisit for future roles
                </label>
              </div>
              {form.watch_for_reactivation && (
                <div className="col-span-2">
                  <label className="label" htmlFor="candidate-reactivation-note">Reactivation note (optional)</label>
                  <input id="candidate-reactivation-note" className="input" placeholder="Why they're worth revisiting" value={form.reactivation_note} onChange={e => setForm(p => ({ ...p, reactivation_note: e.target.value }))} />
                </div>
              )}
              {/* 2026-09-06, gap-analysis batch 1: the single field every GCC
                  recruiter needs first — whether this candidate can even be
                  submitted for a role that can't sponsor. GCC-only: a UK
                  account has no use for this (2026-09-06, Michael: "make
                  sure it is only specifically shown for recruiters in UAE
                  and not UK"). */}
              {isGcc && (
                <>
                  <div>
                    <label className="label" htmlFor="candidate-visa-status">🛂 Visa status</label>
                    <select id="candidate-visa-status" className="input" value={form.visa_status} onChange={e => setForm(p => ({ ...p, visa_status: e.target.value }))}>
                      <option value="">Not set</option>
                      <option value="own_visa">Own visa (transferable)</option>
                      <option value="needs_sponsorship">Needs sponsorship</option>
                      <option value="sponsored_by_agency">Sponsored by this agency</option>
                      <option value="not_required">Not required (citizen/resident)</option>
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="candidate-visa-type">Visa type</label>
                    <select id="candidate-visa-type" className="input" value={form.visa_type} onChange={e => setForm(p => ({ ...p, visa_type: e.target.value }))}>
                      <option value="">Not set</option>
                      <option value="employment">Employment</option>
                      <option value="golden">Golden</option>
                      <option value="dependent">Dependent</option>
                      <option value="freelance">Freelance</option>
                      <option value="visit">Visit</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="candidate-visa-sponsor">Current sponsor</label>
                    <input id="candidate-visa-sponsor" className="input" placeholder="Employer name, if sponsored" value={form.visa_sponsor} onChange={e => setForm(p => ({ ...p, visa_sponsor: e.target.value }))} />
                  </div>
                  <div>
                    <label className="label" htmlFor="candidate-visa-expiry">Visa expiry</label>
                    <input id="candidate-visa-expiry" className="input" type="date" value={form.visa_expiry} onChange={e => setForm(p => ({ ...p, visa_expiry: e.target.value }))} />
                  </div>
                </>
              )}
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
            </div>

            <div className="flex gap-3 justify-end mt-5">
              <button onClick={() => setShowModal(false)} className="btn-ghost">Cancel</button>
              <button onClick={() => save()} disabled={saving || dupChecking} className="btn-primary">{dupChecking ? 'Checking...' : saving ? 'Saving...' : 'Save candidate'}</button>
            </div>
      </Modal>

      {/* "we need an option where you can dump multiple CVs and Annie can
          add it for you" — each file becomes its own candidate row,
          unattended, via parse-cvs-bulk-background.js; this modal just
          uploads the files, fires it, and polls cv-bulk-status.js for
          live per-file progress. */}
      <Modal open={showBulkModal} onClose={closeBulkModal} title="Bulk import CVs" maxWidth="max-w-lg">
        <p className="text-sm text-gray-500 mb-3">Select several CVs at once and Annie will read each one and add it as a candidate — review and edit any of them afterwards, same as always.</p>
        <ErrorBanner>{bulkError}</ErrorBanner>

        {!bulkStatus && (
          <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center">
            <input
              type="file"
              accept=".pdf,.doc,.docx"
              multiple
              disabled={bulkBusy}
              onChange={e => setBulkFiles(Array.from(e.target.files || []))}
              className="text-xs"
            />
            <p className="text-[11px] text-gray-400 mt-1">{bulkFiles.length ? `${bulkFiles.length} file${bulkFiles.length === 1 ? '' : 's'} selected` : 'PDF or Word docs'}</p>
          </div>
        )}

        {bulkStatus && (
          <div className="mt-2 space-y-2">
            <p className="text-sm font-semibold text-navy">
              {bulkStatus.status === 'done' ? 'Done' : `Reading ${bulkStatus.completed || 0} of ${bulkStatus.total || bulkFiles.length}...`}
            </p>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {(bulkStatus.results || []).map((r, i) => (
                <div key={i} className="flex items-center gap-2 text-xs bg-page-bg rounded-lg px-3 py-2">
                  <span>{r.outcome === 'created' ? '✅' : '⚠️'}</span>
                  <span className="flex-1 truncate">{r.outcome === 'created' ? r.name : (r.reason || 'Couldn’t import this one')}</span>
                </div>
              ))}
            </div>
            {bulkStatus.status === 'done' && bulkStatus.total > 0 && (
              <p className="text-xs text-gray-500">
                Added {(bulkStatus.results || []).filter(r => r.outcome === 'created').length} of {bulkStatus.total} as new candidates.
              </p>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-end mt-5">
          <button onClick={closeBulkModal} className="btn-ghost">{bulkStatus?.status === 'done' ? 'Close' : 'Cancel'}</button>
          {bulkStatus?.status !== 'done' && (
            <button onClick={startBulkImport} disabled={bulkBusy || !bulkFiles.length} className="btn-primary">
              {bulkBusy ? 'Importing...' : `Import ${bulkFiles.length || ''} CV${bulkFiles.length === 1 ? '' : 's'}`}
            </button>
          )}
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

      <InvoiceFormModal
        open={showInvoiceForm}
        invoice={null}
        prefill={invoicePrefill}
        onClose={() => setShowInvoiceForm(false)}
        onSaved={() => setShowInvoiceForm(false)}
      />
    </div>
  )
}

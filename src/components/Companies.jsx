import React, { useState, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { normalizeCompanyName } from '../lib/companyMatch'
import { listCompanies, createCompany, updateCompany, deleteCompany } from '../lib/data/companies'
import { listContactsWithCompany } from '../lib/data/contacts'
import { listJobsMinimal } from '../lib/data/jobs'
import { listCompanyDocuments, createCompanyDocument, deleteCompanyDocument } from '../lib/data/companyDocuments'
import { listTeamMembers, nameForMember } from '../lib/data/teamMembers'
import { listIndustries, searchCompanies, filterCompaniesByIndustry, sortCompanies } from '../lib/companiesView'
import InfoTip from './InfoTip'
import ContactFormModal from './ContactFormModal'
import ContactDetailModal from './ContactDetailModal'
import JobFormModal from './JobFormModal'
import ConfirmDialog from './ConfirmDialog'
import Modal from './Modal'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import OwnerFilter from './OwnerFilter'
import OwnershipPanel from './OwnershipPanel'

const EMPTY_CO = { name: '', industry: '', location: '', website: '', notes: '' }
const STATUS_COLOR = { hot: 'bg-red-100 text-red-700', warm: 'bg-amber-100 text-amber-700', cold: 'bg-blue-100 text-blue-700', client: 'bg-green-100 text-green-700', inactive: 'bg-gray-100 text-gray-500' }
const JOB_STATUS_COLOR = { active: 'bg-green-100 text-green-700', onhold: 'bg-amber-100 text-amber-700', filled: 'bg-yellow-100 text-gold', lost: 'bg-gray-100 text-gray-500' }

function initials(name) { return (name || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() }
function color(name) {
  const colors = ['#c9a84c', '#0d1b3e', '#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed']
  let h = 0
  for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h)
  return colors[Math.abs(h) % colors.length]
}

export default function Companies() {
  const { user } = useAuth()
  const location = useLocation()
  const [companies, setCompanies] = useState([])
  const [contacts, setContacts] = useState([])
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [industryFilter, setIndustryFilter] = useState('all')
  const [sortBy, setSortBy] = useState('name')
  const [listError, setListError] = useState('')
  // 2026-09-03, Michael: "a drop down to that specific license with
  // everyone on the license so that you can always see who added the
  // company" — same teamMembers/ownerFilter pattern as Candidates/Contacts.
  const [teamMembers, setTeamMembers] = useState([])
  const [ownerFilter, setOwnerFilter] = useState('all')

  const [showCoModal, setShowCoModal] = useState(false)
  const [editCo, setEditCo] = useState(null)
  const [coForm, setCoForm] = useState(EMPTY_CO)
  const [coSaving, setCoSaving] = useState(false)
  const [coError, setCoError] = useState('')
  const [coNote, setCoNote] = useState('')

  const [selected, setSelected] = useState(null)
  const [tab, setTab] = useState('contacts')
  const [showContactModal, setShowContactModal] = useState(false)
  const [showJobModal, setShowJobModal] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [delError, setDelError] = useState('')
  // 2026-09-01: click-to-expand — a company's own contact list rows were
  // fully inert before this (no click action at all, not even Edit).
  const [detailContactId, setDetailContactId] = useState(null)

  // 2026-09-04, Michael: "Should be able to attach a document next to a
  // client... if you sign a contract with the client, you can attach it to
  // their name" — a third tab alongside Contacts/Jobs, same per-company
  // detail-panel pattern. Loaded lazily per selected company (not batched
  // into the page's own load() above) since most companies won't have any
  // documents most of the time, and the file list itself is cheap to fetch
  // on demand rather than for every company up front.
  const [documents, setDocuments] = useState([])
  const [docsLoading, setDocsLoading] = useState(false)
  const [docFile, setDocFile] = useState(null)
  const [docUploading, setDocUploading] = useState(false)
  const [docError, setDocError] = useState('')
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState(null)

  useEffect(() => { load() }, [user])
  useEffect(() => { if (location.state?.autoOpenAdd) openAddCo() }, [location.state])
  useEffect(() => { if (selected) loadDocuments(selected.id) }, [selected?.id])

  async function loadDocuments(companyId) {
    setDocsLoading(true)
    setDocError('')
    try {
      setDocuments(await listCompanyDocuments(companyId))
    } catch (err) {
      setDocError(err.message || 'Could not load documents for this company.')
    } finally {
      setDocsLoading(false)
    }
  }

  async function uploadDocument() {
    if (!docFile || !selected) return
    setDocUploading(true)
    setDocError('')
    try {
      const ext = docFile.name.split('.').pop()
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`
      const { error: upErr } = await supabase.storage.from('company-documents').upload(path, docFile, { upsert: true, contentType: docFile.type })
      if (upErr) throw new Error('Upload failed: ' + upErr.message)
      const { error: err } = await createCompanyDocument({
        company_id: selected.id, user_id: user.id, file_name: docFile.name, file_path: path,
      })
      if (err) throw err
      setDocFile(null)
      await loadDocuments(selected.id)
    } catch (err) {
      setDocError(err.message)
    } finally {
      setDocUploading(false)
    }
  }

  async function viewDocument(path) {
    const { data, error } = await supabase.storage.from('company-documents').createSignedUrl(path, 3600)
    if (error) return alert('Could not open document: ' + error.message)
    window.open(data.signedUrl, '_blank')
  }

  async function deleteDocument(id, path) {
    setDocError('')
    // Best-effort on the storage object — if it's already gone (or the
    // delete races another tab), the DB row is still the source of truth
    // for what's "attached to this company" and must come off the list
    // either way, same non-blocking precedent as candidate CV handling.
    try { await supabase.storage.from('company-documents').remove([path]) } catch {}
    const { error: err } = await deleteCompanyDocument(id)
    if (err) { setDocError(err.message); return }
    setDocuments(prev => prev.filter(d => d.id !== id))
  }

  async function load() {
    setLoading(true)
    setListError('')
    // 2026-08-24 Task 2: routed through lib/data/* (previously duplicated
    // inline here) so this table's query shape lives in exactly one place.
    // 2026-08-26 audit fix: each of these now throws on a real Supabase
    // error instead of quietly returning [] — previously that looked
    // identical to "you have no companies/contacts/jobs yet".
    try {
      const [co, ct, jb, tm] = await Promise.all([
        listCompanies(user.id),
        listContactsWithCompany(user.id),
        listJobsMinimal(user.id),
        listTeamMembers(),
      ])
      setCompanies(co)
      setContacts(ct)
      setJobs(jb)
      setTeamMembers(tm)
    } catch (err) {
      setListError(err.message || 'Could not load your companies. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  function contactsFor(id) { return contacts.filter(c => c.company_id === id) }
  function jobsFor(id) { return jobs.filter(j => j.company_id === id) }

  // 2026-08-29 audit fix, flagged directly: this grid had no way to narrow
  // or reorder a large company list — only alphabetical-ish order plus
  // free-text search. Industry filter chips + a sort control are new; the
  // filtering/sorting logic itself lives in lib/companiesView.js so it's
  // unit-tested rather than only reachable through this render.
  const searched = useMemo(() => searchCompanies(companies, search), [companies, search])
  const ownerFiltered = useMemo(
    () => (ownerFilter === 'all' ? searched : searched.filter(c => c.owner_id === ownerFilter)),
    [searched, ownerFilter]
  )
  const industries = useMemo(() => listIndustries(ownerFiltered), [ownerFiltered])
  const industryCounts = useMemo(() => {
    const counts = {}
    for (const ind of industries) counts[ind] = ownerFiltered.filter(c => c.industry === ind).length
    return counts
  }, [industries, ownerFiltered])
  const industryFiltered = useMemo(() => filterCompaniesByIndustry(ownerFiltered, industryFilter), [ownerFiltered, industryFilter])
  const counts = useMemo(() => {
    const map = {}
    for (const co of companies) {
      map[co.id] = {
        contacts: contactsFor(co.id).length,
        openJobs: jobsFor(co.id).filter(j => j.status === 'active' || j.status === 'onhold').length,
      }
    }
    return map
  }, [companies, contacts, jobs])
  const filtered = useMemo(() => sortCompanies(industryFiltered, sortBy, counts), [industryFiltered, sortBy, counts])

  function openAddCo() { setCoForm(EMPTY_CO); setEditCo(null); setCoError(''); setCoNote(''); setShowCoModal(true) }
  function openEditCo(co) { setCoForm({ name: co.name, industry: co.industry || '', location: co.location || '', website: co.website || '', notes: co.notes || '' }); setEditCo(co); setCoError(''); setCoNote(''); setShowCoModal(true) }

  async function saveCo() {
    const name = coForm.name.trim()
    if (!name) return setCoError('Company name is required')

    // Same dedupe rule as CompanySelect's add-company flow: never create a
    // second row for a company that's already here under a different
    // spelling ("Acme Ltd" vs "Acme Limited" vs "acme").
    if (!editCo) {
      const existing = companies.find(c => normalizeCompanyName(c.name) === normalizeCompanyName(name))
      if (existing) {
        setShowCoModal(false)
        setSelected(existing)
        setTab('contacts')
        setDelError('')
        // 2026-09-03, Michael: "in case there are any ownerships" — this
        // already stopped a duplicate company row; now it also says who
        // already owns it, same reasoning as the candidate/contact
        // duplicate warnings.
        const addedByName = nameForMember(teamMembers, existing.owner_id)
        setCoNote(`Using existing record for ${existing.name}${addedByName ? ` (owned by ${addedByName})` : ''}`)
        return
      }
    }

    setCoSaving(true)
    setCoError('')
    try {
      const row = {
        name, industry: coForm.industry.trim() || null, location: coForm.location.trim() || null,
        website: coForm.website.trim() || null, notes: coForm.notes.trim() || null, updated_at: new Date().toISOString(),
      }
      if (editCo) {
        const { error: err } = await updateCompany(editCo.id, row)
        if (err) throw err
      } else {
        const { error: err } = await createCompany(row, user.id)
        if (err) throw err
      }
      await load()
      setShowCoModal(false)
    } catch (err) {
      setCoError(err.message)
    } finally {
      setCoSaving(false)
    }
  }

  async function delCo(id) {
    setDelError('')
    const { error: err } = await deleteCompany(id)
    if (err) { setDelError(err.message); return }
    setSelected(null)
    await load()
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            Companies
            <InfoTip text="The single source of truth for every client. Contacts and jobs attach to a company from a dropdown, so the same client never gets added twice." />
          </h1>
          <p className="text-gray-500 mt-1">{companies.length} companies</p>
        </div>
        <button onClick={openAddCo} className="btn-primary">+ Add Company</button>
      </div>

      <ErrorBanner>{listError}</ErrorBanner>

      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <input className="input max-w-sm" placeholder="Search companies..." value={search} onChange={e => setSearch(e.target.value)} />
          <OwnerFilter value={ownerFilter} onChange={setOwnerFilter} teamMembers={teamMembers} />
          {industries.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setIndustryFilter('all')}
                className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors ${industryFilter === 'all' ? 'bg-navy text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
              >
                All <span className="opacity-70">({ownerFiltered.length})</span>
              </button>
              {industries.map(ind => (
                <button
                  key={ind}
                  onClick={() => setIndustryFilter(ind)}
                  className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors ${industryFilter === ind ? 'bg-navy text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
                >
                  {ind} <span className="opacity-70">({industryCounts[ind] || 0})</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <select className="input max-w-[190px]" value={sortBy} onChange={e => setSortBy(e.target.value)} aria-label="Sort companies">
          <option value="name">Sort: Name (A–Z)</option>
          <option value="contacts">Sort: Most contacts</option>
          <option value="jobs">Sort: Most open jobs</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Spinner /></div>
      ) : companies.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🏢</div>
          <h3 className="font-bold text-navy mb-1">No companies yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Add a company, then attach contacts and jobs to it from a dropdown wherever you go.</p>
          <button onClick={openAddCo} className="btn-primary">Add a company</button>
        </div>
      ) : searched.length === 0 ? (
        // 2026-08-26 audit fix: same bug as Contacts.jsx — a typo'd search
        // against a non-empty list used to render the identical "add your
        // first company" empty state as a genuinely empty table.
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-bold text-navy mb-1">No companies match "{search}"</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different name — or clear the search to see all {companies.length} companies.</p>
          <button onClick={() => setSearch('')} className="btn-ghost">Clear search</button>
        </div>
      ) : ownerFiltered.length === 0 ? (
        // Owner filter narrowed a non-empty search down to nobody — its own
        // empty state, same precedent as Candidates.jsx/Contacts.jsx.
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🗂️</div>
          <h3 className="font-bold text-navy mb-1">No companies owned by {teamMembers.find(m => m.id === ownerFilter)?.name || 'that team member'}{search ? ` matching "${search}"` : ''}</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different team member, or clear this filter to see all {searched.length} compan{searched.length === 1 ? 'y' : 'ies'}{search ? ' matching your search' : ''}.</p>
          <button onClick={() => setOwnerFilter('all')} className="btn-ghost">Show everyone's companies</button>
        </div>
      ) : industryFiltered.length === 0 ? (
        // 2026-08-29 audit fix: an industry filter with zero matches used to
        // be impossible (there was no industry filter) — needs its own
        // empty state rather than falling through to an empty grid.
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🗂️</div>
          <h3 className="font-bold text-navy mb-1">No companies in "{industryFilter}"{search ? ` matching "${search}"` : ''}</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Try a different industry, or clear this filter to see all {ownerFiltered.length} compan{ownerFiltered.length === 1 ? 'y' : 'ies'}{search ? ' matching your search' : ''}.</p>
          <button onClick={() => setIndustryFilter('all')} className="btn-ghost">Show all industries</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(co => {
            const cCount = contactsFor(co.id).length
            const jOpen = jobsFor(co.id).filter(j => j.status === 'active' || j.status === 'onhold').length
            const clr = color(co.name)
            return (
              <button key={co.id} onClick={() => { setSelected(co); setTab('contacts'); setDelError(''); setCoNote(''); setDocFile(null); setDocError('') }} className="card p-4 text-left hover:border-gold border border-transparent transition-all">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0" style={{ background: clr + '18', color: clr }}>{initials(co.name)}</div>
                  <div className="min-w-0">
                    <div className="font-bold text-navy text-sm truncate">{co.name}</div>
                    <div className="text-xs text-gray-400 truncate">{co.industry || co.location || ''}</div>
                  </div>
                </div>
                <div className="flex gap-4 text-xs text-gray-500 mt-3">
                  <span><span className="font-bold text-navy">{cCount}</span> contact{cCount === 1 ? '' : 's'}</span>
                  <span><span className="font-bold text-navy">{jOpen}</span> open job{jOpen === 1 ? '' : 's'}</span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Add/Edit company modal */}
      <Modal open={showCoModal} onClose={() => setShowCoModal(false)} title={editCo ? 'Edit Company' : 'Add Company'} maxWidth="max-w-md">
        <ErrorBanner>{coError}</ErrorBanner>
        {/* co-edit-* prefix: this modal (showCoModal) can be mounted at the
            same time as ContactFormModal/JobFormModal's CompanySelect (e.g.
            open the company detail modal -> Edit -> without closing it,
            Add contact -> Add new company), so its ids must not collide with
            CompanySelect's own company-select-new-* ids. */}
        <div className="space-y-3">
          <div><label className="label" htmlFor="co-edit-name">Company name *</label><input id="co-edit-name" className="input" value={coForm.name} onChange={e => setCoForm(p => ({ ...p, name: e.target.value }))} autoFocus /></div>
          <div><label className="label" htmlFor="co-edit-industry">Industry</label><input id="co-edit-industry" className="input" value={coForm.industry} onChange={e => setCoForm(p => ({ ...p, industry: e.target.value }))} /></div>
          <div><label className="label" htmlFor="co-edit-location">Location</label><input id="co-edit-location" className="input" value={coForm.location} onChange={e => setCoForm(p => ({ ...p, location: e.target.value }))} /></div>
          <div><label className="label" htmlFor="co-edit-website">Website</label><input id="co-edit-website" className="input" value={coForm.website} onChange={e => setCoForm(p => ({ ...p, website: e.target.value }))} /></div>
          <div><label className="label" htmlFor="co-edit-notes">Notes</label><textarea id="co-edit-notes" className="input resize-none" rows={3} value={coForm.notes} onChange={e => setCoForm(p => ({ ...p, notes: e.target.value }))} /></div>
        </div>
        <div className="flex gap-3 justify-end mt-5">
          <button onClick={() => setShowCoModal(false)} className="btn-ghost">Cancel</button>
          <button onClick={saveCo} disabled={coSaving} className="btn-primary">{coSaving ? 'Saving...' : 'Save'}</button>
        </div>
      </Modal>

      {/* Company detail panel */}
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.name || ''} maxWidth="max-w-2xl">
        {selected && (
          <div className="-m-6">
            <div className="p-6 border-b border-gray-100">
              {coNote && <div className="bg-gray-50 border border-gray-200 text-gray-600 rounded-lg px-3 py-2 text-sm mb-3">{coNote}</div>}
              <ErrorBanner>{delError}</ErrorBanner>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-gray-500">{[selected.industry, selected.location].filter(Boolean).join(' · ') || 'No details yet'}</p>
                  {selected.website && <a href={selected.website.startsWith('http') ? selected.website : `https://${selected.website}`} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">{selected.website}</a>}
                  {selected.notes && <p className="text-sm text-gray-600 mt-2">{selected.notes}</p>}
                </div>
                {/* 2026-08-29 audit fix: same Delete-styled-like-a-routine-
                    action issue fixed across the rest of the CRM this pass,
                    applied here for consistency. */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={() => openEditCo(selected)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
                  <div className="pl-2 ml-1 border-l border-gray-200">
                    <button onClick={() => setShowDeleteConfirm(true)} className="text-xs text-red-500 font-semibold hover:underline">Delete</button>
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <OwnershipPanel
                  table="companies"
                  record={selected}
                  teamMembers={teamMembers}
                  onReassigned={updated => {
                    setCompanies(prev => prev.map(c => (c.id === updated.id ? { ...c, owner_id: updated.owner_id } : c)))
                    setSelected(prev => (prev ? { ...prev, owner_id: updated.owner_id } : prev))
                  }}
                />
              </div>
              <div className="flex gap-1 mt-4">
                <button onClick={() => setTab('contacts')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === 'contacts' ? 'bg-navy text-white' : 'text-gray-500 hover:bg-gray-100'}`}>Contacts ({contactsFor(selected.id).length})</button>
                <button onClick={() => setTab('jobs')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === 'jobs' ? 'bg-navy text-white' : 'text-gray-500 hover:bg-gray-100'}`}>Jobs ({jobsFor(selected.id).length})</button>
                <button onClick={() => setTab('documents')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === 'documents' ? 'bg-navy text-white' : 'text-gray-500 hover:bg-gray-100'}`}>Documents ({documents.length})</button>
              </div>
            </div>

            <div className="p-6">
              {tab === 'contacts' && (
                <div>
                  <button onClick={() => setShowContactModal(true)} className="btn-primary mb-4">+ Add contact at {selected.name}</button>
                  {contactsFor(selected.id).length === 0 ? (
                    <p className="text-sm text-gray-400">No contacts linked to this company yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {contactsFor(selected.id).map(c => (
                        <button
                          key={c.id}
                          onClick={() => setDetailContactId(c.id)}
                          className="w-full flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:border-gold text-left transition-colors"
                        >
                          <div>
                            <div className="font-semibold text-navy text-sm">{c.name}</div>
                            <div className="text-xs text-gray-500">{c.title || ''}{c.title && c.email ? ' · ' : ''}{c.email || ''}</div>
                          </div>
                          <span className={`text-xs font-semibold px-2 py-1 rounded-full ${STATUS_COLOR[c.status] || 'bg-gray-100 text-gray-500'}`}>{c.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === 'jobs' && (
                <div>
                  <button onClick={() => setShowJobModal(true)} className="btn-primary mb-4">+ Add job at {selected.name}</button>
                  {jobsFor(selected.id).length === 0 ? (
                    <p className="text-sm text-gray-400">No jobs linked to this company yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {jobsFor(selected.id).map(j => (
                        <div key={j.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-100">
                          <div className="font-semibold text-navy text-sm">{j.title}</div>
                          <span className={`text-xs font-semibold px-2 py-1 rounded-full uppercase ${JOB_STATUS_COLOR[j.status]}`}>{j.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {tab === 'documents' && (
                <div>
                  <ErrorBanner>{docError}</ErrorBanner>
                  <div className="flex items-center gap-2 mb-4">
                    <input
                      type="file"
                      onChange={e => setDocFile(e.target.files?.[0] || null)}
                      className="text-xs flex-1"
                    />
                    <button onClick={uploadDocument} disabled={!docFile || docUploading} className="btn-primary flex-shrink-0">
                      {docUploading ? 'Uploading...' : 'Upload'}
                    </button>
                  </div>
                  {docsLoading ? (
                    <p className="text-sm text-gray-400">Loading documents...</p>
                  ) : documents.length === 0 ? (
                    <p className="text-sm text-gray-400">No documents attached to {selected.name} yet — a signed contract, an MSA, anything worth keeping against this client's name.</p>
                  ) : (
                    <div className="space-y-2">
                      {documents.map(d => (
                        <div key={d.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-100">
                          <div className="min-w-0">
                            <div className="font-semibold text-navy text-sm truncate">📄 {d.file_name}</div>
                            <div className="text-xs text-gray-400">{new Date(d.uploaded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0">
                            <button onClick={() => viewDocument(d.file_path)} className="text-xs font-semibold text-gold-ink hover:underline">View</button>
                            <button onClick={() => setConfirmDeleteDocId(d.id)} className="text-xs font-semibold text-red-500 hover:underline">Delete</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ContactFormModal
        open={showContactModal}
        editContact={null}
        lockedCompanyId={selected?.id}
        lockedCompanyName={selected?.name}
        onClose={() => setShowContactModal(false)}
        onSaved={() => load()}
      />
      <ContactDetailModal
        contactId={detailContactId}
        open={!!detailContactId}
        onClose={() => setDetailContactId(null)}
        onChanged={() => load()}
      />
      <JobFormModal
        open={showJobModal}
        editJob={null}
        lockedCompanyId={selected?.id}
        lockedCompanyName={selected?.name}
        onClose={() => setShowJobModal(false)}
        onSaved={() => load()}
      />
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={() => delCo(selected.id)}
        title="Delete company"
        message="Delete this company? Contacts and jobs linked to it will stay, just unlinked."
        confirmLabel="Delete"
      />
      <ConfirmDialog
        open={!!confirmDeleteDocId}
        onClose={() => setConfirmDeleteDocId(null)}
        onConfirm={() => { const id = confirmDeleteDocId; const doc = documents.find(d => d.id === id); setConfirmDeleteDocId(null); if (doc) deleteDocument(id, doc.file_path) }}
        title="Delete document"
        message="Delete this document? This can't be undone."
        confirmLabel="Delete"
      />
    </div>
  )
}

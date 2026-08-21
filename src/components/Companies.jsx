import React, { useState, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { normalizeCompanyName } from '../lib/companyMatch'
import InfoTip from './InfoTip'
import ContactFormModal from './ContactFormModal'
import JobFormModal from './JobFormModal'
import ConfirmDialog from './ConfirmDialog'

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

  useEffect(() => { load() }, [user])
  useEffect(() => { if (location.state?.autoOpenAdd) openAddCo() }, [location.state])

  async function load() {
    setLoading(true)
    const [{ data: co }, { data: ct }, { data: jb }] = await Promise.all([
      supabase.from('companies').select('*').eq('user_id', user.id).order('name'),
      supabase.from('contacts').select('id, name, title, email, status, company_id').eq('user_id', user.id).not('company_id', 'is', null),
      supabase.from('jobs').select('id, title, status, company_id').eq('user_id', user.id),
    ])
    setCompanies(co || [])
    setContacts(ct || [])
    setJobs(jb || [])
    setLoading(false)
  }

  const filtered = useMemo(() =>
    companies.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase())),
    [companies, search]
  )

  function contactsFor(id) { return contacts.filter(c => c.company_id === id) }
  function jobsFor(id) { return jobs.filter(j => j.company_id === id) }

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
        setCoNote(`Using existing record for ${existing.name}`)
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
        const { error: err } = await supabase.from('companies').update(row).eq('id', editCo.id)
        if (err) throw err
      } else {
        const { error: err } = await supabase.from('companies').insert({ ...row, user_id: user.id })
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
    const { error: err } = await supabase.from('companies').delete().eq('id', id)
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

      <input className="input max-w-sm mb-6" placeholder="Search companies..." value={search} onChange={e => setSearch(e.target.value)} />

      {loading ? (
        <div className="flex items-center justify-center py-20"><div className="w-8 h-8 border-4 border-gold border-t-transparent rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">🏢</div>
          <h3 className="font-bold text-navy mb-1">No companies yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">Add a company, then attach contacts and jobs to it from a dropdown wherever you go.</p>
          <button onClick={openAddCo} className="btn-primary">Add a company</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(co => {
            const cCount = contactsFor(co.id).length
            const jOpen = jobsFor(co.id).filter(j => j.status === 'active' || j.status === 'onhold').length
            const clr = color(co.name)
            return (
              <button key={co.id} onClick={() => { setSelected(co); setTab('contacts'); setDelError(''); setCoNote('') }} className="card p-4 text-left hover:border-gold border border-transparent transition-all">
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
      {showCoModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-xl font-bold text-navy mb-4">{editCo ? 'Edit Company' : 'Add Company'}</h2>
            {coError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{coError}</div>}
            <div className="space-y-3">
              <div><label className="label">Company name *</label><input className="input" value={coForm.name} onChange={e => setCoForm(p => ({ ...p, name: e.target.value }))} autoFocus /></div>
              <div><label className="label">Industry</label><input className="input" value={coForm.industry} onChange={e => setCoForm(p => ({ ...p, industry: e.target.value }))} /></div>
              <div><label className="label">Location</label><input className="input" value={coForm.location} onChange={e => setCoForm(p => ({ ...p, location: e.target.value }))} /></div>
              <div><label className="label">Website</label><input className="input" value={coForm.website} onChange={e => setCoForm(p => ({ ...p, website: e.target.value }))} /></div>
              <div><label className="label">Notes</label><textarea className="input resize-none" rows={3} value={coForm.notes} onChange={e => setCoForm(p => ({ ...p, notes: e.target.value }))} /></div>
            </div>
            <div className="flex gap-3 justify-end mt-5">
              <button onClick={() => setShowCoModal(false)} className="btn-ghost">Cancel</button>
              <button onClick={saveCo} disabled={coSaving} className="btn-primary">{coSaving ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Company detail panel */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4 py-8" onClick={() => setSelected(null)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-gray-100">
              {coNote && <div className="bg-gray-50 border border-gray-200 text-gray-600 rounded-lg px-3 py-2 text-sm mb-3">{coNote}</div>}
              {delError && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-sm mb-3">{delError}</div>}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-bold text-navy">{selected.name}</h2>
                  <p className="text-sm text-gray-500 mt-1">{[selected.industry, selected.location].filter(Boolean).join(' · ') || 'No details yet'}</p>
                  {selected.website && <a href={selected.website.startsWith('http') ? selected.website : `https://${selected.website}`} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">{selected.website}</a>}
                  {selected.notes && <p className="text-sm text-gray-600 mt-2">{selected.notes}</p>}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button onClick={() => openEditCo(selected)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
                  <button onClick={() => setShowDeleteConfirm(true)} className="text-xs text-red-400 font-semibold hover:underline">Delete</button>
                  <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600 ml-2">✕</button>
                </div>
              </div>
              <div className="flex gap-1 mt-4">
                <button onClick={() => setTab('contacts')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === 'contacts' ? 'bg-navy text-white' : 'text-gray-500 hover:bg-gray-100'}`}>Contacts ({contactsFor(selected.id).length})</button>
                <button onClick={() => setTab('jobs')} className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-all ${tab === 'jobs' ? 'bg-navy text-white' : 'text-gray-500 hover:bg-gray-100'}`}>Jobs ({jobsFor(selected.id).length})</button>
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
                        <div key={c.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-100">
                          <div>
                            <div className="font-semibold text-navy text-sm">{c.name}</div>
                            <div className="text-xs text-gray-500">{c.title || ''}{c.title && c.email ? ' · ' : ''}{c.email || ''}</div>
                          </div>
                          <span className={`text-xs font-semibold px-2 py-1 rounded-full ${STATUS_COLOR[c.status] || 'bg-gray-100 text-gray-500'}`}>{c.status}</span>
                        </div>
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
            </div>
          </div>
        </div>
      )}

      <ContactFormModal
        open={showContactModal}
        editContact={null}
        lockedCompanyId={selected?.id}
        lockedCompanyName={selected?.name}
        onClose={() => setShowContactModal(false)}
        onSaved={() => load()}
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
    </div>
  )
}

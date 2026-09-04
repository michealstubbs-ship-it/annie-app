import React, { useState, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { createJob, updateJob } from '../lib/data/jobs'
import CompanySelect from './CompanySelect'
import Modal from './Modal'
import ErrorBanner from './ErrorBanner'
import { useMarketCurrency } from '../lib/useMarketCurrency'

const LIKELIHOOD_OPTIONS = [
  { value: '5', label: '★★★★★ Very likely (90%+)' },
  { value: '4', label: '★★★★☆ Likely (70–90%)' },
  { value: '3', label: '★★★☆☆ Possible (50–70%)' },
  { value: '2', label: '★★☆☆☆ Unlikely (25–50%)' },
  { value: '1', label: '★☆☆☆☆ Long shot (<25%)' },
]

function today() { return new Date().toISOString().slice(0, 10) }

const EMPTY = {
  title: '', company_id: '', company_name: '', industry: '', salary_num: '', fee_pct: '',
  likelihood: '3', job_type: 'permanent', status: 'active', received: today(), deadline: '', notes: '',
  // 2026-09-06, gap-analysis batch 1: lets a recruiter flag/filter which
  // specific roles count toward the client's national-hire quota,
  // separately from the client's general quota_band standing on Companies.
  counts_toward_quota: false,
}

function calcFee(salary, pct) {
  const s = parseFloat(salary) || 0
  const p = parseFloat(pct) || 0
  return s && p ? Math.round(s * (p / 100)) : 0
}

// Ported faithfully from the personal dashboard's Add Job form, with the
// company field now a real dropdown (CompanySelect) instead of free text, so
// a mandate always attaches to one real client record. When lockedCompanyId
// is passed (added from inside a company's own page), the company is fixed.
export default function JobFormModal({ open, editJob, lockedCompanyId, lockedCompanyName, onClose, onSaved }) {
  const { user } = useAuth()
  // 2026-08-30: salary label and calculated fee both hardcoded 'AED'.
  const { currencyPrefix, currencyLabel, isGccMarket: isGcc } = useMarketCurrency()
  const [form, setForm] = useState(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    if (editJob) {
      setForm({
        title: editJob.title || '',
        company_id: editJob.company_id || lockedCompanyId || '',
        company_name: editJob.companies?.name || lockedCompanyName || '',
        industry: editJob.industry || '',
        salary_num: editJob.salary_num ?? '',
        fee_pct: editJob.fee_pct ?? '',
        likelihood: String(editJob.likelihood || 3),
        job_type: editJob.job_type || 'permanent',
        status: editJob.status || 'active',
        received: editJob.received || today(),
        deadline: editJob.deadline || '',
        notes: editJob.notes || '',
        counts_toward_quota: !!editJob.counts_toward_quota,
      })
    } else {
      setForm({ ...EMPTY, company_id: lockedCompanyId || '', company_name: lockedCompanyName || '' })
    }
    setError('')
  }, [open, editJob, lockedCompanyId, lockedCompanyName])

  const feeValue = calcFee(form.salary_num, form.fee_pct)

  function handleCompanyChange(id, name, industry) {
    setForm(p => ({ ...p, company_id: id, company_name: name, industry: p.industry || industry || '' }))
  }

  async function save() {
    if (!form.title.trim()) return setError('Job title is required')
    // CompanySelect's <select> has no native `required` attribute, so this
    // check has to stay — the browser can't express it for us.
    if (!form.company_id) return setError('Select a company')
    setSaving(true)
    setError('')
    try {
      const row = {
        title: form.title.trim(),
        company_id: form.company_id,
        industry: form.industry.trim() || null,
        salary_num: form.salary_num ? parseFloat(form.salary_num) : null,
        fee_pct: form.fee_pct ? parseFloat(form.fee_pct) : null,
        fee_value: feeValue || null,
        likelihood: parseInt(form.likelihood) || 3,
        job_type: form.job_type,
        status: form.status,
        received: form.received || today(),
        deadline: form.deadline || null,
        notes: form.notes.trim() || null,
        counts_toward_quota: form.counts_toward_quota,
        updated_at: new Date().toISOString(),
      }
      let result
      if (editJob) {
        const { data, error: err } = await updateJob(editJob.id, row)
        if (err) throw err
        result = data
      } else {
        const { data, error: err } = await createJob(row, user.id)
        if (err) throw err
        result = data
      }
      onSaved?.(result)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={editJob ? 'Edit job' : 'Add job'} maxWidth="max-w-lg">
      <form onSubmit={e => { e.preventDefault(); save() }}>
        <ErrorBanner>{error}</ErrorBanner>
        <div className="space-y-3">
          <div><label className="label" htmlFor="job-title">Job title *</label><input id="job-title" required className="input" value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="e.g. Senior Software Engineer" /></div>

          {lockedCompanyId ? (
            <div>
              <label className="label">Client / company</label>
              <div className="input bg-gray-50 text-gray-600 flex items-center">{lockedCompanyName}</div>
            </div>
          ) : (
            <CompanySelect label="Client / company" required value={form.company_id} onChange={handleCompanyChange} />
          )}

          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="job-industry">Industry</label><input id="job-industry" className="input" value={form.industry} onChange={e => setForm(p => ({ ...p, industry: e.target.value }))} placeholder="e.g. SaaS" /></div>
            <div><label className="label" htmlFor="job-salary-num">Annual salary ({currencyLabel})</label><input id="job-salary-num" type="number" className="input" value={form.salary_num} onChange={e => setForm(p => ({ ...p, salary_num: e.target.value }))} placeholder="e.g. 300000" /></div>
            <div><label className="label" htmlFor="job-fee-pct">Fee % (your %)</label><input id="job-fee-pct" type="number" min="1" max="50" className="input" value={form.fee_pct} onChange={e => setForm(p => ({ ...p, fee_pct: e.target.value }))} placeholder="e.g. 20" /></div>
            <div><label className="label">Calculated fee</label><div className="input bg-gray-50 font-bold text-navy flex items-center">{feeValue ? `${currencyPrefix}${feeValue.toLocaleString()}` : '-'}</div></div>
            <div>
              <label className="label" htmlFor="job-likelihood">Likelihood to fill</label>
              <select id="job-likelihood" className="input" value={form.likelihood} onChange={e => setForm(p => ({ ...p, likelihood: e.target.value }))}>
                {LIKELIHOOD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="job-type">Job type</label>
              <select id="job-type" className="input" value={form.job_type} onChange={e => setForm(p => ({ ...p, job_type: e.target.value }))}>
                <option value="permanent">Permanent</option>
                <option value="contract">Contract</option>
                <option value="interim">Interim</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="job-status">Status</label>
              <select id="job-status" className="input" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
                <option value="active">Active</option>
                <option value="onhold">On hold</option>
                <option value="filled">Filled</option>
                <option value="lost">Lost</option>
              </select>
            </div>
            <div><label className="label" htmlFor="job-received">Date received</label><input id="job-received" type="date" className="input" value={form.received} onChange={e => setForm(p => ({ ...p, received: e.target.value }))} /></div>
            <div><label className="label" htmlFor="job-deadline">Deadline / start date</label><input id="job-deadline" type="date" className="input" value={form.deadline} onChange={e => setForm(p => ({ ...p, deadline: e.target.value }))} /></div>
          </div>
          <div><label className="label" htmlFor="job-notes">Brief / job description</label><textarea id="job-notes" className="input resize-none" rows={3} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Key requirements, must-haves, skills needed, context about the role..." /></div>
          {/* GCC-only: 2026-09-06, Michael: "make sure it is only
              specifically shown for recruiters in UAE and not UK." */}
          {isGcc && (
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input type="checkbox" checked={form.counts_toward_quota} onChange={e => setForm(p => ({ ...p, counts_toward_quota: e.target.checked }))} />
              🏛️ Counts toward the client's Emiratization/Saudization quota
            </label>
          )}
        </div>
        <div className="flex gap-3 justify-end mt-5">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save job'}</button>
        </div>
      </form>
    </Modal>
  )
}

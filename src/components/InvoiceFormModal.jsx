import React, { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { createInvoice, updateInvoice, replaceLineItems } from '../lib/data/invoices'
import { createTask } from '../lib/data/tasks'
import { listJobsForCompany } from '../lib/data/jobs'
import { listCandidatesForInvoicePicker } from '../lib/data/candidates'
import { getInvoicingDetails } from '../lib/data/invoicingDetails'
import { getOnboardingLocations } from '../lib/data/onboarding'
import { listSplitsForInvoice, replaceSplits, validateSplits } from '../lib/data/invoiceSplits'
import { listTeamMembers } from '../lib/data/teamMembers'
import { lineItemAmount, computeInvoiceTotals, formatMoney, currencySymbol, CURRENCY_OPTIONS } from '../lib/invoiceCalc'
import { resolveMarketCurrencyCode, DEFAULT_CURRENCY_CODE } from '../lib/marketCurrency'
import { reportClientError } from '../lib/errorReporting'
import CompanySelect from './CompanySelect'
import Modal from './Modal'
import ErrorBanner from './ErrorBanner'

function today() { return new Date().toISOString().slice(0, 10) }
function addDays(dateStr, days) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + (Number(days) || 0))
  return d.toISOString().slice(0, 10)
}

let rowKeySeq = 0
function newRow(overrides = {}) {
  rowKeySeq += 1
  return { key: `row-${rowKeySeq}`, description: '', quantity: '1', unitAmount: '', ...overrides }
}

// 2026-09-03, Michael ("commission/fee splits"): a split row before it's
// saved — `key` is purely a React list key, matching `newRow`'s own
// pattern; `roleType`/`userId`/`splitPct` are what actually gets sent to
// replaceSplits (see invoiceSplits.js).
let splitKeySeq = 0
function newSplit(overrides = {}) {
  splitKeySeq += 1
  return { key: `split-${splitKeySeq}`, roleType: 'candidate_owner', userId: '', splitPct: '', ...overrides }
}

const EMPTY = {
  company_id: '', company_name: '',
  job_id: '', candidate_id: '',
  bill_to_name: '', bill_to_email: '', bill_to_address: '',
  // 2026-08-29 audit fix: was hardcoded 'AED' — Annie's own home market,
  // not necessarily the customer's. GBP is a neutral, UK-first default;
  // prefillFromTeamDefaults() below upgrades this to the account's real
  // market currency (or an explicit saved default) right after mount.
  currency: DEFAULT_CURRENCY_CODE, issue_date: today(), due_date: '',
  tax_rate: '0', notes: '',
  // 2026-09-03, Michael ("rebate/guarantee period tracking"): 90 days and
  // "free replacement only" match the invoices table's own column
  // defaults (2026-09-03-agency-dynamics-batch.sql) — a brand-new invoice
  // starts on the same terms the database would apply anyway, just visible
  // and editable here instead of invisible until someone checks the row.
  guarantee_days: '90', rebate_model: 'no_refund',
  // 2026-09-06, gap-analysis batch 2 ("referral program tracking"): same
  // "matches the column default" reasoning as guarantee_days above —
  // 'none' is the right default for the overwhelming majority of
  // placements that aren't referrals at all.
  referral_payout_status: 'none', referral_payout_amount: '', referral_payout_notes: '',
  // 2026-09-06, gap-analysis batch 3 ("WPS-aware contract invoicing"):
  // recruiter-toggled, not inferred — see the migration's own column
  // comment for why.
  is_wps_cycle: false, wps_labour_card_no: '', wps_wage_account: '', wps_days_worked: '', wps_overtime_hours: '', wps_sif_due_date: '',
}

const REBATE_MODEL_OPTIONS = [
  { value: 'no_refund', label: 'Free replacement only (no refund)' },
  { value: 'pro_rated', label: 'Pro-rated refund' },
  { value: 'full_refund', label: 'Full refund' },
]

const REFERRAL_PAYOUT_OPTIONS = [
  { value: 'none', label: 'Not a referral placement' },
  { value: 'pending', label: 'Referral payout owed' },
  { value: 'paid', label: 'Referral payout paid' },
]

// Create/edit form for a placement-fee invoice. Only ever creates or edits
// a DRAFT — an invoice that's already been sent/paid/void renders read-only
// here (see the `locked` check below) rather than through a second
// component, since the fields and layout are identical either way; only
// whether they're editable changes.
//
// `prefill` (2026-09-06, item 6/7: "invoice prompt on candidate placement")
// — an optional partial EMPTY-shaped object, applied only in create mode
// (never on an existing `invoice`, which already has its own real values).
// Candidates.jsx passes company_id/job_id/candidate_id/bill_to_name here
// when a candidate's status flips to "placed" and the recruiter accepts
// the prompt, so the form opens already linked and fee-prefilled instead
// of asking them to re-pick everything they just did in the candidate form.
export default function InvoiceFormModal({ open, invoice, onClose, onSaved, prefill }) {
  const { user } = useAuth()
  const [form, setForm] = useState(EMPTY)
  const [lineItems, setLineItems] = useState([newRow()])
  const [jobs, setJobs] = useState([])
  const [allCandidates, setAllCandidates] = useState([])
  const [teamMembers, setTeamMembers] = useState([])
  const [splits, setSplits] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const locked = !!(invoice && invoice.status !== 'draft')

  useEffect(() => {
    if (!open) return
    setError('')
    if (invoice) {
      setForm({
        company_id: invoice.company_id || '',
        company_name: invoice.companies?.name || '',
        job_id: invoice.job_id || '',
        candidate_id: invoice.candidate_id || '',
        bill_to_name: invoice.bill_to_name || '',
        bill_to_email: invoice.bill_to_email || '',
        bill_to_address: invoice.bill_to_address || '',
        currency: invoice.currency || DEFAULT_CURRENCY_CODE,
        issue_date: invoice.issue_date || today(),
        due_date: invoice.due_date || '',
        tax_rate: String(invoice.tax_rate ?? 0),
        notes: invoice.notes || '',
        guarantee_days: invoice.guarantee_days != null ? String(invoice.guarantee_days) : '90',
        rebate_model: invoice.rebate_model || 'no_refund',
        referral_payout_status: invoice.referral_payout_status || 'none',
        referral_payout_amount: invoice.referral_payout_amount != null ? String(invoice.referral_payout_amount) : '',
        referral_payout_notes: invoice.referral_payout_notes || '',
        is_wps_cycle: !!invoice.is_wps_cycle,
        wps_labour_card_no: invoice.wps_labour_card_no || '',
        wps_wage_account: invoice.wps_wage_account || '',
        wps_days_worked: invoice.wps_days_worked != null ? String(invoice.wps_days_worked) : '',
        wps_overtime_hours: invoice.wps_overtime_hours != null ? String(invoice.wps_overtime_hours) : '',
        wps_sif_due_date: invoice.wps_sif_due_date || '',
      })
      const items = invoice.invoice_line_items?.length
        ? invoice.invoice_line_items
            .slice()
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
            .map(li => newRow({ description: li.description || '', quantity: String(li.quantity ?? 1), unitAmount: String(li.unit_amount ?? '') }))
        : [newRow()]
      setLineItems(items)
      if (invoice.company_id) loadJobs(invoice.company_id)
      loadSplits(invoice.id)
    } else {
      setForm({ ...EMPTY, ...prefill })
      setLineItems([newRow()])
      setJobs([])
      setSplits([])
      prefillFromTeamDefaults()
      // Mirrors handleCompanyChange/handleJobChange's own loadJobs-then-fee-
      // prefill sequence below, just triggered by an incoming prefill
      // instead of a user picking things from the dropdowns — same
      // best-effort error handling as loadJobs itself (a failure here just
      // leaves Role empty, it doesn't block opening the form).
      if (prefill?.company_id) {
        listJobsForCompany(prefill.company_id)
          .then(j => {
            setJobs(j)
            const job = prefill.job_id && j.find(x => x.id === prefill.job_id)
            if (job) {
              setLineItems([newRow({ description: `Placement fee — ${job.title}`, unitAmount: job.fee_value != null ? String(job.fee_value) : '' })])
            }
          })
          .catch(err => {
            reportClientError('Invoice form: failed to load jobs for prefilled company', err, { companyId: prefill.company_id })
            setJobs([])
          })
      }
    }
    loadCandidates()
    loadTeamMembers()
  }, [open, invoice, prefill])

  // Best-effort — a failed load just leaves the built-in EMPTY defaults
  // (GBP, no due date) rather than blocking the form. 2026-08-29 audit fix:
  // this used to only ever look at an explicitly-saved invoicing default
  // (`details.default_currency`) and fall back to whatever `p.currency`
  // already was (the hardcoded 'AED' from EMPTY) — so a brand-new account
  // that had never touched Settings > Invoicing got AED regardless of its
  // own onboarding market. Now resolves the account's real market currency
  // as the fallback instead, same source Pipeline.jsx's own currency
  // display already uses.
  async function prefillFromTeamDefaults() {
    try {
      const [details, locations] = await Promise.all([
        getInvoicingDetails(),
        user ? getOnboardingLocations(user.id) : null,
      ])
      setForm(p => ({
        ...p,
        currency: details?.default_currency || resolveMarketCurrencyCode(locations),
        due_date: details?.default_payment_terms_days ? addDays(today(), details.default_payment_terms_days) : p.due_date,
      }))
    } catch (err) {
      reportClientError('Invoice form: failed to load team/currency defaults', err)
    }
  }

  async function loadJobs(companyId) {
    try {
      const j = await listJobsForCompany(companyId)
      setJobs(j)
    } catch (err) {
      // 2026-08-29 audit fix: was silently falling back to an empty list —
      // indistinguishable in the UI from "this company genuinely has no
      // jobs." Logged so a real load failure doesn't just look like an
      // empty picker.
      reportClientError('Invoice form: failed to load jobs for company', err, { companyId })
      setJobs([])
    }
  }

  const [sifTaskState, setSifTaskState] = useState('idle') // 'idle' | 'saving' | 'created' | 'error'
  // 2026-09-06, gap-analysis batch 3 ("WPS-aware contract invoicing"):
  // "even flagging 'this SIF is due' as a task would beat spreadsheets
  // outright" — a real bd_tasks row, not just a date sitting on the
  // invoice unnoticed. Only creatable once the invoice itself has been
  // saved (needs a real invoice.id/candidate_id to reference).
  async function flagSifAsTask() {
    if (!invoice || !form.wps_sif_due_date) return
    setSifTaskState('saving')
    try {
      const { error: err } = await createTask({
        title: `Submit WPS Salary Information File — ${form.bill_to_name || 'contract placement'}`,
        notes: 'Auto-flagged from a WPS-cycle invoice — labour card, wage account, days worked, overtime all recorded on the invoice itself.',
        due_date: form.wps_sif_due_date,
        priority: 'high',
        candidate_id: form.candidate_id || null,
      }, user.id)
      if (err) throw err
      setSifTaskState('created')
    } catch {
      setSifTaskState('error')
    }
  }

  async function loadCandidates() {
    try {
      const c = await listCandidatesForInvoicePicker()
      setAllCandidates(c)
    } catch (err) {
      reportClientError('Invoice form: failed to load candidates for picker', err)
      setAllCandidates([])
    }
  }

  // Roster for the commission-split pickers below — best-effort like the
  // loads above; a failed load just leaves the split section without
  // anyone to pick, it doesn't block the rest of the form.
  async function loadTeamMembers() {
    try {
      const m = await listTeamMembers()
      setTeamMembers(m)
    } catch (err) {
      reportClientError('Invoice form: failed to load team roster for splits', err)
      setTeamMembers([])
    }
  }

  // Existing splits on an invoice being edited — mapped from the saved
  // row shape (user_id/role_type/split_pct) to the local editable shape
  // (userId/roleType/splitPct), same key-per-row pattern as line items.
  async function loadSplits(invoiceId) {
    try {
      const rows = await listSplitsForInvoice(invoiceId)
      setSplits(rows.map(r => newSplit({ roleType: r.role_type, userId: r.user_id, splitPct: String(r.split_pct) })))
    } catch (err) {
      reportClientError('Invoice form: failed to load commission splits', err, { invoiceId })
      setSplits([])
    }
  }

  // Candidates linked to whichever job is currently selected — 'placed'
  // ones sorted first, since that's the most likely person to actually be
  // invoiced for, but any candidate on the job can still be picked (see
  // listCandidatesForInvoicePicker's own comment for why).
  const candidatesForJob = useMemo(() => {
    if (!form.job_id) return []
    return allCandidates
      .filter(c => c.job_id === form.job_id)
      .sort((a, b) => (a.status === 'placed' ? -1 : 0) - (b.status === 'placed' ? -1 : 0))
  }, [allCandidates, form.job_id])

  function handleCompanyChange(id, name) {
    setForm(p => ({ ...p, company_id: id, company_name: name, job_id: '', candidate_id: '', bill_to_name: p.bill_to_name || name }))
    if (id) loadJobs(id)
    else setJobs([])
  }

  function handleJobChange(jobId) {
    const job = jobs.find(j => j.id === jobId)
    setForm(p => ({ ...p, job_id: jobId, candidate_id: '' }))
    if (job && (!lineItems.length || (lineItems.length === 1 && !lineItems[0].description && !lineItems[0].unitAmount))) {
      // Prefill the first (otherwise-empty) row from the job's own fee —
      // the whole point of linking a job at all, so the recruiter doesn't
      // have to retype a fee that's already on file (see Jobs.jsx's own
      // Fee: AED display for where fee_value comes from).
      setLineItems([newRow({ description: `Placement fee — ${job.title}`, unitAmount: job.fee_value != null ? String(job.fee_value) : '' })])
    }
  }

  function updateRow(key, fields) {
    setLineItems(prev => prev.map(r => r.key === key ? { ...r, ...fields } : r))
  }
  function addRow() { setLineItems(prev => [...prev, newRow()]) }
  function removeRow(key) { setLineItems(prev => prev.length > 1 ? prev.filter(r => r.key !== key) : prev) }

  function updateSplit(key, fields) {
    setSplits(prev => prev.map(s => s.key === key ? { ...s, ...fields } : s))
  }
  function addSplit() { setSplits(prev => [...prev, newSplit()]) }
  function removeSplit(key) { setSplits(prev => prev.filter(s => s.key !== key)) }

  const computedLineItems = useMemo(() => lineItems.map(li => ({
    ...li,
    amount: lineItemAmount(li.quantity, li.unitAmount),
  })), [lineItems])

  const totals = useMemo(() => computeInvoiceTotals(computedLineItems, form.tax_rate), [computedLineItems, form.tax_rate])

  async function save() {
    if (!form.company_id) return setError('Select a company to bill')
    if (!form.bill_to_name.trim()) return setError('Bill-to name is required')
    const validItems = computedLineItems.filter(li => li.description.trim())
    if (!validItems.length) return setError('Add at least one line item with a description')
    // A split row the recruiter added but never touched (no member picked,
    // no percentage typed) is silently dropped rather than treated as an
    // error — same "ignore the untouched blank" leniency as the line-item
    // filter above. A row that's PARTIALLY filled in still has to be
    // completed or removed: validateSplits (invoiceSplits.js) is what
    // enforces that, plus the 100%-per-role rule, before anything is sent.
    const nonEmptySplits = splits.filter(s => s.userId || s.splitPct)
    const splitsError = validateSplits(nonEmptySplits)
    if (splitsError) return setError(splitsError)

    setSaving(true)
    setError('')
    try {
      const invoiceRow = {
        company_id: form.company_id || null,
        job_id: form.job_id || null,
        candidate_id: form.candidate_id || null,
        bill_to_name: form.bill_to_name.trim(),
        bill_to_email: form.bill_to_email.trim() || null,
        bill_to_address: form.bill_to_address.trim() || null,
        currency: form.currency,
        issue_date: form.issue_date || today(),
        // Ties the guarantee window to the issue date rather than leaving
        // it null until some later action sets it — the migration only
        // backfilled this for rows that already existed
        // (2026-09-03-agency-dynamics-batch.sql); every new invoice needs
        // it set here or getGuaranteeStatus() would report "not started"
        // forever. Safe to keep resyncing on every save: the form is
        // locked (see `locked` above) the moment an invoice leaves draft,
        // so this can't drift after the guarantee period actually begins.
        guarantee_starts_at: form.issue_date || today(),
        due_date: form.due_date || null,
        subtotal: totals.subtotal,
        tax_rate: Number(form.tax_rate) || 0,
        tax_amount: totals.taxAmount,
        total: totals.total,
        notes: form.notes.trim() || null,
        guarantee_days: Number(form.guarantee_days) || 90,
        rebate_model: form.rebate_model || 'no_refund',
        referral_payout_status: form.referral_payout_status || 'none',
        referral_payout_amount: form.referral_payout_amount ? Number(form.referral_payout_amount) : null,
        referral_payout_notes: form.referral_payout_notes.trim() || null,
        is_wps_cycle: form.is_wps_cycle,
        wps_labour_card_no: form.wps_labour_card_no.trim() || null,
        wps_wage_account: form.wps_wage_account.trim() || null,
        wps_days_worked: form.wps_days_worked ? parseInt(form.wps_days_worked, 10) : null,
        wps_overtime_hours: form.wps_overtime_hours ? Number(form.wps_overtime_hours) : null,
        wps_sif_due_date: form.wps_sif_due_date || null,
        updated_at: new Date().toISOString(),
      }
      const itemsForSave = validItems.map(li => ({ description: li.description.trim(), quantity: Number(li.quantity) || 1, unitAmount: Number(li.unitAmount) || 0, amount: li.amount }))

      let result
      if (invoice) {
        result = await updateInvoice(invoice.id, invoiceRow)
        await replaceLineItems(invoice.id, itemsForSave)
      } else {
        result = await createInvoice(invoiceRow, itemsForSave, user.id)
      }
      // `result` always carries team_id here — stamped by the same
      // fill_team_id() trigger on create, and already present on the row
      // being updated (getInvoice's own `*` select) — so there's no
      // separate "what team am I on" lookup needed just for this.
      await replaceSplits(result.id, result.team_id, nonEmptySplits)
      onSaved?.(result)
      onClose()
    } catch (err) {
      setError(err.message || 'Could not save this invoice. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={invoice ? (locked ? `Invoice ${invoice.invoice_number || '(draft)'}` : 'Edit invoice') : 'New invoice'} maxWidth="max-w-2xl">
      <fieldset disabled={locked} className={locked ? 'opacity-70' : ''}>
        {locked && <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-4">This invoice has already been {invoice.status} and can no longer be edited. Void it and create a new one if something needs to change.</p>}
        <ErrorBanner>{error}</ErrorBanner>

        <div className="space-y-3">
          <CompanySelect label="Bill to (company)" required value={form.company_id} onChange={handleCompanyChange} />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="inv-job">Role / mandate</label>
              <select id="inv-job" className="input" value={form.job_id} onChange={e => handleJobChange(e.target.value)} disabled={!form.company_id}>
                <option value="">{form.company_id ? 'No linked job' : 'Select a company first'}</option>
                {jobs.map(j => <option key={j.id} value={j.id}>{j.title}{j.fee_value ? ` — Fee ${currencySymbol(form.currency)} ${Number(j.fee_value).toLocaleString()}` : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="inv-candidate">Candidate placed</label>
              <select id="inv-candidate" className="input" value={form.candidate_id} onChange={e => setForm(p => ({ ...p, candidate_id: e.target.value }))} disabled={!form.job_id}>
                <option value="">{form.job_id ? 'No candidate linked' : 'Select a role first'}</option>
                {candidatesForJob.map(c => <option key={c.id} value={c.id}>{c.name}{c.status === 'placed' ? ' (placed)' : ''}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="inv-bill-name">Bill-to name *</label><input id="inv-bill-name" className="input" value={form.bill_to_name} onChange={e => setForm(p => ({ ...p, bill_to_name: e.target.value }))} /></div>
            <div><label className="label" htmlFor="inv-bill-email">Client email</label><input id="inv-bill-email" type="email" className="input" value={form.bill_to_email} onChange={e => setForm(p => ({ ...p, bill_to_email: e.target.value }))} placeholder="required before sending" /></div>
          </div>
          <div><label className="label" htmlFor="inv-bill-address">Bill-to address</label><textarea id="inv-bill-address" className="input resize-none" rows={2} value={form.bill_to_address} onChange={e => setForm(p => ({ ...p, bill_to_address: e.target.value }))} /></div>

          <div className="border-t border-gray-100 pt-3">
            <label className="label">Line items</label>
            <div className="space-y-2">
              {/* 2026-08-31 audit fix, mobile: this was a flat grid-cols-12
                  row at every width — description/qty/unit/remove squeezed
                  into a phone's ~340px of usable modal width left almost no
                  room for the qty and remove-button cells especially (the
                  ✕ button's own tap target dropped well under any
                  reasonable minimum). Below sm: description gets its own
                  full-width row; qty/unit/remove form a second row via
                  their own 3-column sub-grid. `sm:contents` makes that
                  sub-grid wrapper disappear at sm: and up so its children
                  rejoin the outer 12-col grid exactly as before —desktop
                  layout is byte-for-byte unchanged. */}
              {lineItems.map(row => (
                <div key={row.key} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
                  <input className="input sm:col-span-6" placeholder="Description" value={row.description} onChange={e => updateRow(row.key, { description: e.target.value })} />
                  <div className="grid grid-cols-[2fr_3fr_auto] gap-2 sm:contents">
                    <input className="input sm:col-span-2" type="number" min="0" placeholder="Qty" value={row.quantity} onChange={e => updateRow(row.key, { quantity: e.target.value })} />
                    <input className="input sm:col-span-3" type="number" min="0" placeholder="Unit amount" value={row.unitAmount} onChange={e => updateRow(row.key, { unitAmount: e.target.value })} />
                    <button type="button" onClick={() => removeRow(row.key)} disabled={lineItems.length === 1} className="sm:col-span-1 text-red-400 hover:text-red-600 disabled:opacity-30 text-sm h-10 w-10">✕</button>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" onClick={addRow} className="text-xs text-gold-ink font-semibold hover:underline mt-2">+ Add line</button>
          </div>

          {/* 2026-09-03, Michael ("commission/fee splits"): optional —
              validateSplits (invoiceSplits.js) only enforces the 100%
              rule for a role once ANY split exists for it, so a solo
              recruiter with nothing to split can just leave this empty. */}
          <div className="border-t border-gray-100 pt-3">
            <label className="label">Commission split (optional)</label>
            <p className="text-xs text-gray-400 mb-2">Only needed when more than one person is credited on this placement. Candidate-side and job-side are tracked separately, and each must add up to 100% if used.</p>
            <div className="space-y-2">
              {splits.map(s => (
                <div key={s.key} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start">
                  <select className="input sm:col-span-4" value={s.roleType} onChange={e => updateSplit(s.key, { roleType: e.target.value })}>
                    <option value="candidate_owner">Candidate-side</option>
                    <option value="job_owner">Job-side</option>
                  </select>
                  <select className="input sm:col-span-5" value={s.userId} onChange={e => updateSplit(s.key, { userId: e.target.value })}>
                    <option value="">Select team member</option>
                    {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <input className="input sm:col-span-2" type="number" min="0" max="100" placeholder="%" value={s.splitPct} onChange={e => updateSplit(s.key, { splitPct: e.target.value })} />
                  <button type="button" onClick={() => removeSplit(s.key)} className="sm:col-span-1 text-red-400 hover:text-red-600 text-sm h-10 w-10">✕</button>
                </div>
              ))}
            </div>
            <button type="button" onClick={addSplit} className="text-xs text-gold-ink font-semibold hover:underline mt-2">+ Add split</button>
          </div>

          {/* 2026-08-31 audit fix, mobile: no responsive variant at all —
              currency/issue date/due date squeezed into one row left a
              date input almost no room to show its own value at phone
              width. Stacks to one column below sm, 3-up from sm: up, same
              pattern as the stat-row fixes on Candidates.jsx/Pipeline.jsx. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-t border-gray-100 pt-3">
            <div>
              <label className="label" htmlFor="inv-currency">Currency</label>
              <select id="inv-currency" className="input" value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))}>
                {CURRENCY_OPTIONS.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            </div>
            <div><label className="label" htmlFor="inv-issue-date">Issue date</label><input id="inv-issue-date" type="date" className="input" value={form.issue_date} onChange={e => setForm(p => ({ ...p, issue_date: e.target.value }))} /></div>
            <div><label className="label" htmlFor="inv-due-date">Due date</label><input id="inv-due-date" type="date" className="input" value={form.due_date} onChange={e => setForm(p => ({ ...p, due_date: e.target.value }))} /></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div><label className="label" htmlFor="inv-tax-rate">Tax rate (%)</label><input id="inv-tax-rate" type="number" min="0" max="100" className="input" value={form.tax_rate} onChange={e => setForm(p => ({ ...p, tax_rate: e.target.value }))} /></div>
            <div>
              <label className="label" htmlFor="inv-guarantee-days">Guarantee period (days)</label>
              <input id="inv-guarantee-days" type="number" min="0" className="input" value={form.guarantee_days} onChange={e => setForm(p => ({ ...p, guarantee_days: e.target.value }))} />
            </div>
            <div>
              <label className="label" htmlFor="inv-rebate-model">If the candidate leaves within the period</label>
              <select id="inv-rebate-model" className="input" value={form.rebate_model} onChange={e => setForm(p => ({ ...p, rebate_model: e.target.value }))}>
                {REBATE_MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          {/* 2026-09-06, gap-analysis batch 2 ("referral program tracking"):
              only shown once relevant — a genuine referral is uncommon
              enough that surfacing three fields for every invoice would
              be noise, same "shown only once it matters" precedent as
              counter-offer notes in Candidates.jsx. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="inv-referral-status">🤝 Referral payout</label>
              <select id="inv-referral-status" className="input" value={form.referral_payout_status} onChange={e => setForm(p => ({ ...p, referral_payout_status: e.target.value }))}>
                {REFERRAL_PAYOUT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {form.referral_payout_status !== 'none' && (
              <>
                <div>
                  <label className="label" htmlFor="inv-referral-amount">Payout amount</label>
                  <input id="inv-referral-amount" type="number" min="0" className="input" value={form.referral_payout_amount} onChange={e => setForm(p => ({ ...p, referral_payout_amount: e.target.value }))} />
                </div>
                <div>
                  <label className="label" htmlFor="inv-referral-notes">Payout notes (optional)</label>
                  <input id="inv-referral-notes" className="input" value={form.referral_payout_notes} onChange={e => setForm(p => ({ ...p, referral_payout_notes: e.target.value }))} />
                </div>
              </>
            )}
          </div>
          {/* 2026-09-06, gap-analysis batch 3 ("WPS-aware contract
              invoicing"): structured fields for a recurring contract/temp
              salary cycle — off by default, since most placements here
              are still one-off permanent fees. */}
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input type="checkbox" checked={form.is_wps_cycle} onChange={e => setForm(p => ({ ...p, is_wps_cycle: e.target.checked }))} />
            📋 This is a recurring contract/temp WPS salary cycle
          </label>
          {form.is_wps_cycle && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-gray-50 rounded-lg p-4">
              <div><label className="label" htmlFor="inv-wps-labour-card">Labour card no.</label><input id="inv-wps-labour-card" className="input" value={form.wps_labour_card_no} onChange={e => setForm(p => ({ ...p, wps_labour_card_no: e.target.value }))} /></div>
              <div><label className="label" htmlFor="inv-wps-wage-account">Wage account</label><input id="inv-wps-wage-account" className="input" value={form.wps_wage_account} onChange={e => setForm(p => ({ ...p, wps_wage_account: e.target.value }))} /></div>
              <div><label className="label" htmlFor="inv-wps-days">Days worked</label><input id="inv-wps-days" type="number" min="0" className="input" value={form.wps_days_worked} onChange={e => setForm(p => ({ ...p, wps_days_worked: e.target.value }))} /></div>
              <div><label className="label" htmlFor="inv-wps-overtime">Overtime (hours)</label><input id="inv-wps-overtime" type="number" min="0" step="0.5" className="input" value={form.wps_overtime_hours} onChange={e => setForm(p => ({ ...p, wps_overtime_hours: e.target.value }))} /></div>
              <div className="sm:col-span-2 flex items-end gap-2">
                <div className="flex-1">
                  <label className="label" htmlFor="inv-wps-sif-due">SIF due date</label>
                  <input id="inv-wps-sif-due" type="date" className="input" value={form.wps_sif_due_date} onChange={e => setForm(p => ({ ...p, wps_sif_due_date: e.target.value }))} />
                </div>
                {invoice && form.wps_sif_due_date && (
                  <button type="button" onClick={flagSifAsTask} disabled={sifTaskState === 'saving'} className="btn-ghost text-xs flex-shrink-0">
                    {sifTaskState === 'created' ? '✓ Task created' : sifTaskState === 'error' ? 'Could not create — try again' : 'Flag as task'}
                  </button>
                )}
              </div>
            </div>
          )}
          <div><label className="label" htmlFor="inv-notes">Notes</label><textarea id="inv-notes" className="input resize-none" rows={2} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Anything you'd like to appear on the invoice itself" /></div>

          <div className="bg-gray-50 rounded-lg p-4 text-sm space-y-1">
            <div className="flex justify-between"><span className="text-gray-500">Subtotal</span><span className="font-medium tabular-nums">{formatMoney(totals.subtotal, form.currency)}</span></div>
            {Number(form.tax_rate) > 0 && <div className="flex justify-between"><span className="text-gray-500">Tax ({form.tax_rate}%)</span><span className="font-medium tabular-nums">{formatMoney(totals.taxAmount, form.currency)}</span></div>}
            <div className="flex justify-between text-base font-bold text-navy border-t border-gray-200 pt-1 mt-1"><span>Total</span><span className="tabular-nums">{formatMoney(totals.total, form.currency)}</span></div>
          </div>
        </div>
      </fieldset>

      <div className="flex gap-3 justify-end mt-5">
        <button type="button" onClick={onClose} className="btn-ghost">{locked ? 'Close' : 'Cancel'}</button>
        {!locked && <button type="button" onClick={save} disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save draft'}</button>}
      </div>
    </Modal>
  )
}

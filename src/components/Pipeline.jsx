import React, { useState, useEffect, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { listDeals, createDeal, updateDeal, deleteDeal } from '../lib/data/deals'
import InfoTip from './InfoTip'
import ConfirmDialog from './ConfirmDialog'
import Modal from './Modal'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'

const STAGES = ['prospect', 'approached', 'meeting_booked', 'pitch_sent', 'negotiating', 'won', 'lost']
const STAGE_LABELS = { prospect: 'Prospect', approached: 'Approached', meeting_booked: 'Meeting Booked', pitch_sent: 'Pitch Sent', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' }
const STAGE_COLORS = { prospect: 'bg-gray-100 text-gray-600', approached: 'bg-blue-100 text-blue-700', meeting_booked: 'bg-purple-100 text-purple-700', pitch_sent: 'bg-amber-100 text-amber-700', negotiating: 'bg-orange-100 text-orange-700', won: 'bg-green-100 text-green-700', lost: 'bg-red-100 text-red-700' }
const EMPTY = { company: '', role: '', stage: 'prospect', value: '', probability: 25, notes: '', next_action: '', next_action_date: '' }

// Maps an onboarding target market (LOCATIONS in Onboarding.jsx step 4) to
// the currency prefix deals in that market are actually valued in. AED has
// no single-character symbol in common use, so it renders as a "AED "
// prefix rather than a symbol, following how it's actually written.
// Asia Pacific/Global have no single sane default currency, so they fall
// back to $ same as the US. Unknown/missing data falls back to £, the
// product's original (UK-only) default.
const MARKET_CURRENCY = {
  'United Kingdom': '£',
  'UAE / GCC': 'AED ',
  'United States': '$',
  'Europe': '€',
  'Asia Pacific': '$',
  'Global': '$',
}
const DEFAULT_CURRENCY = '£'

function currencyLabel(symbol) {
  // "AED " already reads correctly as a label ("Value (AED )" is off, so
  // trim it for the form label but keep the trailing space for amounts).
  return symbol.trim()
}

export default function Pipeline() {
  const { user } = useAuth()
  const [deals, setDeals] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  // 3rd-pass audit fix: this used to be one shared `error` rendered in TWO
  // places — a page-level banner AND (added in round 2) a modal-local one —
  // with nothing clearing it on modal open/close. Opening the modal after a
  // prior load()/del() failure showed that stale, unrelated error inside
  // the freshly-opened form; a save error left in the modal survived
  // Cancel/Escape/backdrop-close and reappeared as the page-level banner
  // with no form context left to explain it. Same bug class round 2 fixed
  // for Settings.jsx's shared styleError — split the same way here.
  const [listError, setListError] = useState('') // load()/del() — page-level banner
  const [saveError, setSaveError] = useState('') // save() validation/write — modal-local banner, cleared on open/close
  // 4th-pass audit fix: save() is async (the create/update network call),
  // but Cancel/Escape/backdrop/× all close the modal synchronously via
  // closeModal — which used to just clear saveError and move on. If a save
  // was still in flight when the user dismissed the modal, its eventual
  // failure called setSaveError on a banner that no longer renders (Modal
  // returns null once closed), so the error vanished with nobody ever
  // seeing it — the user believed they'd cleanly cancelled when a real
  // write had actually been attempted and failed. Worse, if the user
  // dismissed and then immediately opened a DIFFERENT deal's edit form
  // before that stale save resolved, its error would land on the new,
  // unrelated form instead. This token invalidates a save attempt the
  // instant the modal it belongs to closes or a new one opens; a save
  // whose token is no longer current still surfaces its error, just via
  // the page-level listError banner (always visible, never misattributed
  // to whatever the modal happens to be showing now) instead of saveError.
  const saveTokenRef = useRef(0)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY)

  useEffect(() => { load() }, [user])

  async function load() {
    setLoading(true)
    setListError('')
    // 2026-08-24 Task 2: routed through lib/data/deals.js (previously
    // duplicated inline here) so this table's query shape lives in exactly
    // one place.
    // 2026-08-26 audit fix: listDeals now throws on a real Supabase error
    // instead of quietly returning [] — previously that looked identical
    // to "you have no deals yet".
    try {
      setDeals(await listDeals(user.id))
      await loadCurrency()
    } catch (err) {
      setListError(err.message || 'Could not load your pipeline. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Target market lives in the `onboarding` table (locations column, an
  // array), not on `profiles` — profiles only carries onboarding_completed
  // and firm_name (see netlify/functions/save-onboarding.js). So we query
  // `onboarding` directly rather than reading it off useAuth()'s profile.
  async function loadCurrency() {
    try {
      const { data, error: err } = await supabase.from('onboarding').select('locations').eq('user_id', user.id).single()
      if (err || !data?.locations?.length) { setCurrency(DEFAULT_CURRENCY); return }
      setCurrency(MARKET_CURRENCY[data.locations[0]] || DEFAULT_CURRENCY)
    } catch {
      setCurrency(DEFAULT_CURRENCY)
    }
  }

  // 3rd-pass audit fix: clear saveError on every way the modal opens or
  // closes, so a stale error from a previous save attempt can never bleed
  // into a freshly-opened form or reappear after the form it belonged to
  // is gone.
  // `saving` is reset to false here (not just inside save() itself) so a
  // save left stranded in flight by a dismissal/reopen — which must NOT
  // touch `saving` itself, or it could clobber a genuinely newer save's own
  // in-progress state, see the stale-token guard in save() — can never
  // leave a freshly opened modal's Save button permanently disabled.
  function openAdd() { setForm(EMPTY); setEditId(null); setSaveError(''); setSaving(false); saveTokenRef.current++; setShowModal(true) }
  function openEdit(d) { setForm({ company: d.company, role: d.role || '', stage: d.stage, value: d.value || '', probability: d.probability || 25, notes: d.notes || '', next_action: d.next_action || '', next_action_date: d.next_action_date || '' }); setEditId(d.id); setSaveError(''); setSaving(false); saveTokenRef.current++; setShowModal(true) }
  function closeModal() { setShowModal(false); setSaveError(''); setSaving(false); saveTokenRef.current++ }

  async function save(e) {
    e?.preventDefault()
    const token = saveTokenRef.current
    // 2026-08-26 audit fix: the form's "Company *" label has always implied
    // this is required, but nothing enforced it — the DB happily accepted
    // an empty-string company, producing a blank, unidentifiable deal card.
    // Matches the required-field check already used in ContactFormModal.jsx/
    // JobFormModal.jsx.
    if (!form.company.trim()) { setSaveError('Company is required'); return }
    setSaving(true)
    setSaveError('')
    // 2026-08-31 audit fix, a real bug confirmed live: leaving "Next action
    // date" blank (the common case — most people don't set one up front)
    // sent it through as `""` instead of null, and the deals table's
    // next_action_date column is a real `date`, not text — Postgres rejects
    // an empty string with "invalid input syntax for type date", surfaced
    // to the user verbatim as an HTTP 400. Every other form in this app
    // already normalizes its own optional date the same way (JobFormModal's
    // `deadline || null`, InvoiceFormModal's `due_date || null`, Meetings
    // and Tasks the same) — Pipeline was the one that never got that fix.
    const payload = { ...form, company: form.company.trim(), value: parseFloat(form.value) || 0, probability: parseInt(form.probability) || 0, next_action_date: form.next_action_date || null }
    const { error: err } = editId
      ? await updateDeal(editId, { ...payload, updated_at: new Date().toISOString() })
      : await createDeal(payload, user.id)
    // 4th-pass audit fix: only touch saveError/showModal/saving if this is
    // still the save the open modal is waiting on. If the modal was closed
    // or reopened for a different deal while this request was in flight,
    // saveTokenRef.current has moved on — this result belongs to a form
    // that's no longer showing, so a failure goes to the always-visible
    // listError banner instead of a saveError nobody will ever see, and a
    // success just silently refreshes the list below without touching
    // modal state that a newer open/close already owns.
    if (err) {
      const message = err.message || 'Could not save this deal. Please try again.'
      if (saveTokenRef.current === token) {
        setSaveError(message)
        setSaving(false)
      } else {
        setListError(message)
      }
      return
    }
    // 5th-pass audit fix: a stale (abandoned/orphaned) save that still
    // succeeds no longer calls load() at all. It used to, on the theory
    // that it "silently refreshes the list below" — but load() itself
    // unconditionally flips the page into its full-screen loading spinner
    // and clears listError, neither of which is silent: it visibly
    // interrupts whatever the user is looking at now (which owns the
    // screen, not this orphaned save), and can wipe an error message a
    // DIFFERENT stale save's failure branch just set a moment earlier,
    // undoing the very fix (routing stale errors to listError) meant to
    // make sure they're seen. The deal itself is safely written either
    // way; a save this stale just waits for the list's next natural
    // reload (a real page load, or the next save/delete) to show it,
    // rather than reaching back into a screen it no longer owns.
    //
    // `stillCurrent` is also re-checked AFTER load() rather than reused
    // from a snapshot taken before it — load() is itself an async round
    // trip (listDeals + loadCurrency), during which the user can close
    // this modal and open (and even save) a completely different one.
    // Re-checking here is what stops a slow-to-settle save from reaching
    // back in and force-closing a newer, unrelated modal the user is
    // actively using, and from re-enabling `saving` while that newer save
    // is still genuinely in flight — reopening the exact duplicate-submit
    // window this token guard exists to prevent.
    if (saveTokenRef.current !== token) return
    await load()
    if (saveTokenRef.current === token) {
      setShowModal(false)
      setSaveError('')
      setSaving(false)
    }
  }

  async function del(id) {
    const { error: err } = await deleteDeal(id)
    if (err) {
      setListError(err.message || 'Could not delete this deal. Please try again.')
      return
    }
    setListError('') // 3rd-pass audit fix: clear a stale error from an earlier failed delete
    setDeals(prev => prev.filter(d => d.id !== id))
  }

  const totalValue = deals.filter(d => d.stage !== 'lost').reduce((sum, d) => sum + (d.value || 0), 0)
  const wonValue = deals.filter(d => d.stage === 'won').reduce((sum, d) => sum + (d.value || 0), 0)

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-navy flex items-center">
            BD Pipeline
            <InfoTip text="Track every deal from first contact to signed client here. Move deals through stages as conversations progress, and set a probability to estimate what's likely to close." />
          </h1>
          <p className="text-gray-500 mt-1">{deals.length} deals tracked</p>
        </div>
        <button onClick={openAdd} className="btn-primary">+ Add Deal</button>
      </div>

      <ErrorBanner>{listError}</ErrorBanner>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Pipeline Value', value: `${currency}${totalValue.toLocaleString()}`, color: 'text-navy' },
          { label: 'Won', value: `${currency}${wonValue.toLocaleString()}`, color: 'text-green-600' },
          { label: 'Active Deals', value: deals.filter(d => !['won','lost'].includes(d.stage)).length, color: 'text-navy' },
        ].map(s => (
          <div key={s.label} className="card p-4">
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-gray-500 text-sm mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : deals.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-4xl mb-3">📈</div>
          <h3 className="font-bold text-navy mb-1">No deals yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto mb-4">When a conversation with a contact turns into a real opportunity, add it here to track it through to close.</p>
          <button onClick={openAdd} className="btn-primary">Add your first deal</button>
        </div>
      ) : (
        <div className="space-y-3">
          {deals.map(d => (
            <div key={d.id} className="card p-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="font-bold text-navy">{d.company}</h3>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STAGE_COLORS[d.stage]}`}>{STAGE_LABELS[d.stage]}</span>
                  </div>
                  {d.role && <p className="text-sm text-gray-500 mb-1">{d.role}</p>}
                  {d.next_action && <p className="text-sm text-gray-600">Next: {d.next_action}</p>}
                </div>
                <div className="text-right flex-shrink-0">
                  {d.value > 0 && <div className="font-bold text-navy">{currency}{Number(d.value).toLocaleString()}</div>}
                  <div className="text-xs text-gray-400 mt-0.5">{d.probability}% probability</div>
                  {/* 2026-08-29 audit fix: same Delete-styled-like-a-routine-
                      action issue fixed on Invoices.jsx, applied here for
                      consistency. */}
                  <div className="flex items-center gap-2 justify-end mt-2">
                    <button onClick={() => openEdit(d)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
                    <div className="pl-2 ml-1 border-l border-gray-200">
                      <button onClick={() => setConfirmDeleteId(d.id)} className="text-xs text-red-500 font-semibold hover:underline">Delete</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={closeModal} title={editId ? 'Edit Deal' : 'Add Deal'} maxWidth="max-w-lg">
        {/* A real <form onSubmit> so the `required` constraint on Company
            actually fires — matches the fix already applied to
            ContactFormModal.jsx/JobFormModal.jsx, where "Save" previously
            called save() directly via onClick instead of submitting a form,
            leaving `required` inert. */}
        <form onSubmit={save}>
            <div className="space-y-3">
              {/* 2nd-pass audit fix: the page-level ErrorBanner above sits
                  behind this modal's full-screen overlay, so it was
                  invisible while the modal was open. That mattered because
                  save()'s own validation (a whitespace-only company passes
                  the native `required` check but fails .trim()) had nowhere
                  to actually show its message — clicking Save just silently
                  did nothing. Uses its own saveError (not the page-level
                  listError) — see the 3rd-pass audit fix on that state. */}
              {saveError && <ErrorBanner>{saveError}</ErrorBanner>}
              {[['company','Company *','text',true],['role','Role/Position','text',false],['next_action','Next Action','text',false]].map(([f,l,t,req]) => (
                <div key={f}><label className="label" htmlFor={`pipeline-${f}`}>{l}</label><input id={`pipeline-${f}`} className="input" type={t} value={form[f]} onChange={e => setForm(p => ({ ...p, [f]: e.target.value }))} required={req} /></div>
              ))}
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label" htmlFor="pipeline-value">Value ({currencyLabel(currency)})</label><input id="pipeline-value" className="input" type="number" value={form.value} onChange={e => setForm(p => ({ ...p, value: e.target.value }))} /></div>
                <div><label className="label" htmlFor="pipeline-probability">Probability (%)</label><input id="pipeline-probability" className="input" type="number" min="0" max="100" value={form.probability} onChange={e => setForm(p => ({ ...p, probability: e.target.value }))} /></div>
              </div>
              <div><label className="label" htmlFor="pipeline-stage">Stage</label>
                <select id="pipeline-stage" className="input" value={form.stage} onChange={e => setForm(p => ({ ...p, stage: e.target.value }))}>
                  {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                </select>
              </div>
              <div><label className="label" htmlFor="pipeline-next-action-date">Next action date</label><input id="pipeline-next-action-date" className="input" type="date" value={form.next_action_date} onChange={e => setForm(p => ({ ...p, next_action_date: e.target.value }))} /></div>
              <div><label className="label" htmlFor="pipeline-notes">Notes</label><textarea id="pipeline-notes" className="input resize-none" rows={3} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} /></div>
            </div>
            <div className="flex gap-3 justify-end mt-5">
              <button type="button" onClick={closeModal} className="btn-ghost">Cancel</button>
              <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Saving...' : 'Save'}</button>
            </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!confirmDeleteId}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => del(confirmDeleteId)}
        title="Delete deal?"
        message="This can't be undone."
        confirmLabel="Delete"
      />
    </div>
  )
}

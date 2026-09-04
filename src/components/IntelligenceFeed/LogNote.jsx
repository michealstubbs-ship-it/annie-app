// "Log what happened" — the only thing in the product that creates rung 1.
//
// The way-in ladder's top rung requires evidence the recruiter left themselves:
// a note they wrote, or a logged contact date. On the production account, 753
// contacts had neither — all bulk-imported. So without a way to record a
// conversation at the moment it happens, on the card, rung 1 is unreachable
// and the ladder's best state is decoration.
//
// Deliberately one field and one button. Anything longer than that competes
// with the call the recruiter has just come off.
import { useState } from 'react'
import { logContactNote } from '../../lib/stream/logContact'

export default function LogNote({ contact, onLogged }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  if (!contact?.id) return null

  async function save() {
    const text = note.trim()
    if (!text) return
    setSaving(true)
    setError(null)
    const res = await logContactNote(contact.id, { note: text, existingNotes: contact.notes || '' })
    setSaving(false)
    if (res.error) {
      setError('Could not save that. Try again.')
      return
    }
    setNote('')
    setOpen(false)
    // Hands the merged note and timestamp back so the card can move to rung 1
    // immediately, without a reload.
    onLogged?.(contact.id, { notes: res.notes, last_contacted: res.last_contacted })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
      >
        Log what happened
      </button>
    )
  }

  return (
    <div className="w-full mt-1">
      <label className="block text-[10.5px] uppercase tracking-wider text-gray-400 font-bold mb-1">
        What happened with {contact.name}?
      </label>
      <textarea
        autoFocus
        rows={2}
        value={note}
        onChange={e => setNote(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
          if (e.key === 'Escape') { setOpen(false); setNote('') }
        }}
        placeholder="Spoke about their CFO search — wants a shortlist by month end."
        className="w-full text-[13px] px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gold focus:border-transparent bg-white"
      />
      {error && <p className="text-[12px] text-red-600 mt-1">{error}</p>}
      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          onClick={save}
          disabled={saving || !note.trim()}
          className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-navy text-gold hover:bg-navy-light transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save to their record'}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setNote(''); setError(null) }}
          className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
        >
          Cancel
        </button>
        <span className="text-[11px] text-gray-400 ml-auto">Dated automatically</span>
      </div>
    </div>
  )
}

import React, { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { getContact, updateContact, deleteContact } from '../lib/data/contacts'
import { listContactNotes, createContactNote } from '../lib/data/contactNotes'
import { CONTACT_STATUS_LABELS } from '../lib/contactsView'
import Modal from './Modal'
import ContactFormModal from './ContactFormModal'
import ConfirmDialog from './ConfirmDialog'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'

const STATUS_COLORS = {
  hot: 'bg-red-100 text-red-700',
  warm: 'bg-amber-100 text-amber-700',
  cold: 'bg-blue-100 text-blue-700',
  client: 'bg-green-100 text-green-700',
  inactive: 'bg-gray-100 text-gray-500',
}

function formatNoteDate(iso) {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// 2026-09-01: the click-to-expand detail view Michael asked for — "from the
// company tab, I should be able to click on a contact name and it takes me
// to contacts or opens up that person so I can put notes against them...
// on contacts, you should just be able to click on them directly and it
// opens up." One shared component, mounted from both Contacts.jsx (row
// click) and Companies.jsx (a company's own contact list rows), fetching
// its own full record by id rather than depending on whatever partial
// shape each caller already had in memory.
//
// Notes are an append-only log, not the single overwrite-on-save
// `contacts.notes` field (see contactNotes.js's own header) — "it has the
// previous notes, but now there is a new empty one" is exactly what the
// list-of-past-entries-plus-one-fresh-textarea below does.
export default function ContactDetailModal({ contactId, open, onClose, onChanged }) {
  const { user } = useAuth()
  const [contact, setContact] = useState(null)
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [noteBody, setNoteBody] = useState('')
  const [savingNote, setSavingNote] = useState(false)

  const [followUpDate, setFollowUpDate] = useState('')
  const [followUpReason, setFollowUpReason] = useState('')
  const [savingFollowUp, setSavingFollowUp] = useState(false)
  const [followUpSaved, setFollowUpSaved] = useState(false)

  const [showEdit, setShowEdit] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    if (!contactId) return
    setLoading(true)
    setError('')
    try {
      const [c, n] = await Promise.all([getContact(contactId), listContactNotes(contactId)])
      setContact(c)
      setNotes(n)
      setFollowUpDate(c.follow_up_date || '')
      setFollowUpReason(c.follow_up_reason || '')
    } catch (err) {
      setError(err.message || 'Could not load this contact.')
    } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => {
    if (open) { setFollowUpSaved(false); load() }
  }, [open, load])

  async function saveNote() {
    const body = noteBody.trim()
    if (!body) return
    setSavingNote(true)
    setError('')
    try {
      const { data, error: err } = await createContactNote(contactId, user.id, body)
      if (err) throw err
      setNotes(prev => [data, ...prev])
      setNoteBody('')
    } catch (err) {
      setError(err.message || 'Could not save that note.')
    } finally {
      setSavingNote(false)
    }
  }

  async function saveFollowUp() {
    setSavingFollowUp(true)
    setError('')
    setFollowUpSaved(false)
    try {
      const { data, error: err } = await updateContact(contactId, {
        follow_up_date: followUpDate || null,
        follow_up_reason: followUpReason.trim() || null,
      })
      if (err) throw err
      setContact(data)
      setFollowUpSaved(true)
      onChanged?.()
    } catch (err) {
      setError(err.message || 'Could not save the follow-up.')
    } finally {
      setSavingFollowUp(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    const { error: err } = await deleteContact(contactId)
    setDeleting(false)
    if (err) { setError(err.message); return }
    setShowDeleteConfirm(false)
    onChanged?.()
    onClose?.()
  }

  return (
    <Modal open={open} onClose={onClose} title={contact?.name || 'Contact'} maxWidth="max-w-lg">
      {loading ? (
        <div className="flex items-center justify-center py-10"><Spinner /></div>
      ) : contact ? (
        <div className="space-y-5">
          <ErrorBanner>{error}</ErrorBanner>

          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-sm text-gray-600">{[contact.title, contact.company].filter(Boolean).join(' · ') || 'No title or company set'}</p>
              <p className="text-xs text-gray-400">{[contact.email, contact.phone].filter(Boolean).join(' · ')}</p>
              {contact.linkedin_url && (
                <a href={contact.linkedin_url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">LinkedIn</a>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className={`text-xs font-semibold px-2 py-1 rounded-full ${STATUS_COLORS[contact.status] || 'bg-gray-100 text-gray-500'}`}>
                {CONTACT_STATUS_LABELS[contact.status] || contact.status}
              </span>
              <button onClick={() => setShowEdit(true)} className="text-xs text-gold-ink font-semibold hover:underline">Edit</button>
              <div className="pl-2 ml-1 border-l border-gray-200">
                <button onClick={() => setShowDeleteConfirm(true)} className="text-xs text-red-500 font-semibold hover:underline">Delete</button>
              </div>
            </div>
          </div>

          {/* Follow-up reminder — Michael: "a follow up option, where you can
              put it as a reminder when and why to follow up." Surfaces on
              Overview's Today's Schedule once due (see overviewSchedule.js). */}
          <div className="border border-gray-100 rounded-xl p-4">
            <h3 className="text-sm font-bold text-navy mb-2">Follow-up reminder</h3>
            <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-2 items-start">
              <input
                type="date"
                className="input sm:w-auto"
                value={followUpDate}
                onChange={e => setFollowUpDate(e.target.value)}
                aria-label="Follow-up date"
              />
              <input
                type="text"
                className="input"
                placeholder="Why follow up? (e.g. check in after their Series B closes)"
                value={followUpReason}
                onChange={e => setFollowUpReason(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-3 mt-2">
              <button onClick={saveFollowUp} disabled={savingFollowUp} className="btn-ghost text-xs px-3 py-1.5">
                {savingFollowUp ? 'Saving...' : 'Save follow-up'}
              </button>
              {followUpSaved && <span className="text-xs text-green-600 font-medium">Saved</span>}
            </div>
          </div>

          {/* Notes log — append-only. Reopening shows every past note plus
              one fresh empty box, never overwriting the last entry. */}
          <div>
            <h3 className="text-sm font-bold text-navy mb-2">Notes</h3>
            <div className="space-y-2">
              <textarea
                className="input resize-none"
                rows={2}
                placeholder="Add a note..."
                value={noteBody}
                onChange={e => setNoteBody(e.target.value)}
              />
              <div className="flex justify-end">
                <button onClick={saveNote} disabled={savingNote || !noteBody.trim()} className="btn-primary text-xs px-3 py-1.5">
                  {savingNote ? 'Saving...' : 'Save note'}
                </button>
              </div>
            </div>

            {notes.length > 0 && (
              <div className="mt-3 space-y-2 max-h-64 overflow-y-auto pr-1">
                {notes.map(n => (
                  <div key={n.id} className="bg-page-bg rounded-lg p-3">
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{n.body}</p>
                    <p className="text-[11px] text-gray-400 mt-1">{formatNoteDate(n.created_at)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <ErrorBanner>{error || 'Contact not found.'}</ErrorBanner>
      )}

      <ContactFormModal
        open={showEdit}
        editContact={contact}
        onClose={() => setShowEdit(false)}
        onSaved={(updated) => { setContact(updated); setShowEdit(false); onChanged?.() }}
      />
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete this contact?"
        message="This can't be undone. Notes and follow-ups on this contact will be deleted too."
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
      />
    </Modal>
  )
}

import React, { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { reassignOwner } from '../lib/data/ownership'
import { nameForMember } from '../lib/data/teamMembers'

// "Added by X on [date]" (permanent — record.user_id is never touched by
// this feature) plus a reassignable "Owner" dropdown (record.owner_id) —
// shown on a record's own detail view. One shared component instead of
// three near-identical blocks across Candidates/Contacts/Companies.
// 2026-09-03, Michael: "you need to see who added the candidate in case
// there are any ownerships... this needs to apply across all areas,
// including clients and contacts."
//
// Renders nothing on a solo team — there's no one else it could be, and
// showing "Added by you · Owner: you" on every single record would be
// noise rather than useful attribution.
export default function OwnershipPanel({ table, record, teamMembers, onReassigned }) {
  const { user } = useAuth()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [justSaved, setJustSaved] = useState(false)

  if (!record || !teamMembers || teamMembers.length <= 1) return null

  const addedByName = nameForMember(teamMembers, record.user_id)
  const addedDate = record.created_at
    ? new Date(record.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null

  async function handleReassign(e) {
    const newOwnerId = e.target.value
    if (!newOwnerId || newOwnerId === record.owner_id) return
    setSaving(true)
    setError('')
    setJustSaved(false)
    try {
      const updated = await reassignOwner(table, record.id, newOwnerId, user.id, record.owner_id)
      setJustSaved(true)
      onReassigned?.(updated)
    } catch (err) {
      setError(err.message || 'Could not reassign owner.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-gray-100 rounded-xl px-3 py-2.5 text-xs text-gray-500 flex items-center flex-wrap gap-x-4 gap-y-1.5">
      <span>
        Added by <b className="text-gray-700">{addedByName || 'Unknown'}</b>{addedDate ? ` · ${addedDate}` : ''}
      </span>
      <span className="flex items-center gap-1.5">
        Owner:
        <select
          className="input py-1 px-2 text-xs w-auto"
          value={record.owner_id || ''}
          onChange={handleReassign}
          disabled={saving}
          aria-label="Reassign owner"
        >
          {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </span>
      {saving && <span className="text-gray-400">Saving...</span>}
      {justSaved && !saving && <span className="text-green-600 font-medium">Reassigned</span>}
      {error && <span className="text-red-500">{error}</span>}
    </div>
  )
}

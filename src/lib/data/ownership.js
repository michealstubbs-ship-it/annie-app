import { supabase } from '../supabase'
import { reportClientError } from '../errorReporting'

const TABLES = ['candidates', 'contacts', 'companies', 'jobs']

// Reassigns a record's owner_id and logs the change to ownership_history —
// 2026-09-03, Michael: "if there is more than one person on a seat... you
// need to see who added the candidate in case there are any ownerships...
// this needs to apply across all areas, including clients and contacts."
//
// user_id (who first added the record) is never touched here — it's the
// permanent audit fact. owner_id is who's working it now, and can move.
// The update and the history log are two separate calls rather than one
// atomic RPC: the actual reassignment (the thing a recruiter is waiting
// on) must succeed and reflect immediately either way, and a failure to
// log history is a real but secondary problem — same "best-effort,
// non-blocking side effect" precedent as maybeLogPlacement in
// Candidates.jsx, just surfaced via reportClientError instead of silently
// swallowed, since losing an ownership-history row is worth knowing about.
export async function reassignOwner(table, recordId, newOwnerId, actorId, previousOwnerId) {
  if (!TABLES.includes(table)) throw new Error(`Unknown ownership table: ${table}`)
  if (!newOwnerId) throw new Error('Pick who this should be reassigned to.')

  const { data, error } = await supabase
    .from(table)
    .update({ owner_id: newOwnerId })
    .eq('id', recordId)
    .select()
    .single()
  if (error) throw error

  try {
    // team_id already lives on the record itself (every one of these
    // tables is team-scoped — see 2026-08-24-teams-and-shared-crm.sql) —
    // read it back off the very row the update above just returned, rather
    // than re-deriving it, so this can never log against the wrong team.
    const { error: historyError } = await supabase.from('ownership_history').insert({
      team_id: data.team_id,
      table_name: table,
      record_id: recordId,
      from_owner_id: previousOwnerId || null,
      to_owner_id: newOwnerId,
      changed_by: actorId,
    })
    if (historyError) throw historyError
  } catch (err) {
    reportClientError('Ownership reassigned but history log failed', err, { table, recordId, newOwnerId })
  }

  return data
}

// Every reassignment ever logged for one record, newest first — shown on
// the record's own detail view so "who owned this before, and when did it
// change" is never a guessing game (the exact commission-dispute scenario
// Michael described).
export async function getOwnershipHistory(table, recordId) {
  if (!TABLES.includes(table)) throw new Error(`Unknown ownership table: ${table}`)
  const { data, error } = await supabase
    .from('ownership_history')
    .select('*')
    .eq('table_name', table)
    .eq('record_id', recordId)
    .order('changed_at', { ascending: false })
  if (error) throw error
  return data || []
}

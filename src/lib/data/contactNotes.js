import { supabase } from '../supabase'

// Every raw `contact_notes` Supabase call, in one place — same pattern as
// lib/data/contacts.js. This is a genuinely new concept for this app: every
// other "notes" field in the CRM (contacts.notes, companies.notes, etc.) is
// a single overwrite-on-save string (confirmed by grep before building
// this). Michael's own description of what he wanted: "once you type in
// there, it should save to that contact's name, with the notes and the
// date. Then next time, when you open it up, it has the previous notes,
// but now there is a new empty one" — an append-only log, so it's its own
// child table (2026-09-01-contact-notes-and-followups.sql) rather than a
// field on `contacts`.
export async function listContactNotes(contactId) {
  const { data, error } = await supabase
    .from('contact_notes')
    .select('*')
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// source: 'manual' (typed straight into the contact detail view) or
// 'meeting' (auto-logged from a linked meeting's Outcome/Next steps —
// see Meetings.jsx's save()) — kept as plain text prefix inside body
// rather than a separate column, so a single `body` render always shows
// the whole story with no join/lookup needed to explain where a note
// came from.
export function createContactNote(contactId, userId, body) {
  return supabase.from('contact_notes').insert({ contact_id: contactId, user_id: userId, body }).select().single()
}

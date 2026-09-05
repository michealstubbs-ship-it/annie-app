import { supabase } from '../supabase'

// Every raw `outreach_approaches` Supabase call, in one place — same pattern
// as contacts.js/signals.js/contactNotes.js.
//
// Read-only from the browser, by design. Rows are written exclusively by the
// server: recordApproach() when a message is sent, markApproachReplied() when
// one comes back. Nothing in the UI may create or amend an approach, because
// an approach is a record of something that happened, not a field.

// The readout only ever talks about the current calendar month, so there is no
// reason to pull a year of history to render two sentences. Ninety days is the
// window rather than thirty because REPLY_WINDOW_DAYS is ninety — the extra
// rows cost nothing and make this list a usable basis for anything later that
// wants to look further back than the readout does.
const LOOKBACK_DAYS = 90

/**
 * This user's recent approaches, newest first.
 *
 * Returns [] on any failure rather than throwing: the readout is an extra at
 * the top of the feed, and the feed must render exactly as before when this
 * table is empty, unmigrated, or unreachable.
 */
export async function listRecentApproaches(userId, { days = LOOKBACK_DAYS } = {}) {
  if (!userId) return []
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('outreach_approaches')
    .select('id, signal_id, contact_id, company_name, to_email, sent_at, replied_at, seniority_band, known_at_company')
    .eq('user_id', userId)
    .gte('sent_at', since)
    .order('sent_at', { ascending: false })
    .limit(500)

  if (error) return []
  return data || []
}

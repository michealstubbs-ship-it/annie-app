import { supabase } from '../supabase'

// What the recruiter has decided about a backlog lead.
//
// Backlog leads are synthesised in the browser from contacts rather than
// written as intelligence_signals rows (see stream/backlogSignals.js for why),
// which buys a lot of simplicity and costs exactly one thing: a synthetic row
// has nowhere to persist what the recruiter did with it. Before this file the
// New / Working / Park buttons on a backlog card wrote to
// intelligence_signals by an id — 'backlog:<contact uuid>' — that matches no
// row there. They were dead controls: nothing saved, and nothing survived a
// reload.
//
// So the decision goes on the contact, next to backlog_parked_at, which the
// network-first migration already put there for exactly this reason.

// Contacts the recruiter is working right now.
//
// Its own read rather than a column on the feed's contacts select, so that an
// environment where 20260905200000_daily_set.sql has not been applied yet
// degrades to "Working does not survive a reload" instead of "the contacts
// query 400s and the whole feed is empty". Failure is silent and returns an
// empty set for the same reason.
export async function listBacklogWorking() {
  const { data, error } = await supabase
    .from('contacts')
    .select('id')
    .not('backlog_working_at', 'is', null)
  if (error) return new Set()
  return new Set((data || []).map(r => r.id))
}

export function markBacklogWorking(contactId) {
  return supabase.from('contacts').update({ backlog_working_at: new Date().toISOString() }).eq('id', contactId)
}

export function clearBacklogWorking(contactId) {
  return supabase.from('contacts').update({ backlog_working_at: null }).eq('id', contactId)
}

// Park and dismiss are the same column on purpose.
//
// Both mean "not this person, not from this list", and the difference between
// them is a difference in tone, not in what Annie should do next. What is
// deliberately NOT written here is last_contacted: pressing "Mark as done"
// says the recruiter is finished with the card, not that they spoke to
// anybody, and Annie does not get to record a conversation that may never have
// happened. Logging a note is what claims a contact, and it always was.
//
// Only backlog_parked_at is written here, never the two columns together: this
// one exists in every environment, and pairing it with the newer column would
// make parking fail wherever the new migration has not run yet. Clearing a
// leftover Working flag is a separate, optional call — parked is checked
// first when a lead is built, so a stale flag changes nothing either way.
export function parkBacklogContact(contactId) {
  return supabase
    .from('contacts')
    .update({ backlog_parked_at: new Date().toISOString() })
    .eq('id', contactId)
}

export function unparkBacklogContact(contactId) {
  return supabase.from('contacts').update({ backlog_parked_at: null }).eq('id', contactId)
}

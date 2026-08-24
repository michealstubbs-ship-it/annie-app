import { supabase } from '../supabase'

// Owner-only visibility into what each team member is working on — backed
// by the "Team owners can view members' ..." RLS policies added 2026-08-24
// (crm-sharing-model-and-signal-privacy.sql), additive to the personal-only
// policies every member already has. A non-owner calling this just gets
// back their own row (RLS still shows them their own signals/action-state
// either way, nothing more) — the empty/self-only result for a non-owner is
// safe, so callers don't need to gate the call itself, only the UI that
// renders it (Billing.jsx only renders this for myRole === 'owner').
//
// This is the "Team admin & insights view" already named on the pricing
// page (Billing.jsx's TIERS copy) — built here for the first time.

const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function emptyRow() {
  return { newSignals: 0, actionedSignals: 0, actionsDone: 0, actionsPending: 0 }
}

// One summary row per member id: signal counts from the last 7 days (new =
// not yet looked at, actioned = pursued or dismissed), and Today's Actions
// state across all time (pending = still on their list, done = completed) —
// action-state rows aren't time-windowed the way signals are, since a
// consultant's open action list isn't itself time-scoped.
export async function getTeamActivitySummary(memberUserIds) {
  const summary = new Map()
  const ids = [...new Set((memberUserIds || []).filter(Boolean))]
  if (!ids.length) return summary
  for (const id of ids) summary.set(id, emptyRow())

  const since = new Date(Date.now() - ACTIVITY_WINDOW_MS).toISOString()

  const [{ data: signals }, { data: actionState }] = await Promise.all([
    supabase.from('intelligence_signals').select('user_id, status').in('user_id', ids).gte('found_at', since),
    supabase.from('todays_action_state').select('user_id, status').in('user_id', ids),
  ])

  for (const s of signals || []) {
    const row = summary.get(s.user_id)
    if (!row) continue
    if (s.status === 'new') row.newSignals++
    if (s.status === 'actioned') row.actionedSignals++
  }
  for (const a of actionState || []) {
    const row = summary.get(a.user_id)
    if (!row) continue
    if (a.status === 'done') row.actionsDone++
    else row.actionsPending++
  }

  return summary
}

// Where today's set is remembered.
//
// The set has to survive a refresh, a closed laptop and a second device, or
// the guarantee it makes — the list at 9am is the list at 4pm — is only true
// for people who never reload. So it is written in two places, and neither is
// allowed to break the feed:
//
//   * the server (daily_sets), which is the one that works across devices.
//     Shipped in supabase/migrations/20260905200000_daily_set.sql. Until that
//     migration is applied every read here fails, is caught, and the local
//     copy answers instead — the feed cannot tell the difference.
//   * localStorage, always, so the set is right on the next paint rather than
//     after a round trip, and still right offline.
//
// The record is a memo, not a source of truth. What actually happened to each
// lead lives where it already lived: intelligence_signals.status for real
// signals, contacts.last_contacted / backlog_parked_at / backlog_working_at
// for backlog leads. Losing this record re-draws the day from the same
// ranking; it cannot lose anyone's work.
import { supabase } from '../supabase'

const PREFIX = 'annie.daily-set'

function defaultStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Safari with cookies blocked throws on the property access itself.
    return null
  }
}

function slot(userId) {
  return `${PREFIX}:${userId || 'anon'}`
}

export function readLocalRecord(userId, storage = defaultStorage()) {
  if (!storage) return null
  try {
    const raw = storage.getItem(slot(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.key || !Array.isArray(parsed.ids)) return null
    return { key: parsed.key, ids: parsed.ids.filter(id => typeof id === 'string') }
  } catch {
    // Corrupt or unreadable is the same as absent: re-draw the day.
    return null
  }
}

export function writeLocalRecord(userId, record, storage = defaultStorage()) {
  if (!storage || !record?.key) return false
  try {
    storage.setItem(slot(userId), JSON.stringify({ key: record.key, ids: record.ids || [] }))
    return true
  } catch {
    // A full or disabled store is not a reason to stop showing a feed.
    return false
  }
}

/**
 * Today's record, server first, local second, null if neither has one.
 *
 * A record for a different day is deliberately not returned: yesterday's set
 * is finished, and today draws a new one.
 */
export async function loadDailySet({ userId, key, client = supabase, storage = defaultStorage() } = {}) {
  if (!userId || !key) return null
  try {
    const { data, error } = await client
      .from('daily_sets')
      .select('day, item_ids')
      .eq('user_id', userId)
      .eq('day', key)
      .maybeSingle()
    if (!error && data && Array.isArray(data.item_ids) && data.item_ids.length) {
      const record = { key, ids: data.item_ids }
      // Bring the device's copy in line, so a later offline load agrees with
      // what the recruiter saw this morning on their other machine.
      writeLocalRecord(userId, record, storage)
      return record
    }
  } catch {
    // Table missing, offline, or RLS: fall through to the local copy.
  }
  const local = readLocalRecord(userId, storage)
  return local && local.key === key ? local : null
}

/**
 * Save today's set. Local first — that is the copy the next paint reads.
 *
 * The server write is fire-and-forget on purpose: a failure means the set is
 * re-drawn on another device, which is a smaller cost than an error banner
 * over a feed that is working perfectly well.
 */
export async function saveDailySet({ userId, record, client = supabase, storage = defaultStorage() } = {}) {
  if (!userId || !record?.key) return false
  writeLocalRecord(userId, record, storage)
  try {
    const { error } = await client
      .from('daily_sets')
      .upsert({ user_id: userId, day: record.key, item_ids: record.ids || [] }, { onConflict: 'user_id,day' })
    return !error
  } catch {
    return false
  }
}

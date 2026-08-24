import { describe, it, expect, beforeEach } from 'vitest'
import { resolveTodaysActions, markActionDone } from './resolve.js'

// A minimal in-memory fake of the two Supabase calls this module actually
// makes (todays_action_state select/upsert, intelligence_signals update) —
// enough to exercise resolve.js's real logic without a live database.
function makeFakeSupabase() {
  const state = new Map() // item_key -> { item_key, status, first_shown_at }
  const signalUpdates = []

  return {
    _state: state,
    _signalUpdates: signalUpdates,
    from(table) {
      if (table === 'todays_action_state') {
        return {
          select() { return this },
          eq() { return this },
          in(_col, keys) {
            const data = keys.map(k => state.get(k)).filter(Boolean)
            return Promise.resolve({ data, error: null })
          },
          async upsert(rows) {
            const list = Array.isArray(rows) ? rows : [rows]
            for (const row of list) {
              if (!state.has(row.item_key) || row.status === 'done') {
                state.set(row.item_key, row)
              }
            }
            return { data: list, error: null }
          },
        }
      }
      if (table === 'intelligence_signals') {
        return {
          update(patch) {
            return { eq: (col, val) => { signalUpdates.push({ patch, col, val }); return Promise.resolve({ data: null, error: null }) } }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

describe('resolveTodaysActions', () => {
  let supabase
  beforeEach(() => { supabase = makeFakeSupabase() })

  it('shows every freshly-computed item that has never been marked done', async () => {
    const freshActions = [{ signalId: 's1', urgency: 1, score: 40 }, { signalId: 's2', urgency: 0, score: 30 }]
    const visible = await resolveTodaysActions({ supabase, userId: 'u1', freshActions })
    expect(visible.map(a => a.signalId)).toEqual(['s1', 's2'])
  })

  it('hides an item already marked done, even though it was freshly recomputed', async () => {
    supabase._state.set('signal:s1', { item_key: 'signal:s1', status: 'done' })
    const freshActions = [{ signalId: 's1', urgency: 1, score: 40 }, { signalId: 's2', urgency: 0, score: 30 }]
    const visible = await resolveTodaysActions({ supabase, userId: 'u1', freshActions })
    expect(visible.map(a => a.signalId)).toEqual(['s2'])
  })

  it('drops an item with no stable identity — never shown as persistent state it can\'t actually track', async () => {
    const freshActions = [{ headline: 'no id here', urgency: 1, score: 90 }]
    const visible = await resolveTodaysActions({ supabase, userId: 'u1', freshActions })
    expect(visible).toEqual([])
  })

  it('records first-seen for a genuinely new item so a later load can tell it apart from one already shown', async () => {
    const freshActions = [{ signalId: 's1', urgency: 0, score: 30 }]
    await resolveTodaysActions({ supabase, userId: 'u1', freshActions })
    expect(supabase._state.get('signal:s1')).toMatchObject({ status: 'active' })
  })

  it('sorts by urgency then score, same rule as selectDailyItems', async () => {
    const freshActions = [
      { signalId: 's1', urgency: 0, score: 90 },
      { signalId: 's2', urgency: 2, score: 10 },
    ]
    const visible = await resolveTodaysActions({ supabase, userId: 'u1', freshActions })
    expect(visible[0].signalId).toBe('s2')
  })

  it('a record that no longer appears in freshActions at all (deleted/disqualified upstream) is simply absent — no separate "still exists" check needed', async () => {
    supabase._state.set('signal:s1', { item_key: 'signal:s1', status: 'active' })
    const visible = await resolveTodaysActions({ supabase, userId: 'u1', freshActions: [] })
    expect(visible).toEqual([])
  })
})

describe('markActionDone', () => {
  let supabase
  beforeEach(() => { supabase = makeFakeSupabase() })

  it('marks the item done in todays_action_state', async () => {
    await markActionDone(supabase, 'u1', { signalId: 's1' })
    expect(supabase._state.get('signal:s1')).toMatchObject({ status: 'done' })
  })

  it('also flips the underlying signal to actioned for signal-backed items', async () => {
    await markActionDone(supabase, 'u1', { signalId: 's1' })
    expect(supabase._signalUpdates).toEqual([{ patch: { status: 'actioned' }, col: 'id', val: 's1' }])
  })

  it('does not touch intelligence_signals for a CRM item with no signalId', async () => {
    await markActionDone(supabase, 'u1', { category: 'dormant', contactId: 'c1', keyContext: '2026-01-01' })
    expect(supabase._signalUpdates).toEqual([])
    expect(supabase._state.get('dormant:contact:c1:2026-01-01')).toMatchObject({ status: 'done' })
  })

  it('is a no-op for an action with no stable identity', async () => {
    await markActionDone(supabase, 'u1', { headline: 'no id' })
    expect(supabase._state.size).toBe(0)
  })
})

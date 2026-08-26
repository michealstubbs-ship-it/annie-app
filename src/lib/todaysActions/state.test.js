import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadActionState, recordFirstSeen, markItemDone } from './state.js'

function makeFakeSupabase() {
  const state = new Map() // item_key -> row
  const calls = { select: [], eq: [], in: [], upsert: [] }
  return {
    _state: state,
    _calls: calls,
    from(table) {
      if (table !== 'todays_action_state') throw new Error(`unexpected table ${table}`)
      return {
        select(cols) {
          calls.select.push(cols)
          return this
        },
        eq(col, val) {
          calls.eq.push([col, val])
          return this
        },
        in(col, keys) {
          calls.in.push([col, keys])
          const data = keys.map(k => state.get(k)).filter(Boolean)
          return Promise.resolve({ data, error: null })
        },
        async upsert(rows, opts) {
          calls.upsert.push({ rows, opts })
          const list = Array.isArray(rows) ? rows : [rows]
          for (const row of list) {
            state.set(row.item_key, row)
          }
          return { data: list, error: null }
        },
      }
    },
  }
}

describe('loadActionState', () => {
  let supabase
  beforeEach(() => { supabase = makeFakeSupabase() })

  it('returns an empty Map without calling supabase when itemKeys is empty', async () => {
    const result = await loadActionState(supabase, 'u1', [])
    expect(result).toEqual(new Map())
    expect(supabase._calls.in).toHaveLength(0)
  })

  it('scopes the lookup by user_id and the given item_key list', async () => {
    await loadActionState(supabase, 'u1', ['signal:s1', 'signal:s2'])
    expect(supabase._calls.eq).toEqual([['user_id', 'u1']])
    expect(supabase._calls.in).toEqual([['item_key', ['signal:s1', 'signal:s2']]])
  })

  it('returns a Map keyed by item_key from whatever rows come back', async () => {
    supabase._state.set('signal:s1', { item_key: 'signal:s1', status: 'active', first_shown_at: '2026-08-01' })
    const result = await loadActionState(supabase, 'u1', ['signal:s1', 'signal:s2'])
    expect(result.get('signal:s1')).toEqual({ item_key: 'signal:s1', status: 'active', first_shown_at: '2026-08-01' })
    expect(result.has('signal:s2')).toBe(false)
  })

  it('throws when supabase reports an error, rather than silently returning an empty result', async () => {
    supabase.from = () => ({
      select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'db down' } }) }) }),
    })
    await expect(loadActionState(supabase, 'u1', ['signal:s1'])).rejects.toEqual({ message: 'db down' })
  })
})

describe('recordFirstSeen', () => {
  let supabase
  beforeEach(() => { supabase = makeFakeSupabase() })

  it('is a no-op when itemKeys is empty', async () => {
    await recordFirstSeen(supabase, 'u1', [])
    expect(supabase._calls.upsert).toHaveLength(0)
  })

  it('upserts one active row per item key, ignoring duplicates on (user_id, item_key)', async () => {
    await recordFirstSeen(supabase, 'u1', ['signal:s1', 'signal:s2'])
    expect(supabase._calls.upsert[0].rows).toEqual([
      { user_id: 'u1', item_key: 'signal:s1', status: 'active' },
      { user_id: 'u1', item_key: 'signal:s2', status: 'active' },
    ])
    expect(supabase._calls.upsert[0].opts).toEqual({ onConflict: 'user_id,item_key', ignoreDuplicates: true })
  })
})

describe('markItemDone', () => {
  let supabase
  beforeEach(() => { supabase = makeFakeSupabase() })

  it('is a no-op when itemKey is missing', async () => {
    const result = await markItemDone(supabase, 'u1', null)
    expect(supabase._calls.upsert).toHaveLength(0)
    expect(result).toEqual({ error: null })
  })

  it('upserts a done row with a done_at timestamp, without ignoring duplicates', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'))
    const result = await markItemDone(supabase, 'u1', 'signal:s1')
    expect(supabase._calls.upsert[0].rows).toEqual({
      user_id: 'u1', item_key: 'signal:s1', status: 'done', done_at: '2026-08-24T10:00:00.000Z',
    })
    expect(supabase._calls.upsert[0].opts).toEqual({ onConflict: 'user_id,item_key' })
    expect(result).toEqual({ error: null })
    vi.useRealTimers()
  })

  // 2026-08-26 audit fix: the write's result used to be discarded entirely
  // — callers had no way to tell a failed upsert from a successful one.
  it('surfaces the error instead of swallowing it when the upsert fails', async () => {
    supabase.from = () => ({ upsert: () => Promise.resolve({ data: null, error: { message: 'db down' } }) })
    const result = await markItemDone(supabase, 'u1', 'signal:s1')
    expect(result).toEqual({ error: { message: 'db down' } })
  })
})

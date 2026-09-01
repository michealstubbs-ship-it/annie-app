import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadCopyCache, saveCopyCache } from './copyCache.js'

function makeFakeSupabase(initialRow = null) {
  const rows = new Map() // user_id -> row
  if (initialRow) rows.set(initialRow.user_id, initialRow)
  const calls = { select: [], eq: [], maybeSingle: 0, upsert: [] }
  return {
    _rows: rows,
    _calls: calls,
    from(table) {
      if (table !== 'actions_cache') throw new Error(`unexpected table ${table}`)
      let filterUserId = null
      return {
        select(cols) {
          calls.select.push(cols)
          return this
        },
        eq(col, val) {
          calls.eq.push([col, val])
          if (col === 'user_id') filterUserId = val
          return this
        },
        async maybeSingle() {
          calls.maybeSingle++
          return { data: rows.get(filterUserId) || null, error: null }
        },
        async upsert(row, opts) {
          calls.upsert.push({ row, opts })
          rows.set(row.user_id, row)
          return { data: row, error: null }
        },
      }
    },
  }
}

describe('loadCopyCache', () => {
  let supabase
  beforeEach(() => { supabase = makeFakeSupabase() })

  it('returns an empty object when no row exists yet for this user', async () => {
    const result = await loadCopyCache(supabase, 'u1')
    expect(result).toEqual({})
  })

  it('scopes the lookup by user_id', async () => {
    await loadCopyCache(supabase, 'u1')
    expect(supabase._calls.eq).toEqual([['user_id', 'u1']])
  })

  it('returns the stored actions map when a row exists', async () => {
    supabase = makeFakeSupabase({ user_id: 'u1', actions: { 'signal:s1': { sig: 'x', enriched: { headline: 'H' } } } })
    const result = await loadCopyCache(supabase, 'u1')
    expect(result).toEqual({ 'signal:s1': { sig: 'x', enriched: { headline: 'H' } } })
  })

  // 2026-09-01: this table's old design (actionsEngine.js's mergeActions)
  // stored `actions` as a JSONB ARRAY, not an object. A leftover row from
  // that era, or any other malformed payload, must never crash the loader —
  // worst case it's treated as no cache, same as a genuinely empty one.
  it('treats a non-object actions payload (e.g. a leftover array from the old design) as no cache', async () => {
    supabase = makeFakeSupabase({ user_id: 'u1', actions: [{ old: 'shape' }] })
    const result = await loadCopyCache(supabase, 'u1')
    expect(result).toEqual({})
  })

  it('returns an empty object rather than throwing when supabase reports an error', async () => {
    supabase.from = () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'db down' } }) }) }),
    })
    const result = await loadCopyCache(supabase, 'u1')
    expect(result).toEqual({})
  })
})

describe('saveCopyCache', () => {
  let supabase
  beforeEach(() => {
    supabase = makeFakeSupabase()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'))
  })

  it('upserts the merged cache keyed by user_id, with a generated_at timestamp', async () => {
    await saveCopyCache(supabase, 'u1', {}, { 'signal:s1': { sig: 'a', enriched: { headline: 'H' } } }, new Set(['signal:s1']))
    expect(supabase._calls.upsert[0].row).toEqual({
      user_id: 'u1',
      actions: { 'signal:s1': { sig: 'a', enriched: { headline: 'H' } } },
      generated_at: '2026-09-01T10:00:00.000Z',
    })
    expect(supabase._calls.upsert[0].opts).toEqual({ onConflict: 'user_id' })
  })

  // 2026-09-01: this is the actual cache-growth backstop — an entry for an
  // item no longer selected this round (done, aged out, record deleted)
  // must not persist forever just because it was cached once.
  it('drops a previously cached entry whose key is not in keepKeys', async () => {
    const previous = { 'signal:old': { sig: 'x', enriched: { headline: 'stale' } } }
    await saveCopyCache(supabase, 'u1', previous, {}, new Set())
    expect(supabase._calls.upsert[0].row.actions).toEqual({})
  })

  it('keeps a previously cached entry whose key is still in keepKeys, even with no new entries this round', async () => {
    const previous = { 'signal:s1': { sig: 'a', enriched: { headline: 'H' } } }
    await saveCopyCache(supabase, 'u1', previous, {}, new Set(['signal:s1']))
    expect(supabase._calls.upsert[0].row.actions).toEqual(previous)
  })

  it('a new entry overwrites a stale one for the same key', async () => {
    const previous = { 'signal:s1': { sig: 'old-sig', enriched: { headline: 'Old' } } }
    const newEntries = { 'signal:s1': { sig: 'new-sig', enriched: { headline: 'New' } } }
    await saveCopyCache(supabase, 'u1', previous, newEntries, new Set(['signal:s1']))
    expect(supabase._calls.upsert[0].row.actions).toEqual(newEntries)
  })

  afterEach(() => { vi.useRealTimers() })
})

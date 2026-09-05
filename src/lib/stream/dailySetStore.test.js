import { describe, it, expect, vi } from 'vitest'

// The module's default client is the real one, which refuses to be
// constructed without env vars. Every call here injects its own client; this
// only stops the import from throwing.
vi.mock('../supabase', () => ({ supabase: { from: () => { throw new Error('no default client in tests') } } }))

import { readLocalRecord, writeLocalRecord, loadDailySet, saveDailySet } from './dailySetStore'

const KEY = '2026-09-05'

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    map,
  }
}

// The narrowest shape of the two supabase calls this module makes.
function fakeClient({ row = null, error = null, onUpsert = () => {} } = {}) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }),
      upsert: async (values, options) => { onUpsert(values, options); return { error } },
    }),
  }
}

describe('the local copy', () => {
  it('round-trips a day', () => {
    const storage = fakeStorage()
    writeLocalRecord('u1', { key: KEY, ids: ['a', 'b'] }, storage)
    expect(readLocalRecord('u1', storage)).toEqual({ key: KEY, ids: ['a', 'b'] })
  })

  it('keeps one record per person, so a shared machine cannot cross the wires', () => {
    const storage = fakeStorage()
    writeLocalRecord('u1', { key: KEY, ids: ['a'] }, storage)
    writeLocalRecord('u2', { key: KEY, ids: ['b'] }, storage)
    expect(readLocalRecord('u1', storage).ids).toEqual(['a'])
    expect(readLocalRecord('u2', storage).ids).toEqual(['b'])
  })

  it('treats a corrupt record as no record rather than throwing under the feed', () => {
    const storage = fakeStorage({ 'annie.daily-set:u1': '{oh no' })
    expect(readLocalRecord('u1', storage)).toBeNull()
  })

  it('survives a browser that refuses storage entirely', () => {
    // Private windows and blocked-cookie settings throw on the call itself.
    // Losing the memo costs a redrawn day; an exception here would cost the
    // whole feed.
    const hostile = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(readLocalRecord('u1', hostile)).toBeNull()
    expect(writeLocalRecord('u1', { key: KEY, ids: [] }, hostile)).toBe(false)
  })
})

describe('loadDailySet', () => {
  it('prefers the server, so the same day appears on a second device', () => {
    // The hole a local-only memo leaves: laptop at 9am, tablet at 4pm, and the
    // tablet re-draws a set from what is left — the refill, one device over.
    const storage = fakeStorage()
    const client = fakeClient({ row: { day: KEY, item_ids: ['a', 'b'] } })
    return loadDailySet({ userId: 'u1', key: KEY, client, storage }).then(record => {
      expect(record).toEqual({ key: KEY, ids: ['a', 'b'] })
      // And is cached, so the next paint does not wait on a round trip.
      expect(readLocalRecord('u1', storage).ids).toEqual(['a', 'b'])
    })
  })

  it('falls back to the local copy when the table is not there yet', async () => {
    // 20260905200000_daily_set.sql ships with this code and may not be applied
    // when it lands. Until it is, the day still holds on the device it was
    // drawn on; the feed cannot tell the difference.
    const storage = fakeStorage()
    writeLocalRecord('u1', { key: KEY, ids: ['a'] }, storage)
    const client = fakeClient({ error: { code: '42P01', message: 'relation "daily_sets" does not exist' } })
    expect(await loadDailySet({ userId: 'u1', key: KEY, client, storage })).toEqual({ key: KEY, ids: ['a'] })
  })

  it('survives a client that throws outright', async () => {
    const storage = fakeStorage()
    const client = { from: () => { throw new Error('offline') } }
    expect(await loadDailySet({ userId: 'u1', key: KEY, client, storage })).toBeNull()
  })

  it('ignores yesterday record', async () => {
    // Yesterday's set is finished. Handing it back would be a treadmill with a
    // longer stride.
    const storage = fakeStorage()
    writeLocalRecord('u1', { key: '2026-09-04', ids: ['a'] }, storage)
    const client = fakeClient({ row: null })
    expect(await loadDailySet({ userId: 'u1', key: KEY, client, storage })).toBeNull()
  })
})

describe('saveDailySet', () => {
  it('writes the device copy first and the server after', async () => {
    const storage = fakeStorage()
    const onUpsert = vi.fn()
    const ok = await saveDailySet({ userId: 'u1', record: { key: KEY, ids: ['a'] }, client: fakeClient({ onUpsert }), storage })
    expect(ok).toBe(true)
    expect(onUpsert).toHaveBeenCalledWith({ user_id: 'u1', day: KEY, item_ids: ['a'] }, { onConflict: 'user_id,day' })
    expect(readLocalRecord('u1', storage).ids).toEqual(['a'])
  })

  it('still remembers the day locally when the server write fails', async () => {
    // A failed write means the set may be re-drawn on another device. That is
    // a smaller cost than an error banner over a feed that is working.
    const storage = fakeStorage()
    const client = fakeClient({ error: { code: '42P01' } })
    expect(await saveDailySet({ userId: 'u1', record: { key: KEY, ids: ['a'] }, client, storage })).toBe(false)
    expect(readLocalRecord('u1', storage).ids).toEqual(['a'])
  })
})

import { describe, it, expect, vi } from 'vitest'
import { needsFacets, planFacetBackfill, chunk, runFacetBackfill, BACKFILL_CHUNK } from './backfillFacets'

describe('needsFacets', () => {
  it('marks a row the classifier has never run on', () => {
    expect(needsFacets({ id: '1', title: 'Chief Strategy Officer', seniority_band: null })).toBe(true)
  })

  it('leaves an already-classified row alone', () => {
    expect(needsFacets({ id: '1', title: 'Chief Strategy Officer', seniority_band: 'c_suite' })).toBe(false)
  })

  // deriveSeniorityBand returns null only for a genuinely empty title, so a row
  // with no title can never be repaired and must not be retried on every load.
  it('skips a row with no title at all', () => {
    expect(needsFacets({ id: '1', title: null, seniority_band: null })).toBe(false)
    expect(needsFacets({ id: '1', title: '   ', seniority_band: null })).toBe(false)
    expect(needsFacets(null)).toBe(false)
  })
})

describe('planFacetBackfill', () => {
  it('classifies the unclassified and returns rows ready to render', () => {
    const { updates, patched } = planFacetBackfill([
      { id: 'a', title: 'Group Chief Strategy Officer', company: 'ADQ', seniority_band: null },
      { id: 'b', title: 'Head of Data', company: 'EGA', seniority_band: 'director_vp' },
    ])
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ id: 'a', seniority_band: 'c_suite' })
    // Both rows come back, so the caller can render the whole list from `patched`.
    expect(patched).toHaveLength(2)
    expect(patched[0].seniority_band).toBe('c_suite')
    expect(patched[1].seniority_band).toBe('director_vp')
  })

  // The migration set relationship_tier from a fact check (does an email or a
  // phone exist), and only the mailbox backfill can earn 'client'. Recomputing
  // it here would silently demote a client back to a contact on every load.
  it('never touches relationship_tier', () => {
    const { updates, patched } = planFacetBackfill([
      { id: 'a', title: 'Chief Strategy Officer', email: 'x@y.com', relationship_tier: 'client', seniority_band: null },
    ])
    expect(updates[0]).not.toHaveProperty('relationship_tier')
    expect(patched[0].relationship_tier).toBe('client')
  })

  it('flags a competitor it finds while repairing', () => {
    const { updates } = planFacetBackfill([
      { id: 'a', title: 'Managing Director - Executive Search', company: 'Rival', seniority_band: null },
    ])
    expect(updates[0].is_competitor).toBe(true)
  })

  it('does nothing when everything is already classified', () => {
    const { updates } = planFacetBackfill([{ id: 'a', title: 'CEO', seniority_band: 'c_suite' }])
    expect(updates).toEqual([])
  })

  it('survives an empty CRM', () => {
    expect(planFacetBackfill([])).toEqual({ updates: [], patched: [] })
    expect(planFacetBackfill()).toEqual({ updates: [], patched: [] })
  })
})

describe('chunk', () => {
  it('splits into batches small enough to fail cheaply', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
    expect(chunk(Array.from({ length: 450 }, (_, i) => i)).length)
      .toBe(Math.ceil(450 / BACKFILL_CHUNK))
  })
})

describe('runFacetBackfill', () => {
  function fakeSupabase({ failEvery = 0 } = {}) {
    let n = 0
    return {
      from: () => ({
        update: () => ({
          eq: async () => {
            n += 1
            return failEvery && n % failEvery === 0 ? { error: { message: 'db down' } } : { error: null }
          },
        }),
      }),
    }
  }

  it('writes every unclassified row and reports the count', async () => {
    const contacts = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, title: 'Chief Strategy Officer', seniority_band: null }))
    const { written } = await runFacetBackfill(fakeSupabase(), contacts)
    expect(written).toBe(5)
  })

  // A failed repair must never take the feed down: the customer still has their
  // signals, and the classification simply happens again on the next load.
  it('never throws, and still reports what did get written', async () => {
    const contacts = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, title: 'CEO', seniority_band: null }))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { written } = await runFacetBackfill(fakeSupabase({ failEvery: 2 }), contacts)
    expect(written).toBe(2)
    spy.mockRestore()
  })

  it('does no work and no writes when nothing needs repair', async () => {
    const supabase = fakeSupabase()
    const spy = vi.spyOn(supabase, 'from')
    const { written } = await runFacetBackfill(supabase, [{ id: 'a', title: 'CEO', seniority_band: 'c_suite' }])
    expect(written).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('degrades to a no-op without a supabase client', async () => {
    const { written } = await runFacetBackfill(null, [{ id: 'a', title: 'CEO', seniority_band: null }])
    expect(written).toBe(0)
  })
})

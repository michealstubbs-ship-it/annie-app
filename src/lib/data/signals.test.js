import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listActiveSignals, markSignalSeen, markSignalActioned } from './signals.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    neq: vi.fn(chain),
    order: vi.fn(chain),
    limit: vi.fn(chain),
    update: vi.fn(chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

let builder

beforeEach(() => {
  vi.clearAllMocks()
  builder = makeBuilder({ data: null, error: null })
  fromMock.mockReturnValue(builder)
})

describe('listActiveSignals', () => {
  it('is personal to the caller (explicit user_id filter), excludes actioned and live_job rows, newest first, capped at 200', async () => {
    builder = makeBuilder({ data: [{ id: 's1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listActiveSignals('user_1')
    expect(fromMock).toHaveBeenCalledWith('intelligence_signals')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
    expect(builder.neq).toHaveBeenCalledWith('status', 'actioned')
    expect(builder.neq).toHaveBeenCalledWith('signal_type', 'live_job')
    expect(builder.order).toHaveBeenCalledWith('found_at', { ascending: false })
    expect(builder.limit).toHaveBeenCalledWith(200)
    expect(result).toEqual([{ id: 's1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listActiveSignals('user_1')).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listActiveSignals('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('markSignalSeen', () => {
  it('sets status to seen, targeted by id', async () => {
    await markSignalSeen('s1')
    expect(builder.update).toHaveBeenCalledWith({ status: 'seen' })
    expect(builder.eq).toHaveBeenCalledWith('id', 's1')
  })
})

describe('markSignalActioned', () => {
  it('sets status to actioned, targeted by id', async () => {
    await markSignalActioned('s1')
    expect(builder.update).toHaveBeenCalledWith({ status: 'actioned' })
    expect(builder.eq).toHaveBeenCalledWith('id', 's1')
  })
})

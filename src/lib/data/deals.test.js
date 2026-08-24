import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listDeals, createDeal, updateDeal, deleteDeal } from './deals.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    order: vi.fn(chain),
    insert: vi.fn(chain),
    update: vi.fn(chain),
    delete: vi.fn(chain),
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

describe('listDeals', () => {
  it('is team-scoped by RLS, newest first, no client-side user_id filter', async () => {
    builder = makeBuilder({ data: [{ id: 'd1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listDeals('user_1')
    expect(fromMock).toHaveBeenCalledWith('deals')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'd1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listDeals('user_1')).toEqual([])
  })
})

describe('createDeal', () => {
  it('stamps the given user_id onto the row', async () => {
    await createDeal({ company: 'Acme' }, 'user_1')
    expect(builder.insert).toHaveBeenCalledWith({ company: 'Acme', user_id: 'user_1' })
  })
})

describe('updateDeal', () => {
  it('targets the row by id', async () => {
    await updateDeal('d1', { company: 'Acme' })
    expect(builder.update).toHaveBeenCalledWith({ company: 'Acme' })
    expect(builder.eq).toHaveBeenCalledWith('id', 'd1')
  })
})

describe('deleteDeal', () => {
  it('targets the row by id', async () => {
    await deleteDeal('d1')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 'd1')
  })
})

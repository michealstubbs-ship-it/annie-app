import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listCompanies, createCompany, updateCompany, deleteCompany, findOrCreateCompany } from './companies.js'

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
    range: vi.fn(chain),
    single: vi.fn(chain),
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

describe('listCompanies', () => {
  it('is team-scoped by RLS, orders alphabetically, no client-side user_id filter', async () => {
    builder = makeBuilder({ data: [{ id: 'co1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listCompanies('user_1')
    expect(fromMock).toHaveBeenCalledWith('companies')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('name')
    expect(result).toEqual([{ id: 'co1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listCompanies('user_1')).toEqual([])
  })

  // 2026-08-26 audit fix: a real Supabase error used to look identical to
  // "no rows" — both fell through to `data || []`.
  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listCompanies('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('createCompany', () => {
  it('stamps the given user_id onto the row', async () => {
    await createCompany({ name: 'Acme' }, 'user_1')
    expect(builder.insert).toHaveBeenCalledWith({ name: 'Acme', user_id: 'user_1' })
  })
})

describe('updateCompany', () => {
  it('targets the row by id', async () => {
    await updateCompany('co1', { name: 'Acme' })
    expect(builder.update).toHaveBeenCalledWith({ name: 'Acme' })
    expect(builder.eq).toHaveBeenCalledWith('id', 'co1')
  })
})

describe('deleteCompany', () => {
  it('targets the row by id', async () => {
    await deleteCompany('co1')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 'co1')
  })
})

// 2026-08-29 audit fix: Today's Actions' "add to CRM" used to only write a
// free-text company string, never a real companies row/link — see this
// function's own header comment for the full reasoning.
describe('findOrCreateCompany', () => {
  it('returns null for a blank name without calling Supabase at all', async () => {
    expect(await findOrCreateCompany('', 'user_1')).toBeNull()
    expect(await findOrCreateCompany('   ', 'user_1')).toBeNull()
    expect(await findOrCreateCompany(null, 'user_1')).toBeNull()
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('returns the existing company id when a case/whitespace-different match already exists, without creating a duplicate', async () => {
    const lookupBuilder = makeBuilder({ data: [{ id: 'co_existing', name: 'acme trading' }], error: null })
    fromMock.mockReturnValueOnce(lookupBuilder)
    const result = await findOrCreateCompany('  Acme Trading  ', 'user_1')
    expect(result).toBe('co_existing')
    expect(fromMock).toHaveBeenCalledTimes(1) // lookup only, no insert
  })

  it('creates a new company and returns its id when no match exists', async () => {
    const lookupBuilder = makeBuilder({ data: [{ id: 'co_other', name: 'Unrelated Co' }], error: null })
    const insertBuilder = makeBuilder({ data: { id: 'co_new' }, error: null })
    fromMock.mockReturnValueOnce(lookupBuilder).mockReturnValueOnce(insertBuilder)

    const result = await findOrCreateCompany('Brand New Ltd', 'user_1')

    expect(insertBuilder.insert).toHaveBeenCalledWith({ name: 'Brand New Ltd', user_id: 'user_1' })
    expect(result).toBe('co_new')
  })

  it('throws instead of silently proceeding when the lookup itself fails', async () => {
    fromMock.mockReturnValueOnce(makeBuilder({ data: null, error: { message: 'db down' } }))
    await expect(findOrCreateCompany('Acme', 'user_1')).rejects.toEqual({ message: 'db down' })
  })

  it('throws instead of silently proceeding when the insert fails', async () => {
    const lookupBuilder = makeBuilder({ data: [], error: null })
    const insertBuilder = makeBuilder({ data: null, error: { message: 'insert failed' } })
    fromMock.mockReturnValueOnce(lookupBuilder).mockReturnValueOnce(insertBuilder)
    await expect(findOrCreateCompany('Acme', 'user_1')).rejects.toEqual({ message: 'insert failed' })
  })
})

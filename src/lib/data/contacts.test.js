// contacts.js/candidates.js/companies.js/jobs.js are the shared data layer
// pulled out of Contacts.jsx, Candidates.jsx, and Companies.jsx during the
// 2026-08-22 scale-readiness pass (see each component's own history) — thin
// as they are, they're now the one place a scoping mistake (missing
// eq('user_id', ...), wrong table/column) would live, so it's worth
// asserting the actual query shape each one builds.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listContacts, listContactsWithCompany, createContact, updateContact, deleteContact, listContactsMinimal, listContactsForMatching } from './contacts.js'

// A minimal chainable query builder — every method returns `this` so any
// call order these functions use resolves, and awaiting it resolves to
// whatever this test configured as `result`.
function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    not: vi.fn(chain),
    order: vi.fn(chain),
    insert: vi.fn(chain),
    update: vi.fn(chain),
    delete: vi.fn(chain),
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

describe('listContacts', () => {
  it('scopes to the given user and orders newest-first', async () => {
    builder = makeBuilder({ data: [{ id: 'c1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listContacts('user_1')
    expect(fromMock).toHaveBeenCalledWith('contacts')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'c1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)
    expect(await listContacts('user_1')).toEqual([])
  })
})

describe('listContactsWithCompany', () => {
  it('excludes contacts with no company_id', async () => {
    await listContactsWithCompany('user_1')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
    expect(builder.not).toHaveBeenCalledWith('company_id', 'is', null)
  })
})

describe('createContact', () => {
  it('stamps the given user_id onto the row', async () => {
    await createContact({ name: 'Jo' }, 'user_1')
    expect(builder.insert).toHaveBeenCalledWith({ name: 'Jo', user_id: 'user_1' })
  })
})

describe('updateContact', () => {
  it('targets the row by id', async () => {
    await updateContact('c1', { name: 'Jo' })
    expect(builder.update).toHaveBeenCalledWith({ name: 'Jo' })
    expect(builder.eq).toHaveBeenCalledWith('id', 'c1')
  })
})

describe('deleteContact', () => {
  it('targets the row by id', async () => {
    await deleteContact('c1')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 'c1')
  })
})

describe('listContactsMinimal', () => {
  it('scopes to the given user and orders by name', async () => {
    builder = makeBuilder({ data: [{ id: 'c1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listContactsMinimal('user_1')
    expect(builder.select).toHaveBeenCalledWith('id, name, company')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
    expect(builder.order).toHaveBeenCalledWith('name')
    expect(result).toEqual([{ id: 'c1' }])
  })
})

describe('listContactsForMatching', () => {
  it('scopes to the given user with the matching-relevant fields', async () => {
    await listContactsForMatching('user_1')
    expect(builder.select).toHaveBeenCalledWith('id, name, title, company, linkedin_url')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
  })
})

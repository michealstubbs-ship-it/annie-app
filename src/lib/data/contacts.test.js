// contacts.js/candidates.js/companies.js/jobs.js are the shared data layer
// pulled out of Contacts.jsx, Candidates.jsx, and Companies.jsx during the
// 2026-08-22 scale-readiness pass (see each component's own history) — thin
// as they are, they're now the one place a scoping mistake (a stray
// eq('user_id', ...) reintroduced on a team-scoped table, wrong table/
// column) would live, so it's worth asserting the actual query shape each
// one builds. 2026-08-24: contacts became team-scoped by RLS, so these
// assertions now confirm the OPPOSITE — no client-side user_id filter.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listContacts, listContactsWithCompany, createContact, updateContact, deleteContact, listContactsMinimal, listContactsForMatching, getContact, findContactIdByCompanyAndName } from './contacts.js'

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
  it('is team-scoped by RLS, orders newest-first, no client-side user_id filter', async () => {
    builder = makeBuilder({ data: [{ id: 'c1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listContacts('user_1')
    expect(fromMock).toHaveBeenCalledWith('contacts')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'c1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)
    expect(await listContacts('user_1')).toEqual([])
  })

  // 2026-08-26 audit fix: a real Supabase error used to look identical to
  // "no rows" — both fell through to `data || []`.
  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listContacts('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listContactsWithCompany', () => {
  it('excludes contacts with no company_id, no client-side user_id filter', async () => {
    await listContactsWithCompany('user_1')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.not).toHaveBeenCalledWith('company_id', 'is', null)
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listContactsWithCompany('user_1')).rejects.toEqual({ message: 'db down' })
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
  it('is team-scoped by RLS, orders by name, no client-side user_id filter', async () => {
    builder = makeBuilder({ data: [{ id: 'c1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listContactsMinimal('user_1')
    expect(builder.select).toHaveBeenCalledWith('id, name, company')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('name')
    expect(result).toEqual([{ id: 'c1' }])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listContactsMinimal('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('listContactsForMatching', () => {
  it('is team-scoped by RLS with the matching-relevant fields, no client-side user_id filter', async () => {
    await listContactsForMatching('user_1')
    expect(builder.select).toHaveBeenCalledWith('id, name, title, company, linkedin_url')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listContactsForMatching('user_1')).rejects.toEqual({ message: 'db down' })
  })
})

// 2026-09-01: ContactDetailModal's own fetch — added alongside the
// click-to-expand contact detail view (notes log + follow-up reminder).
describe('getContact', () => {
  it('fetches the single full record by id', async () => {
    builder = makeBuilder({ data: { id: 'c1', name: 'Jo' }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await getContact('c1')
    expect(fromMock).toHaveBeenCalledWith('contacts')
    expect(builder.select).toHaveBeenCalledWith('*')
    expect(builder.eq).toHaveBeenCalledWith('id', 'c1')
    expect(result).toEqual({ id: 'c1', name: 'Jo' })
  })

  it('throws on a real Supabase error rather than returning undefined', async () => {
    builder = makeBuilder({ data: null, error: { message: 'not found' } })
    fromMock.mockReturnValue(builder)
    await expect(getContact('missing')).rejects.toEqual({ message: 'not found' })
  })
})

// 2026-09-04, Michael ("when you are adding a candidate, let us as an extra
// function add it to a company as a contact") — Candidates.jsx's guard
// against creating a duplicate contact every time the same candidate is
// re-saved with that option still checked.
describe('findContactIdByCompanyAndName', () => {
  it('returns null without calling Supabase at all for a blank company or name', async () => {
    expect(await findContactIdByCompanyAndName(null, 'Jo')).toBeNull()
    expect(await findContactIdByCompanyAndName('co1', '')).toBeNull()
    expect(await findContactIdByCompanyAndName('co1', '   ')).toBeNull()
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('matches an existing contact at that company case/whitespace-insensitively', async () => {
    builder = makeBuilder({ data: [{ id: 'c1', name: 'Jo Smith' }, { id: 'c2', name: 'Ada Cole' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await findContactIdByCompanyAndName('co1', '  jo smith  ')
    expect(builder.eq).toHaveBeenCalledWith('company_id', 'co1')
    expect(result).toBe('c1')
  })

  it('returns null when no contact at that company matches the name', async () => {
    builder = makeBuilder({ data: [{ id: 'c2', name: 'Ada Cole' }], error: null })
    fromMock.mockReturnValue(builder)
    expect(await findContactIdByCompanyAndName('co1', 'Jo Smith')).toBeNull()
  })

  it('throws instead of silently returning null when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(findContactIdByCompanyAndName('co1', 'Jo Smith')).rejects.toEqual({ message: 'db down' })
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listCompanyDocuments, createCompanyDocument, deleteCompanyDocument } from './companyDocuments.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    order: vi.fn(chain),
    insert: vi.fn(chain),
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

describe('listCompanyDocuments', () => {
  it('filters to the given company, newest first', async () => {
    builder = makeBuilder({ data: [{ id: 'd1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listCompanyDocuments('co1')
    expect(fromMock).toHaveBeenCalledWith('company_documents')
    expect(builder.eq).toHaveBeenCalledWith('company_id', 'co1')
    expect(builder.order).toHaveBeenCalledWith('uploaded_at', { ascending: false })
    expect(result).toEqual([{ id: 'd1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listCompanyDocuments('co1')).toEqual([])
  })

  // Same "a real error must never look like an empty list" fix already
  // applied file-by-file across the rest of lib/data/*.js.
  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listCompanyDocuments('co1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('createCompanyDocument', () => {
  it('inserts the given row as-is', async () => {
    const row = { company_id: 'co1', user_id: 'u1', file_name: 'MSA.pdf', file_path: 'u1/abc.pdf' }
    await createCompanyDocument(row)
    expect(builder.insert).toHaveBeenCalledWith(row)
  })
})

describe('deleteCompanyDocument', () => {
  it('targets the row by id', async () => {
    await deleteCompanyDocument('d1')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 'd1')
  })
})

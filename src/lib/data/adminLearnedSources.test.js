import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { rpc: rpcMock } }))

import { getAdminLearnedSources, deleteAdminLearnedSource } from './adminLearnedSources.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getAdminLearnedSources', () => {
  it('calls get_admin_learned_sources with sector/search/limit, defaulting blanks to null', async () => {
    rpcMock.mockResolvedValue({ data: [{ id: '1', value: 'Acme Corp' }], error: null })
    const result = await getAdminLearnedSources({ sector: 'Technology', search: 'Acme', limit: 50 })
    expect(rpcMock).toHaveBeenCalledWith('get_admin_learned_sources', { p_sector: 'Technology', p_search: 'Acme', p_limit: 50 })
    expect(result).toEqual([{ id: '1', value: 'Acme Corp' }])
  })

  it('defaults to no filters and a limit of 200 when called with nothing', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null })
    await getAdminLearnedSources()
    expect(rpcMock).toHaveBeenCalledWith('get_admin_learned_sources', { p_sector: null, p_search: null, p_limit: 200 })
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null })
    expect(await getAdminLearnedSources()).toEqual([])
  })

  it('throws on a Supabase error rather than silently returning an empty list', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'Not authorized' } })
    await expect(getAdminLearnedSources()).rejects.toEqual({ message: 'Not authorized' })
  })
})

describe('deleteAdminLearnedSource', () => {
  it('calls admin_delete_learned_source with the given id', async () => {
    rpcMock.mockResolvedValue({ error: null })
    await deleteAdminLearnedSource('row_1')
    expect(rpcMock).toHaveBeenCalledWith('admin_delete_learned_source', { p_id: 'row_1' })
  })

  it('throws on a Supabase error', async () => {
    rpcMock.mockResolvedValue({ error: { message: 'Not authorized' } })
    await expect(deleteAdminLearnedSource('row_1')).rejects.toEqual({ message: 'Not authorized' })
  })
})

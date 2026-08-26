import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { getInvoicingDetails, saveInvoicingDetails } from './invoicingDetails.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    upsert: vi.fn(chain),
    maybeSingle: vi.fn(chain),
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

describe('getInvoicingDetails', () => {
  it('reads the single row RLS scopes to the caller\'s own team', async () => {
    builder = makeBuilder({ data: { team_id: 'team1', business_name: 'Acme Recruiting' }, error: null })
    fromMock.mockReturnValue(builder)
    const result = await getInvoicingDetails()
    expect(fromMock).toHaveBeenCalledWith('invoicing_details')
    expect(builder.select).toHaveBeenCalledWith('*')
    expect(result).toEqual({ team_id: 'team1', business_name: 'Acme Recruiting' })
  })

  it('returns null (not an empty array) when no row exists yet', async () => {
    expect(await getInvoicingDetails()).toBeNull()
  })

  it('throws instead of silently returning null when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(getInvoicingDetails()).rejects.toEqual({ message: 'db down' })
  })
})

describe('saveInvoicingDetails', () => {
  it('resolves the caller\'s active team_id and upserts onto it', async () => {
    const teamBuilder = makeBuilder({ data: { team_id: 'team1' }, error: null })
    const detailsBuilder = makeBuilder({ data: { team_id: 'team1', business_name: 'Acme Recruiting' }, error: null })
    fromMock.mockImplementation(table => table === 'team_members' ? teamBuilder : detailsBuilder)

    const result = await saveInvoicingDetails({ business_name: 'Acme Recruiting' }, 'user_1')

    expect(teamBuilder.select).toHaveBeenCalledWith('team_id')
    expect(teamBuilder.eq).toHaveBeenCalledWith('user_id', 'user_1')
    expect(teamBuilder.eq).toHaveBeenCalledWith('status', 'active')
    expect(detailsBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ team_id: 'team1', business_name: 'Acme Recruiting', updated_at: expect.any(String) }),
      { onConflict: 'team_id' }
    )
    expect(result).toEqual({ team_id: 'team1', business_name: 'Acme Recruiting' })
  })

  it('throws a clear error when the caller has no active team, before ever attempting the upsert', async () => {
    const teamBuilder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(teamBuilder)
    await expect(saveInvoicingDetails({ business_name: 'Acme' }, 'user_1')).rejects.toThrow('No active team found for this account')
  })

  it('throws if the team_members lookup itself fails', async () => {
    const teamBuilder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(teamBuilder)
    await expect(saveInvoicingDetails({ business_name: 'Acme' }, 'user_1')).rejects.toEqual({ message: 'db down' })
  })

  it('throws if the upsert itself fails', async () => {
    const teamBuilder = makeBuilder({ data: { team_id: 'team1' }, error: null })
    const detailsBuilder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockImplementation(table => table === 'team_members' ? teamBuilder : detailsBuilder)
    await expect(saveInvoicingDetails({ business_name: 'Acme' }, 'user_1')).rejects.toEqual({ message: 'db down' })
  })
})

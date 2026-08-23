import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { getOnboardingLocations } from './onboarding.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    single: vi.fn(() => Promise.resolve(result)),
  })
  return builder
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getOnboardingLocations', () => {
  it('returns the locations array on a normal row', async () => {
    fromMock.mockReturnValue(makeBuilder({ data: { locations: ['United Kingdom'] }, error: null }))
    expect(await getOnboardingLocations('user_1')).toEqual(['United Kingdom'])
  })

  it('scopes the query to the given user', async () => {
    const builder = makeBuilder({ data: { locations: ['United Kingdom'] }, error: null })
    fromMock.mockReturnValue(builder)
    await getOnboardingLocations('user_1')
    expect(fromMock).toHaveBeenCalledWith('onboarding')
    expect(builder.select).toHaveBeenCalledWith('locations')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
  })

  it('returns null when the query errors', async () => {
    fromMock.mockReturnValue(makeBuilder({ data: null, error: new Error('no row') }))
    expect(await getOnboardingLocations('user_1')).toBeNull()
  })

  it('returns null when locations is missing or empty', async () => {
    fromMock.mockReturnValue(makeBuilder({ data: { locations: [] }, error: null }))
    expect(await getOnboardingLocations('user_1')).toBeNull()
  })

  it('returns null rather than throwing if the client itself throws', async () => {
    fromMock.mockImplementation(() => { throw new Error('boom') })
    expect(await getOnboardingLocations('user_1')).toBeNull()
  })
})

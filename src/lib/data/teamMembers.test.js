import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listTeamMembers, nameForMember } from './teamMembers.js'

// Same chainable-builder shape as contacts.test.js/candidates.test.js — see
// their own header comments for why. Two tables get queried here
// (team_members, then profiles), so each test configures fromMock to
// return a different builder per call in sequence.
function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    in: vi.fn(chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  })
  return builder
}

beforeEach(() => vi.clearAllMocks())

describe('listTeamMembers', () => {
  it('reads only active members, then resolves their names off profiles', async () => {
    const membersBuilder = makeBuilder({ data: [{ user_id: 'u1', role: 'owner' }, { user_id: 'u2', role: 'member' }], error: null })
    const profilesBuilder = makeBuilder({ data: [{ id: 'u1', email: 'a@x.com', full_name: 'Sara K.' }, { id: 'u2', email: 'b@x.com', full_name: null }], error: null })
    fromMock.mockReturnValueOnce(membersBuilder).mockReturnValueOnce(profilesBuilder)

    const result = await listTeamMembers()

    expect(fromMock).toHaveBeenNthCalledWith(1, 'team_members')
    expect(membersBuilder.eq).toHaveBeenCalledWith('status', 'active')
    expect(fromMock).toHaveBeenNthCalledWith(2, 'profiles')
    expect(profilesBuilder.in).toHaveBeenCalledWith('id', ['u1', 'u2'])
    expect(result).toEqual([
      { id: 'u1', name: 'Sara K.', role: 'owner' },
      { id: 'u2', name: 'b@x.com', role: 'member' }, // falls back to email when full_name is null
    ])
  })

  it('never queries profiles when there are no active members', async () => {
    const membersBuilder = makeBuilder({ data: [], error: null })
    fromMock.mockReturnValueOnce(membersBuilder)
    const result = await listTeamMembers()
    expect(fromMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual([])
  })

  it('falls back to "Team member" when a matched profile has neither a name nor an email', async () => {
    const membersBuilder = makeBuilder({ data: [{ user_id: 'u1', role: 'member' }], error: null })
    const profilesBuilder = makeBuilder({ data: [{ id: 'u1', email: null, full_name: null }], error: null })
    fromMock.mockReturnValueOnce(membersBuilder).mockReturnValueOnce(profilesBuilder)
    const result = await listTeamMembers()
    expect(result).toEqual([{ id: 'u1', name: 'Team member', role: 'member' }])
  })

  it('throws instead of silently returning [] when the roster read errors', async () => {
    const membersBuilder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValueOnce(membersBuilder)
    await expect(listTeamMembers()).rejects.toEqual({ message: 'db down' })
  })

  it('throws instead of silently returning [] when the profiles read errors', async () => {
    const membersBuilder = makeBuilder({ data: [{ user_id: 'u1', role: 'owner' }], error: null })
    const profilesBuilder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValueOnce(membersBuilder).mockReturnValueOnce(profilesBuilder)
    await expect(listTeamMembers()).rejects.toEqual({ message: 'db down' })
  })
})

describe('nameForMember', () => {
  const teamMembers = [{ id: 'u1', name: 'Sara K.', role: 'owner' }]

  it('returns null for a blank id rather than "Former team member"', () => {
    expect(nameForMember(teamMembers, null)).toBeNull()
    expect(nameForMember(teamMembers, undefined)).toBeNull()
  })

  it('resolves a known id to its name', () => {
    expect(nameForMember(teamMembers, 'u1')).toBe('Sara K.')
  })

  it('falls back to "Former team member" for an id no longer on the roster', () => {
    expect(nameForMember(teamMembers, 'u_gone')).toBe('Former team member')
  })
})

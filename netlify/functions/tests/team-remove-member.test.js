import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function makeFakeSupabase(teamMembers) {
  const state = { team_members: teamMembers.map((r, i) => ({ id: r.id || `tm_${i}`, ...r })) }
  function builder() {
    const filters = []
    const b = {
      select: () => b,
      eq: (col, val) => { filters.push(r => r[col] === val); return b },
      maybeSingle: () => Promise.resolve({ data: state.team_members.filter(r => filters.every(f => f(r)))[0] || null, error: null }),
      delete: () => {
        const delFilters = []
        return {
          eq: (col, val) => {
            delFilters.push(r => r[col] === val)
            const before = state.team_members.length
            state.team_members = state.team_members.filter(r => !delFilters.every(f => f(r)))
            return Promise.resolve({ data: null, error: null, _removed: before - state.team_members.length })
          },
        }
      },
    }
    return b
  }
  return { _state: state, from: vi.fn(() => builder()) }
}

function makeRequest(body) {
  return new Request('https://annie.example/api/team-remove-member', { method: 'POST', body: JSON.stringify(body) })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  mockGetAuthedUser.mockResolvedValue({ user: { id: 'owner_1' }, error: null })
  vi.resetModules()
  ;({ default: handler } = await import('../team-remove-member.js'))
})

const OWNER = { id: 'tm_owner', team_id: 'team_1', user_id: 'owner_1', role: 'owner', status: 'active' }
const MEMBER = { id: 'tm_member', team_id: 'team_1', user_id: 'member_1', role: 'member', status: 'active' }

describe('team-remove-member', () => {
  it('rejects non-POST', async () => {
    const res = await handler(new Request('https://annie.example/api/team-remove-member', { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('rejects a non-owner', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: { id: 'member_1' }, error: null })
    mockCreateClient.mockReturnValue(makeFakeSupabase([OWNER, MEMBER]))
    const res = await handler(makeRequest({ memberId: 'tm_owner' }))
    expect(res.status).toBe(403)
  })

  it('rejects removing a member of a different team', async () => {
    const otherTeamMember = { id: 'tm_other', team_id: 'team_9', user_id: 'x', role: 'member', status: 'active' }
    mockCreateClient.mockReturnValue(makeFakeSupabase([OWNER, otherTeamMember]))
    const res = await handler(makeRequest({ memberId: 'tm_other' }))
    expect(res.status).toBe(404)
  })

  it("refuses to let the owner remove themselves", async () => {
    mockCreateClient.mockReturnValue(makeFakeSupabase([OWNER, MEMBER]))
    const res = await handler(makeRequest({ memberId: 'tm_owner' }))
    expect(res.status).toBe(400)
  })

  it('removes a real teammate', async () => {
    const supabase = makeFakeSupabase([OWNER, MEMBER])
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ memberId: 'tm_member' }))
    expect(res.status).toBe(200)
    expect(supabase._state.team_members.find(m => m.id === 'tm_member')).toBeUndefined()
  })
})

// team-invite.js is the one place seats actually get filled on a Team-tier
// account, so these tests cover the real business rules that matter:
// owner-only, seat cap enforced, no double-adds, and the two branches (an
// existing Annie account gets added immediately; a brand new email gets a
// real Supabase invite email, with the pending seat rolled back if that
// email never goes out).
//
// A small in-memory fake supabase, same pattern as
// src/lib/todaysActions/resolve.test.js's makeFakeSupabase — real filter
// matching against in-memory arrays, rather than hand-sequencing dozens of
// mockReturnValueOnce calls that would silently break the moment the
// implementation's call order changes.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAuthedUser } = vi.hoisted(() => ({ mockGetAuthedUser: vi.fn() }))
const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn() }))
const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }))

vi.mock('../lib/auth.js', () => ({ getAuthedUser: mockGetAuthedUser }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))

function matchesEq(row, col, val) { return row[col] === val }
function matchesIlike(row, col, val) { return String(row[col] ?? '').toLowerCase() === String(val).toLowerCase() }

function makeFakeSupabase({ teamMembers = [], subscriptions = [], profiles = [], inviteEmailImpl } = {}) {
  const state = {
    team_members: teamMembers.map((r, i) => ({ id: r.id || `tm_${i}`, ...r })),
    subscriptions: subscriptions.map((r, i) => ({ id: r.id || `sub_${i}`, ...r })),
    profiles: profiles.map((r, i) => ({ id: r.id || `p_${i}`, ...r })),
  }
  const inviteUserByEmail = vi.fn(inviteEmailImpl || (async () => ({ error: null })))

  function builder(table) {
    let rows = () => state[table]
    const filters = []
    let wantCount = false
    const b = {
      select: (_cols, opts) => { if (opts?.count === 'exact' && opts?.head) wantCount = true; return b },
      eq: (col, val) => { filters.push(r => matchesEq(r, col, val)); return b },
      ilike: (col, val) => { filters.push(r => matchesIlike(r, col, val)); return b },
      in: (col, vals) => { filters.push(r => vals.includes(r[col])); return b },
      maybeSingle: () => {
        const matched = rows().filter(r => filters.every(f => f(r)))
        return Promise.resolve({ data: matched[0] || null, error: null })
      },
      insert: (row) => {
        const list = (Array.isArray(row) ? row : [row]).map((r, i) => ({ id: `new_${rows().length}_${i}`, ...r }))
        state[table] = [...rows(), ...list]
        return Promise.resolve({ data: list, error: null })
      },
      delete: () => {
        const delFilters = []
        const delB = {
          eq: (col, val) => { delFilters.push(r => matchesEq(r, col, val)); return delB },
          then: (resolve) => {
            state[table] = rows().filter(r => !delFilters.every(f => f(r)))
            resolve({ data: null, error: null })
          },
        }
        return delB
      },
      then: (resolve) => {
        const matched = rows().filter(r => filters.every(f => f(r)))
        resolve(wantCount ? { count: matched.length, error: null } : { data: matched, error: null })
      },
    }
    return b
  }

  // 2026-08-26: the seat count + insert moved from two separate JS
  // round-trips into one atomic, per-team-locked Postgres RPC (see
  // supabase-migrations/2026-08-26-atomic-team-seat-cap.sql) — this fake
  // mirrors that same atomic count-then-insert behaviour in-memory so
  // every existing test (and the new race-condition test) exercises the
  // real call shape team-invite.js now uses.
  const rpc = vi.fn(async (fnName, params) => {
    const seatsUsed = state.team_members.filter(
      r => r.team_id === params.p_team_id && ['active', 'invited'].includes(r.status),
    ).length
    if (seatsUsed >= params.p_seat_limit) {
      return { data: 'seat_limit_reached', error: null }
    }
    if (fnName === 'team_invite_add_active_member') {
      state.team_members = [...state.team_members, {
        id: `new_${state.team_members.length}`,
        team_id: params.p_team_id, user_id: params.p_user_id, role: 'member', status: 'active', activated_at: new Date().toISOString(),
      }]
    } else if (fnName === 'team_invite_add_pending_member') {
      state.team_members = [...state.team_members, {
        id: `new_${state.team_members.length}`,
        team_id: params.p_team_id, invited_email: params.p_invited_email, role: 'member', status: 'invited',
      }]
    }
    return { data: 'ok', error: null }
  })

  return {
    _state: state,
    from: vi.fn((table) => builder(table)),
    rpc,
    auth: { admin: { inviteUserByEmail } },
    _inviteUserByEmail: inviteUserByEmail,
  }
}

function makeRequest(body) {
  return new Request('https://annie.example/api/team-invite', { method: 'POST', body: JSON.stringify(body) })
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.VITE_SUPABASE_ANON_KEY = 'anon_x'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  mockGetAuthedUser.mockResolvedValue({ user: { id: 'owner_1' }, error: null })
  vi.resetModules()
  ;({ default: handler } = await import('../team-invite.js'))
})

const OWNER_TEAM = { team_id: 'team_1', user_id: 'owner_1', role: 'owner', status: 'active' }
const TEAM_SUB = { team_id: 'team_1', tier: 'team', status: 'active', seats: 3 }

describe('guards', () => {
  it('rejects non-POST', async () => {
    const res = await handler(new Request('https://annie.example/api/team-invite', { method: 'GET' }))
    expect(res.status).toBe(405)
  })

  it('requires authentication', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: null, error: 'invalid_session' })
    const supabase = makeFakeSupabase()
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'a@b.com' }))
    expect(res.status).toBe(401)
  })

  it('rejects an invalid email', async () => {
    mockCreateClient.mockReturnValue(makeFakeSupabase({ teamMembers: [OWNER_TEAM], subscriptions: [TEAM_SUB] }))
    const res = await handler(makeRequest({ email: 'not-an-email' }))
    expect(res.status).toBe(400)
  })

  it('rejects a non-owner', async () => {
    mockGetAuthedUser.mockResolvedValue({ user: { id: 'member_1' }, error: null })
    const supabase = makeFakeSupabase({
      teamMembers: [OWNER_TEAM, { team_id: 'team_1', user_id: 'member_1', role: 'member', status: 'active' }],
      subscriptions: [TEAM_SUB],
    })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'new@person.com' }))
    expect(res.status).toBe(403)
  })

  it('rejects someone with no active team at all', async () => {
    mockCreateClient.mockReturnValue(makeFakeSupabase())
    const res = await handler(makeRequest({ email: 'new@person.com' }))
    expect(res.status).toBe(400)
  })

  it('rejects when the team is not on the Team plan', async () => {
    const supabase = makeFakeSupabase({
      teamMembers: [OWNER_TEAM],
      subscriptions: [{ team_id: 'team_1', tier: 'growth', status: 'active', seats: 1 }],
    })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'new@person.com' }))
    expect(res.status).toBe(402)
  })

  it('rejects once every seat is used or pending', async () => {
    const supabase = makeFakeSupabase({
      teamMembers: [
        OWNER_TEAM,
        { team_id: 'team_1', user_id: 'm2', role: 'member', status: 'active' },
        { team_id: 'team_1', invited_email: 'pending@person.com', role: 'member', status: 'invited' },
      ],
      subscriptions: [TEAM_SUB],
    })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'new@person.com' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/seats/)
  })

  it('rejects inviting someone already on the team (pending)', async () => {
    const supabase = makeFakeSupabase({
      teamMembers: [OWNER_TEAM, { team_id: 'team_1', invited_email: 'pending@person.com', role: 'member', status: 'invited' }],
      subscriptions: [TEAM_SUB],
    })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'pending@person.com' }))
    expect(res.status).toBe(400)
  })
})

describe('existing Annie account', () => {
  it('adds them immediately, no email sent', async () => {
    const supabase = makeFakeSupabase({
      teamMembers: [OWNER_TEAM],
      subscriptions: [TEAM_SUB],
      profiles: [{ id: 'user_new', email: 'existing@person.com' }],
    })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'existing@person.com' }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('added')
    expect(supabase._inviteUserByEmail).not.toHaveBeenCalled()
    const added = supabase._state.team_members.find(m => m.user_id === 'user_new')
    expect(added).toMatchObject({ status: 'active', role: 'member' })
  })

  it('refuses to add someone who already belongs to a different team', async () => {
    const supabase = makeFakeSupabase({
      teamMembers: [OWNER_TEAM, { team_id: 'team_2', user_id: 'user_new', role: 'owner', status: 'active' }],
      subscriptions: [TEAM_SUB],
      profiles: [{ id: 'user_new', email: 'existing@person.com' }],
    })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'existing@person.com' }))
    expect(res.status).toBe(400)
  })
})

describe('brand new email', () => {
  it('creates a pending seat and sends a real Supabase invite', async () => {
    const supabase = makeFakeSupabase({ teamMembers: [OWNER_TEAM], subscriptions: [TEAM_SUB] })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'brandnew@person.com' }))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('invited')
    expect(supabase._inviteUserByEmail).toHaveBeenCalledWith('brandnew@person.com', expect.objectContaining({ redirectTo: expect.any(String) }))
    const pending = supabase._state.team_members.find(m => m.invited_email === 'brandnew@person.com')
    expect(pending).toMatchObject({ status: 'invited', role: 'member' })
  })

  it('rolls back the pending seat if the invite email itself fails to send', async () => {
    const supabase = makeFakeSupabase({
      teamMembers: [OWNER_TEAM],
      subscriptions: [TEAM_SUB],
      inviteEmailImpl: async () => ({ error: { message: 'send failed' } }),
    })
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'brandnew@person.com' }))
    expect(res.status).toBe(500)
    expect(supabase._state.team_members.find(m => m.invited_email === 'brandnew@person.com')).toBeUndefined()
    expect(mockReportServerError).toHaveBeenCalled()
  })
})

// 2026-08-26 audit fix: the seat count + insert used to be two separate
// round-trips with nothing serializing them, so two concurrent invites for
// the same team could both pass the seat check and both insert, pushing a
// team over its paid seat limit. Now one atomic RPC call handles both — see
// supabase-migrations/2026-08-26-atomic-team-seat-cap.sql.
describe('atomic seat reservation (2026-08-26 fix)', () => {
  it('calls the atomic team_invite_add_pending_member RPC with the resolved seat limit, not a separate count query', async () => {
    const supabase = makeFakeSupabase({ teamMembers: [OWNER_TEAM], subscriptions: [TEAM_SUB] })
    mockCreateClient.mockReturnValue(supabase)
    await handler(makeRequest({ email: 'brandnew@person.com' }))
    expect(supabase.rpc).toHaveBeenCalledWith('team_invite_add_pending_member', {
      p_team_id: 'team_1', p_invited_email: 'brandnew@person.com', p_seat_limit: 3,
    })
  })

  it('calls the atomic team_invite_add_active_member RPC for an existing Annie account', async () => {
    const supabase = makeFakeSupabase({
      teamMembers: [OWNER_TEAM],
      subscriptions: [TEAM_SUB],
      profiles: [{ id: 'user_new', email: 'existing@person.com' }],
    })
    mockCreateClient.mockReturnValue(supabase)
    await handler(makeRequest({ email: 'existing@person.com' }))
    expect(supabase.rpc).toHaveBeenCalledWith('team_invite_add_active_member', {
      p_team_id: 'team_1', p_user_id: 'user_new', p_seat_limit: 3,
    })
  })

  it('rejects with the seat-limit message when the atomic RPC itself reports the cap reached (simulating a race a JS-only check-then-write would miss)', async () => {
    const supabase = makeFakeSupabase({ teamMembers: [OWNER_TEAM], subscriptions: [TEAM_SUB] })
    // Simulate a concurrent invite winning the race inside the same
    // Postgres transaction lock — the RPC itself says no, even though
    // nothing in this test's in-memory state looks over the cap yet.
    supabase.rpc = vi.fn(async () => ({ data: 'seat_limit_reached', error: null }))
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'brandnew@person.com' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/seats/)
    expect(supabase._state.team_members.find(m => m.invited_email === 'brandnew@person.com')).toBeUndefined()
  })

  it('surfaces an RPC-level error (not a seat-limit response) as a 500, same as any other write failure', async () => {
    const supabase = makeFakeSupabase({ teamMembers: [OWNER_TEAM], subscriptions: [TEAM_SUB] })
    supabase.rpc = vi.fn(async () => ({ data: null, error: { message: 'db unreachable' } }))
    mockCreateClient.mockReturnValue(supabase)
    const res = await handler(makeRequest({ email: 'brandnew@person.com' }))
    expect(res.status).toBe(500)
    expect(mockReportServerError).toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listMeetingsWithContacts, createMeeting, updateMeeting, deleteMeeting } from './meetings.js'

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

describe('listMeetingsWithContacts', () => {
  it('joins the linked contact, team-scoped by RLS, newest first, no client-side user_id filter', async () => {
    builder = makeBuilder({ data: [{ id: 'm1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listMeetingsWithContacts('user_1')
    expect(fromMock).toHaveBeenCalledWith('meetings')
    expect(builder.select).toHaveBeenCalledWith('*, contacts(name, company)')
    expect(builder.eq).not.toHaveBeenCalledWith('user_id', expect.anything())
    expect(builder.order).toHaveBeenCalledWith('meeting_date', { ascending: false })
    expect(result).toEqual([{ id: 'm1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listMeetingsWithContacts('user_1')).toEqual([])
  })
})

describe('createMeeting', () => {
  it('stamps the given user_id onto the row', async () => {
    await createMeeting({ title: 'Intro call' }, 'user_1')
    expect(builder.insert).toHaveBeenCalledWith({ title: 'Intro call', user_id: 'user_1' })
  })
})

describe('updateMeeting', () => {
  it('targets the row by id', async () => {
    await updateMeeting('m1', { title: 'Intro call' })
    expect(builder.update).toHaveBeenCalledWith({ title: 'Intro call' })
    expect(builder.eq).toHaveBeenCalledWith('id', 'm1')
  })
})

describe('deleteMeeting', () => {
  it('targets the row by id', async () => {
    await deleteMeeting('m1')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 'm1')
  })
})

// Same query-shape-assertion convention as contacts.test.js — see that
// file's own header for why. contact_notes is new (2026-09-01) and its
// RLS follows the same team-shared-CRM pattern as contacts/deals/
// candidates/meetings, so there is deliberately no client-side user_id
// filter on the read here either.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listContactNotes, createContactNote } from './contactNotes.js'

function makeBuilder(result) {
  const builder = {}
  const chain = () => builder
  Object.assign(builder, {
    select: vi.fn(chain),
    eq: vi.fn(chain),
    order: vi.fn(chain),
    insert: vi.fn(chain),
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

describe('listContactNotes', () => {
  it('scopes to the given contact, newest first, no client-side user_id filter', async () => {
    builder = makeBuilder({ data: [{ id: 'n1', body: 'Called, left voicemail' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listContactNotes('c1')
    expect(fromMock).toHaveBeenCalledWith('contact_notes')
    expect(builder.eq).toHaveBeenCalledWith('contact_id', 'c1')
    expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([{ id: 'n1', body: 'Called, left voicemail' }])
  })

  it('returns an empty array rather than null when there are no notes yet', async () => {
    builder = makeBuilder({ data: null, error: null })
    fromMock.mockReturnValue(builder)
    expect(await listContactNotes('c1')).toEqual([])
  })

  it('throws instead of silently returning [] when Supabase reports an error', async () => {
    builder = makeBuilder({ data: null, error: { message: 'db down' } })
    fromMock.mockReturnValue(builder)
    await expect(listContactNotes('c1')).rejects.toEqual({ message: 'db down' })
  })
})

describe('createContactNote', () => {
  it('inserts the note against the given contact and user', async () => {
    await createContactNote('c1', 'user_1', 'Meeting outcome: keen to hire a CFO')
    expect(builder.insert).toHaveBeenCalledWith({ contact_id: 'c1', user_id: 'user_1', body: 'Meeting outcome: keen to hire a CFO' })
  })
})

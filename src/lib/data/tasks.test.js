import { describe, it, expect, vi, beforeEach } from 'vitest'

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }))
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }))

import { listTasksWithLinks, createTask, updateTask, deleteTask } from './tasks.js'

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

describe('listTasksWithLinks', () => {
  it('joins the linked contact and candidate, scoped to the given user, due-date ascending with nulls last', async () => {
    builder = makeBuilder({ data: [{ id: 't1' }], error: null })
    fromMock.mockReturnValue(builder)
    const result = await listTasksWithLinks('user_1')
    expect(fromMock).toHaveBeenCalledWith('bd_tasks')
    expect(builder.select).toHaveBeenCalledWith('*, contacts(name, company), candidates(name)')
    expect(builder.eq).toHaveBeenCalledWith('user_id', 'user_1')
    expect(builder.order).toHaveBeenCalledWith('due_date', { ascending: true, nullsFirst: false })
    expect(result).toEqual([{ id: 't1' }])
  })

  it('returns an empty array rather than null when there are no rows', async () => {
    expect(await listTasksWithLinks('user_1')).toEqual([])
  })
})

describe('createTask', () => {
  it('stamps the given user_id onto the row', async () => {
    await createTask({ title: 'Follow up' }, 'user_1')
    expect(builder.insert).toHaveBeenCalledWith({ title: 'Follow up', user_id: 'user_1' })
  })
})

describe('updateTask', () => {
  it('targets the row by id', async () => {
    await updateTask('t1', { title: 'Follow up' })
    expect(builder.update).toHaveBeenCalledWith({ title: 'Follow up' })
    expect(builder.eq).toHaveBeenCalledWith('id', 't1')
  })
})

describe('deleteTask', () => {
  it('targets the row by id', async () => {
    await deleteTask('t1')
    expect(builder.delete).toHaveBeenCalled()
    expect(builder.eq).toHaveBeenCalledWith('id', 't1')
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { insertMock, fromMock } = vi.hoisted(() => {
  const insertMock = vi.fn()
  const fromMock = vi.fn(() => ({ insert: insertMock }))
  return { insertMock, fromMock }
})
vi.mock('./supabase', () => ({ supabase: { from: fromMock } }))

import { logSignalOutcome } from './signalOutcomes.js'

beforeEach(() => {
  vi.clearAllMocks()
  insertMock.mockResolvedValue({ data: null, error: null })
})

describe('logSignalOutcome', () => {
  it('inserts a row with user_id, signal_id, company_name, signal_type and stage', async () => {
    const user = { id: 'u1' }
    const signal = { id: 's1', company_name: 'Acme Ltd', signal_type: 'funding' }
    await logSignalOutcome(user, signal, 'added_to_crm')
    expect(fromMock).toHaveBeenCalledWith('signal_outcomes')
    expect(insertMock).toHaveBeenCalledWith({
      user_id: 'u1',
      signal_id: 's1',
      company_name: 'Acme Ltd',
      signal_type: 'funding',
      stage: 'added_to_crm',
    })
  })

  it('falls back to null for a missing company_name or signal_type', async () => {
    await logSignalOutcome({ id: 'u1' }, { id: 's1' }, 'seen')
    expect(insertMock).toHaveBeenCalledWith({
      user_id: 'u1',
      signal_id: 's1',
      company_name: null,
      signal_type: null,
      stage: 'seen',
    })
  })

  it('is a no-op (never calls supabase) when the user has no id', async () => {
    await logSignalOutcome(null, { id: 's1' }, 'seen')
    await logSignalOutcome({}, { id: 's1' }, 'seen')
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('is a no-op (never calls supabase) when the signal has no id', async () => {
    await logSignalOutcome({ id: 'u1' }, null, 'seen')
    await logSignalOutcome({ id: 'u1' }, {}, 'seen')
    expect(fromMock).not.toHaveBeenCalled()
  })

  it('never throws when the insert itself rejects — best-effort logging must not break the caller', async () => {
    insertMock.mockRejectedValue(new Error('connection reset'))
    await expect(logSignalOutcome({ id: 'u1' }, { id: 's1' }, 'seen')).resolves.toBeUndefined()
  })
})

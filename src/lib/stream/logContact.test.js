import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockUpdate, mockEq, mockCreateContact, mockFrom } = vi.hoisted(() => {
  const mockEq = vi.fn().mockResolvedValue({ error: null })
  const mockUpdate = vi.fn(() => ({ eq: mockEq }))
  const mockFrom = vi.fn(() => ({ update: mockUpdate }))
  const mockCreateContact = vi.fn().mockResolvedValue({ data: { id: 'c_new' }, error: null })
  return { mockUpdate, mockEq, mockCreateContact, mockFrom }
})

vi.mock('../supabase', () => ({ supabase: { from: mockFrom } }))
vi.mock('../data/contacts', () => ({ createContact: mockCreateContact }))

const { logContactNote, saveResolvedContact } = await import('./logContact.js')

beforeEach(() => vi.clearAllMocks())

// This is the write that makes rung 1 reachable at all. Measured on the
// production account: 753 contacts, zero with a note or a logged contact date,
// every one bulk-imported. Until a recruiter can record a conversation from the
// card, "someone you have actually spoken to" can never be true for anyone.
describe('logContactNote', () => {
  it('stamps last_contacted, which is what promotes the card to "Spoken to"', async () => {
    await logContactNote('c1', { note: 'Called about their CFO search' })
    const patch = mockUpdate.mock.calls[0][0]
    expect(patch.last_contacted).toBeTruthy()
    expect(new Date(patch.last_contacted).toString()).not.toBe('Invalid Date')
  })

  it('APPENDS to existing notes rather than overwriting the recruiter\'s own record', async () => {
    await logContactNote('c1', { note: 'Second call', existingNotes: 'Met at ADIPEC' })
    const patch = mockUpdate.mock.calls[0][0]
    expect(patch.notes).toContain('Met at ADIPEC')
    expect(patch.notes).toContain('Second call')
    expect(patch.notes.indexOf('Met at ADIPEC')).toBeLessThan(patch.notes.indexOf('Second call'))
  })

  it('dates the entry so a note read back in six months still means something', async () => {
    await logContactNote('c1', { note: 'Sent the shortlist', contactedAt: new Date('2026-06-12T09:00:00Z') })
    expect(mockUpdate.mock.calls[0][0].notes).toContain('12 Jun 2026')
  })

  it('refuses an empty note rather than writing a dated blank', async () => {
    const res = await logContactNote('c1', { note: '   ' })
    expect(res.error).toBeTruthy()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('refuses without a contact id', async () => {
    const res = await logContactNote(null, { note: 'x' })
    expect(res.error).toBeTruthy()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('saveResolvedContact', () => {
  it('saves the person so the next signal at that company is never paid for twice', async () => {
    await saveResolvedContact({
      contact: { name: 'Dana Riaz', title: 'CFO', email: 'dana@acme.com', linkedin_url: 'https://linkedin.com/in/dana' },
      companyName: 'Acme Ltd',
      userId: 'u1',
    })
    const [row, userId] = mockCreateContact.mock.calls[0]
    expect(userId).toBe('u1')
    expect(row.name).toBe('Dana Riaz')
    expect(row.company).toBe('Acme Ltd')
    expect(row.linkedin_url).toBe('https://linkedin.com/in/dana')
  })

  it('does NOT set last_contacted — saving details is not the same as having spoken to them', async () => {
    // This is the exact overclaim the rebuild exists to remove. A contact saved
    // from an Apollo lookup must land on rung 3, never rung 1.
    await saveResolvedContact({ contact: { name: 'Dana Riaz' }, companyName: 'Acme', userId: 'u1' })
    expect(mockCreateContact.mock.calls[0][0].last_contacted).toBeUndefined()
  })

  it('tags where it came from, so these are distinguishable from a LinkedIn import', async () => {
    await saveResolvedContact({ contact: { name: 'Dana Riaz' }, companyName: 'Acme', userId: 'u1' })
    expect(mockCreateContact.mock.calls[0][0].tags).toEqual(['from-intelligence-feed'])
  })

  it('refuses without a name or a user', async () => {
    expect((await saveResolvedContact({ contact: {}, userId: 'u1' })).error).toBeTruthy()
    expect((await saveResolvedContact({ contact: { name: 'X' } })).error).toBeTruthy()
    expect(mockCreateContact).not.toHaveBeenCalled()
  })
})

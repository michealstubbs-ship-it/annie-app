import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCallChat } = vi.hoisted(() => ({
  mockCallChat: vi.fn().mockResolvedValue({ text: 'a draft' }),
}))
vi.mock('../callChat', () => ({ callChat: mockCallChat }))

const { draftApproach } = await import('./draftApproach.js')
const { computeWayIn } = await import('./wayIn.js')

beforeEach(() => vi.clearAllMocks())

function itemFor(wayInInput, signal = {}) {
  const s = { company_name: 'Aldar Properties', headline: 'AED 38bn Dubai JV', signal_type: 'expansion', ...signal }
  return { signal: s, wayIn: computeWayIn(s, wayInInput) }
}

function promptSent() {
  return mockCallChat.mock.calls[0][0].messages[0].content
}
function systemSent() {
  return mockCallChat.mock.calls[0][0].systemOverride
}

// The single worst thing a draft can do is assert a relationship that does not
// exist. companyMatch.js used to offer "a warm door" on a company-name match
// alone; a draft opening "great to catch up again" undoes the entire rebuild in
// one sentence.
describe('draftApproach — the prompt cannot fake a relationship', () => {
  it('tells the model plainly when there is no history, and forbids the usual openers', async () => {
    await draftApproach({ item: itemFor({ contacts: [{ id: 'c1', name: 'Sarah Khan', company: 'Aldar Properties' }] }) })
    const prompt = promptSent()
    expect(prompt).toContain('NO record of them ever speaking')
    expect(prompt).toMatch(/cold approach/i)
    expect(prompt).toContain('good to speak again')
  })

  it('only allows referencing a past conversation when the recruiter wrote one down', async () => {
    await draftApproach({
      item: itemFor({ contacts: [{ id: 'c1', name: 'Sarah Khan', company: 'Aldar Properties', notes: 'Discussed their finance hires in June' }] }),
    })
    const prompt = promptSent()
    expect(prompt).toContain('HAS dealt with')
    expect(prompt).toContain('Discussed their finance hires in June')
    expect(prompt).toContain('never invent a detail')
  })

  it('treats a candidate as a candidate, not a client contact', async () => {
    await draftApproach({
      item: itemFor({ candidates: [{ id: 'k1', name: 'Omar Haddad', company: 'Aldar Properties', status: 'active' }] }),
    })
    const prompt = promptSent()
    expect(prompt).toContain('CANDIDATE')
    expect(prompt).toContain('NOT a client contact')
    expect(prompt).toMatch(/actively looking/i)
  })

  it('says explicitly not to use a placeholder name on a cold lead', async () => {
    await draftApproach({ item: itemFor({}) })
    expect(promptSent()).toContain('Do not use a placeholder name')
  })
})

describe('draftApproach — cost and shape', () => {
  it('never turns on web search — everything it needs is already in the signal', async () => {
    await draftApproach({ item: itemFor({}) })
    expect(mockCallChat.mock.calls[0][0].webSearch).toBe(false)
  })

  it('carries the recruiter\'s own writing style through', async () => {
    await draftApproach({
      item: itemFor({}),
      profile: { full_name: 'Michael', firm_name: 'Vantage Search Group' },
      onboarding: { writing_style: 'Blunt, no filler, short sentences.', sectors: ['Financial Services'] },
    })
    const prompt = promptSent()
    expect(prompt).toContain('Vantage Search Group')
    expect(prompt).toContain('Blunt, no filler')
    expect(prompt).toContain('Financial Services')
  })

  it('bans the formatting the product bans everywhere else', async () => {
    await draftApproach({ item: itemFor({}) })
    const system = systemSent()
    expect(system).toMatch(/no markdown/i)
    expect(system).toMatch(/no em dashes/i)
    expect(system).toMatch(/six sentences maximum/i)
  })

  it('returns the trimmed draft', async () => {
    mockCallChat.mockResolvedValueOnce({ text: '  hello there  ' })
    const res = await draftApproach({ item: itemFor({}) })
    expect(res.text).toBe('hello there')
  })
})

// admin-ai-insights-generate.js writes daily "Annie's Read" cards — these
// tests cover: not-configured returns 200 without calling anything, the
// grounding data actually gathered from admin_daily_metrics/
// support_escalations/profiles is passed to the Anthropic call, a
// malformed/unparseable AI response inserts nothing rather than throwing,
// an insight with an invalid category/severity is coerced to a safe
// default rather than dropped or crashing the whole batch, more than 5
// insights are capped at 5, the Anthropic daily cap being hit is reported
// but still 200s, and an insert failure is reported but still 200s.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockReportServerError } = vi.hoisted(() => ({ mockReportServerError: vi.fn().mockResolvedValue(undefined) }))
const { mockReserveAnthropicTokens } = vi.hoisted(() => ({ mockReserveAnthropicTokens: vi.fn().mockResolvedValue(true) }))
const { mockInsert } = vi.hoisted(() => ({ mockInsert: vi.fn().mockResolvedValue({ error: null }) }))
const { state } = vi.hoisted(() => ({
  state: { metricsHistory: [], escalations: [], activity: [] },
}))

const { mockCreateClient } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(() => ({
    from(table) {
      if (table === 'admin_daily_metrics') {
        return { select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: state.metricsHistory }) }) }) }
      }
      if (table === 'support_escalations') {
        return { select: () => Promise.resolve({ data: state.escalations }) }
      }
      if (table === 'profiles') {
        return { select: () => ({ not: () => Promise.resolve({ data: state.activity }) }) }
      }
      if (table === 'admin_ai_insights') {
        return { insert: mockInsert }
      }
      throw new Error(`unexpected table ${table}`)
    },
  })),
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: mockCreateClient }))
vi.mock('../lib/aiUsage.js', () => ({ reserveAnthropicTokens: mockReserveAnthropicTokens }))
vi.mock('../lib/reportError.js', () => ({ reportServerError: mockReportServerError }))

function anthropicResponse(insights) {
  return { ok: true, json: () => Promise.resolve({ content: [{ type: 'text', text: JSON.stringify(insights) }] }) }
}

let handler

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_role_x'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  mockReserveAnthropicTokens.mockResolvedValue(true)
  mockInsert.mockResolvedValue({ error: null })
  state.metricsHistory = []
  state.escalations = []
  state.activity = []
  global.fetch = vi.fn().mockResolvedValue(anthropicResponse([]))

  vi.resetModules()
  ;({ default: handler } = await import('../admin-ai-insights-generate.js'))
})

it('returns 200 without calling Supabase or Anthropic when not configured', async () => {
  delete process.env.ANTHROPIC_API_KEY
  const resp = await handler()
  expect(resp.status).toBe(200)
  expect(mockCreateClient).not.toHaveBeenCalled()
  expect(global.fetch).not.toHaveBeenCalled()
})

it('passes real grounding data (metrics history, escalation counts, inactivity) to the Anthropic call', async () => {
  state.metricsHistory = [{ day: '2026-09-02', mrr: 3592, active_accounts: 12, contact_verified_rate: 0.7, company_matched_rate: 0.6 }]
  state.escalations = [{ status: 'open', created_at: '2026-09-01' }, { status: 'resolved', created_at: '2026-08-01' }]
  state.activity = [{ last_active_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString() }]

  await handler()
  const body = JSON.parse(global.fetch.mock.calls[0][1].body)
  const grounding = JSON.parse(body.messages[0].content)
  expect(grounding.dailyMetricsLast14Days).toEqual(state.metricsHistory)
  expect(grounding.openSupportEscalations).toBe(1)
  expect(grounding.accountsInactive14PlusDays).toBe(1)
})

it('inserts nothing when the AI response has no parseable JSON array', async () => {
  global.fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ content: [{ type: 'text', text: 'not json at all' }] }) })
  const resp = await handler()
  expect(resp.status).toBe(200)
  expect(mockInsert).not.toHaveBeenCalled()
})

it('coerces an invalid category/severity to a safe default rather than dropping the insight', async () => {
  global.fetch.mockResolvedValue(anthropicResponse([
    { category: 'not-a-real-category', severity: 'not-a-real-severity', headline: 'h', detail: 'd', citedMetric: 'm' },
  ]))
  await handler()
  expect(mockInsert).toHaveBeenCalledWith([
    expect.objectContaining({ category: 'growth', severity: 'info', headline: 'h', detail: 'd', cited_metric: 'm' }),
  ])
})

it('caps insights at 5 even if the model returns more', async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ category: 'growth', severity: 'info', headline: `h${i}`, detail: 'd', citedMetric: 'm' }))
  global.fetch.mockResolvedValue(anthropicResponse(many))
  await handler()
  expect(mockInsert.mock.calls[0][0]).toHaveLength(5)
})

it('reports but still returns 200 when the Anthropic daily cap is reached', async () => {
  mockReserveAnthropicTokens.mockResolvedValue(false)
  const resp = await handler()
  expect(resp.status).toBe(200)
  expect(mockReportServerError).toHaveBeenCalledWith('admin-ai-insights-generate', expect.any(Error), {})
  expect(global.fetch).not.toHaveBeenCalled()
})

it('reports but still returns 200 when the insert fails', async () => {
  global.fetch.mockResolvedValue(anthropicResponse([{ category: 'finance', severity: 'watch', headline: 'h', detail: 'd', citedMetric: 'm' }]))
  mockInsert.mockResolvedValue({ error: { message: 'insert denied' } })
  const resp = await handler()
  expect(resp.status).toBe(200)
  expect(mockReportServerError).toHaveBeenCalled()
})

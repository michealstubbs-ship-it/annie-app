import { describe, it, expect } from 'vitest'
import { PERIOD_OPTIONS, DEFAULT_PERIOD, periodStart, computeTeamPerformance, summarizeTeam } from './teamPerformanceView.js'

const MEMBERS = [
  { id: 'u1', name: 'Amira', role: 'owner' },
  { id: 'u2', name: 'Sam', role: 'member' },
]

describe('PERIOD_OPTIONS / DEFAULT_PERIOD', () => {
  it('exposes exactly the four periods Michael asked for, in order', () => {
    expect(PERIOD_OPTIONS.map(p => p.key)).toEqual(['month', '3m', '6m', '12m'])
    expect(PERIOD_OPTIONS.map(p => p.label)).toEqual(['This month', 'Last 3 months', 'Last 6 months', 'Last 12 months'])
  })

  it('defaults to 6 months', () => {
    expect(DEFAULT_PERIOD).toBe('6m')
  })
})

describe('periodStart', () => {
  const now = new Date(2026, 8, 15) // 15 Sep 2026 (month is 0-indexed)

  it('"this month" is the 1st of the current month, not a rolling 30 days', () => {
    const start = periodStart('month', now)
    expect(start.getFullYear()).toBe(2026)
    expect(start.getMonth()).toBe(8) // September
    expect(start.getDate()).toBe(1)
  })

  it('"3m"/"6m"/"12m" step back that many whole months from today', () => {
    expect(periodStart('3m', now).getMonth()).toBe(5) // June
    expect(periodStart('6m', now).getMonth()).toBe(2) // March
    const twelve = periodStart('12m', now)
    expect(twelve.getFullYear()).toBe(2025)
    expect(twelve.getMonth()).toBe(8) // September 2025
  })

  it('falls back to the 6m definition for an unknown key', () => {
    expect(periodStart('bogus', now).getMonth()).toBe(2)
  })
})

describe('computeTeamPerformance: pipeline buckets', () => {
  it('counts in play as every non-terminal stage, and keeps rejected/interviewing/offer distinct', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      pipelineLinks: [
        { owner_id: 'u1', stage: 'sourced' },
        { owner_id: 'u1', stage: 'screening' },
        { owner_id: 'u1', stage: 'interviewing' },
        { owner_id: 'u1', stage: 'offer' },
        { owner_id: 'u1', stage: 'rejected' },
      ],
    })
    const amira = rows.find(r => r.id === 'u1')
    // in play = sourced + screening + interviewing + offer = 4 (rejected excluded)
    expect(amira.pipeline.inPlay).toBe(4)
    expect(amira.pipeline.interviewing).toBe(1)
    expect(amira.pipeline.offer).toBe(1)
    expect(amira.pipeline.rejected).toBe(1)
  })

  it('excludes withdrawn and placed from both inPlay and rejected', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      pipelineLinks: [
        { owner_id: 'u1', stage: 'withdrawn' },
        { owner_id: 'u1', stage: 'placed' },
      ],
    })
    const amira = rows.find(r => r.id === 'u1')
    expect(amira.pipeline.inPlay).toBe(0)
    expect(amira.pipeline.rejected).toBe(0)
    expect(amira.pipeline.interviewing).toBe(0)
    expect(amira.pipeline.offer).toBe(0)
  })

  it('interviewing and offer are subsets already counted inside inPlay, not added on top', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      pipelineLinks: [{ owner_id: 'u1', stage: 'interviewing' }],
    })
    const amira = rows.find(r => r.id === 'u1')
    expect(amira.pipeline.inPlay).toBe(1)
    expect(amira.pipeline.interviewing).toBe(1)
  })

  it('skips a link owned by someone no longer on the roster rather than crashing', () => {
    expect(() =>
      computeTeamPerformance({
        teamMembers: MEMBERS,
        pipelineLinks: [{ owner_id: 'gone', stage: 'sourced' }],
      })
    ).not.toThrow()
  })
})

describe('computeTeamPerformance: live jobs, meetings, terms', () => {
  it('buckets live jobs by owner_id as a flat snapshot', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      liveJobs: [
        { id: 'j1', title: 'Finance Manager', owner_id: 'u1' },
        { id: 'j2', title: 'Ops Lead', owner_id: 'u2' },
        { id: 'j3', title: 'Analyst', owner_id: 'u1' },
      ],
    })
    expect(rows.find(r => r.id === 'u1').liveJobs.map(j => j.id)).toEqual(['j1', 'j3'])
    expect(rows.find(r => r.id === 'u2').liveJobs.map(j => j.id)).toEqual(['j2'])
  })

  it('counts meetings by user_id', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      meetings: [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }],
    })
    expect(rows.find(r => r.id === 'u1').meetingsCount).toBe(2)
    expect(rows.find(r => r.id === 'u2').meetingsCount).toBe(1)
  })

  it('credits terms signed to credited_to, falling back to user_id when null', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      termsDocs: [
        { id: 'd1', credited_to: 'u2', user_id: 'u1' }, // explicitly credited to u2
        { id: 'd2', credited_to: null, user_id: 'u1' }, // falls back to u1
      ],
    })
    expect(rows.find(r => r.id === 'u1').termsSigned.map(d => d.id)).toEqual(['d2'])
    expect(rows.find(r => r.id === 'u2').termsSigned.map(d => d.id)).toEqual(['d1'])
  })
})

describe('computeTeamPerformance: revenue and splits', () => {
  it('credits an invoice with splits by percentage, per person', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      invoices: [{ id: 'inv1', job_id: 'j1', total: 1000, currency: 'AED' }],
      splitsByInvoiceId: new Map([
        ['inv1', [{ user_id: 'u1', split_pct: 60 }, { user_id: 'u2', split_pct: 40 }]],
      ]),
    })
    expect(rows.find(r => r.id === 'u1').revenueByCurrency.AED).toBe(600)
    expect(rows.find(r => r.id === 'u2').revenueByCurrency.AED).toBe(400)
  })

  it('falls back to crediting the job owner 100% when an invoice has no splits', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      invoices: [{ id: 'inv1', job_id: 'j1', total: 1000, currency: 'GBP' }],
      jobOwnerById: new Map([['j1', 'u2']]),
    })
    expect(rows.find(r => r.id === 'u2').revenueByCurrency.GBP).toBe(1000)
    expect(rows.find(r => r.id === 'u1').revenueByCurrency.GBP).toBeUndefined()
  })

  it('never sums revenue across different currencies', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      invoices: [
        { id: 'inv1', job_id: 'j1', total: 1000, currency: 'AED' },
        { id: 'inv2', job_id: 'j1', total: 500, currency: 'GBP' },
      ],
      jobOwnerById: new Map([['j1', 'u1']]),
    })
    const amira = rows.find(r => r.id === 'u1')
    expect(amira.revenueByCurrency).toEqual({ AED: 1000, GBP: 500 })
  })

  it('counts a placement once per credited person, not once per split line', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      invoices: [{ id: 'inv1', job_id: 'j1', total: 1000, currency: 'AED' }],
      splitsByInvoiceId: new Map([
        ['inv1', [{ user_id: 'u1', split_pct: 50 }, { user_id: 'u2', split_pct: 50 }]],
      ]),
    })
    expect(rows.find(r => r.id === 'u1').placementsCount).toBe(1)
    expect(rows.find(r => r.id === 'u2').placementsCount).toBe(1)
  })

  it('skips a no-split invoice whose job owner is not resolvable, without crashing', () => {
    expect(() =>
      computeTeamPerformance({
        teamMembers: MEMBERS,
        invoices: [{ id: 'inv1', job_id: 'missing', total: 1000, currency: 'AED' }],
        jobOwnerById: new Map(),
      })
    ).not.toThrow()
  })
})

describe('summarizeTeam', () => {
  it('sums every row into team-wide totals, including per-currency revenue', () => {
    const rows = computeTeamPerformance({
      teamMembers: MEMBERS,
      liveJobs: [{ id: 'j1', owner_id: 'u1' }, { id: 'j2', owner_id: 'u2' }],
      pipelineLinks: [{ owner_id: 'u1', stage: 'sourced' }, { owner_id: 'u2', stage: 'interviewing' }],
      meetings: [{ user_id: 'u1' }, { user_id: 'u2' }, { user_id: 'u2' }],
      termsDocs: [{ id: 'd1', credited_to: 'u1', user_id: 'u1' }],
      invoices: [
        { id: 'inv1', job_id: 'j1', total: 1000, currency: 'AED' },
        { id: 'inv2', job_id: 'j2', total: 200, currency: 'GBP' },
      ],
      jobOwnerById: new Map([['j1', 'u1'], ['j2', 'u2']]),
    })
    const totals = summarizeTeam(rows)
    expect(totals.liveJobs).toBe(2)
    expect(totals.pipelineInPlay).toBe(2)
    expect(totals.meetingsCount).toBe(3)
    expect(totals.termsSignedCount).toBe(1)
    expect(totals.placementsCount).toBe(2)
    expect(totals.revenueByCurrency).toEqual({ AED: 1000, GBP: 200 })
  })

  it('returns zeroed totals for an empty roster without crashing', () => {
    expect(summarizeTeam([])).toEqual({
      liveJobs: 0,
      pipelineInPlay: 0,
      meetingsCount: 0,
      termsSignedCount: 0,
      placementsCount: 0,
      revenueByCurrency: {},
    })
  })

  it('handles being called with no rows at all', () => {
    expect(() => summarizeTeam(undefined)).not.toThrow()
  })
})

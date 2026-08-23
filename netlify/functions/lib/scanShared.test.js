// Regression tests for the exact fragile spots the pre-launch audit found:
// greedy JSON-extraction, dedup-key drift on legal-suffix variants, and
// eventDate values that were never checked for plausibility. Pure logic,
// no network calls, no Netlify runtime — this is the whole point of having
// pulled it out of the two scan functions in the first place.
import { describe, it, expect, vi } from 'vitest'
import {
  extractJson, normalizeKey, toEventIso, resolveSignalType, splitToKeywords,
  mapLocationsToAdzunaCountries, SIGNAL_TYPES, reserveApolloCredits,
  normalizeCompanyKey, dropGenericHiringWhereLiveJobsExist, verifyContact,
  buildEnrichedSignalRow, buildEnrichedSignalRows, mapWithConcurrency, titleBucketKey,
  enrichCompany, looksLikeJobPostingUrl, verifyContactsAcrossFunctions,
} from './scanShared.js'

// Full behavioural coverage for extractJson now lives in
// src/lib/jsonExtract.test.js, next to where the function itself now lives
// (see jsonExtract.js for why). This is just a smoke test that scanShared's
// re-export actually wires up to the real thing, for every backend caller
// that still imports extractJson from here.
describe('extractJson (re-export smoke test — full coverage in src/lib/jsonExtract.test.js)', () => {
  it('is the real bracket-balanced implementation, not a stub', () => {
    const text = '[{"company":"Acme","headline":"Raises $10M"}]\n\nI excluded these as duplicates: [BetaCo, GammaCo].'
    expect(extractJson(text)).toEqual([{ company: 'Acme', headline: 'Raises $10M' }])
  })
})

describe('normalizeKey (dedup)', () => {
  it('dedupes the same company across legal-suffix variants', () => {
    // This is the exact false-negative the audit flagged: before routing
    // through companyMatch.js's normalizeCompanyName, "Acme Ltd" and "Acme
    // Limited" produced two different dedup keys for the same real company.
    const a = normalizeKey('Acme Ltd', 'Raises $10M Series B')
    const b = normalizeKey('Acme Limited', 'Raises $10M Series B')
    expect(a).toBe(b)
  })

  it('still treats genuinely different companies as different', () => {
    const a = normalizeKey('Acme Ltd', 'Raises $10M Series B')
    const b = normalizeKey('Zenith Group', 'Raises $10M Series B')
    expect(a).not.toBe(b)
  })

  it('still treats genuinely different headlines about the same company as different, when neither has a source URL', () => {
    const a = normalizeKey('Acme Ltd', 'Raises $10M Series B')
    const b = normalizeKey('Acme Ltd', 'Appoints new CFO')
    expect(a).not.toBe(b)
  })

  // Real incident, 2026-08-23: the same DP World leadership-change article
  // got written as two separate signals two days apart because the AI
  // phrased the headline differently each run ("Ahmad Al-Hassan elevated to
  // GCC CEO from CFO role" vs "Ahmad Al-Hassan appointed GCC CEO in
  // February 2026") — both from the exact same gulfnews.com URL. Headline
  // text can never be a reliable dedup key on its own; the source URL can.
  it('dedupes two differently-worded headlines about the same event when they share a source URL', () => {
    const a = normalizeKey('DP World', 'Ahmad Al-Hassan elevated to GCC CEO from CFO role', 'https://gulfnews.com/business/markets/dp-world-appoints-ahmad-al-hassan-to-lead-gcc-operations-and-trade-strategy-1.500469474')
    const b = normalizeKey('DP World', 'Ahmad Al-Hassan appointed GCC CEO in February 2026', 'https://gulfnews.com/business/markets/dp-world-appoints-ahmad-al-hassan-to-lead-gcc-operations-and-trade-strategy-1.500469474')
    expect(a).toBe(b)
  })

  it('treats the same headline as different signals when the source URLs genuinely differ', () => {
    const a = normalizeKey('DP World', 'Ahmad Al-Hassan elevated to GCC CEO from CFO role', 'https://gulfnews.com/article-a')
    const b = normalizeKey('DP World', 'Ahmad Al-Hassan elevated to GCC CEO from CFO role', 'https://zawya.com/article-b')
    expect(a).not.toBe(b)
  })

  it('ignores tracking params, protocol, and a trailing slash when comparing source URLs', () => {
    const a = normalizeKey('DP World', 'Headline one', 'https://gulfnews.com/article?utm_source=x')
    const b = normalizeKey('DP World', 'Headline two, worded completely differently', 'http://www.gulfnews.com/article/')
    expect(a).toBe(b)
  })

  it('falls back to headline-based dedup when a signal genuinely has no source URL', () => {
    const a = normalizeKey('Acme Ltd', 'Raises $10M Series B', '')
    const b = normalizeKey('Acme Ltd', 'Raises $10M Series B', null)
    expect(a).toBe(b)
    expect(a).not.toContain('url:')
  })

  // Real find from auditing this exact fix, 2026-08-21: two genuinely
  // different-looking CargoX signals ("UAE logistics startup raises $250M
  // mega-round" vs "Autonomous logistics startup raises $250M Series
  // expansion") both cited the same dxbstart.com/category/funding-news
  // listing page as their source_url, a day apart. Naively keying dedup off
  // that shared URL risks the opposite failure mode from the DP World
  // incident: silently treating a genuinely new story as a duplicate purely
  // because the listing page it appeared under has been cited before.
  it('does not treat a shared category/listing-page URL as a reliable per-story key, so two different headlines under it stay distinct', () => {
    const a = normalizeKey('CargoX', 'UAE logistics startup raises $250M mega-round', 'https://www.dxbstart.com/category/funding-news')
    const b = normalizeKey('CargoX', 'Autonomous logistics startup raises $250M Series expansion', 'https://www.dxbstart.com/category/funding-news')
    expect(a).not.toBe(b)
  })

  it('still uses the URL as the dedup key for a genuine specific-article URL, not just anything under a domain', () => {
    const a = normalizeKey('DP World', 'Headline A', 'https://gulfnews.com/business/markets/dp-world-appoints-ahmad-al-hassan-1.500469474')
    const b = normalizeKey('DP World', 'Headline B, worded completely differently', 'https://gulfnews.com/business/markets/dp-world-appoints-ahmad-al-hassan-1.500469474')
    expect(a).toBe(b)
  })
})

describe('toEventIso (event date plausibility)', () => {
  it('accepts a genuinely recent date', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    expect(toEventIso(yesterday)).not.toBeNull()
  })

  it('rejects a date more than a day in the future — a hallucinated or misread date', () => {
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    expect(toEventIso(nextYear)).toBeNull()
  })

  it('rejects a date far too old to be a genuine "recent signal"', () => {
    expect(toEventIso('2019-01-01')).toBeNull()
  })

  it('rejects unparseable input rather than passing it through', () => {
    expect(toEventIso('not a date')).toBeNull()
    expect(toEventIso(null)).toBeNull()
    expect(toEventIso(undefined)).toBeNull()
  })
})

describe('resolveSignalType', () => {
  it('passes through a valid signal type unchanged', () => {
    expect(resolveSignalType('funding', '[test]')).toBe('funding')
  })

  it('falls back to public_commentary for an off-list value, without throwing', () => {
    expect(resolveSignalType('made_up_type', '[test]')).toBe('public_commentary')
    expect(resolveSignalType(undefined, '[test]')).toBe('public_commentary')
  })

  it('every real signal type is a valid fallback target (public_commentary is on the list)', () => {
    expect(SIGNAL_TYPES).toContain('public_commentary')
  })
})

describe('splitToKeywords', () => {
  it('splits a compound label on & and /', () => {
    expect(splitToKeywords('Strategy & Corporate Development')).toEqual(['Strategy', 'Corporate Development'])
    expect(splitToKeywords('Sales/Business Development')).toEqual(['Sales', 'Business Development'])
  })

  it('handles empty input without throwing', () => {
    expect(splitToKeywords('')).toEqual([])
    expect(splitToKeywords(null)).toEqual([])
  })
})

describe('mapLocationsToAdzunaCountries', () => {
  it('maps a covered market to its ISO code', () => {
    expect(mapLocationsToAdzunaCountries(['UK'])).toEqual(['gb'])
  })

  it('returns nothing for a market Adzuna does not cover, rather than guessing', () => {
    // This matters specifically because Annie's own onboarding markets
    // include GCC — Adzuna has no GCC coverage, and defaulting to a wrong
    // country would inject misleading job leads into the prompt for a
    // customer who never asked for that market.
    expect(mapLocationsToAdzunaCountries(['Dubai', 'GCC', 'UAE'])).toEqual([])
  })

  it('dedupes when multiple onboarding locations map to the same country', () => {
    expect(mapLocationsToAdzunaCountries(['UK', 'United Kingdom', 'Britain'])).toEqual(['gb'])
  })
})

describe('reserveApolloCredits (spend cap)', () => {
  it('fails open when no supabase client is passed', async () => {
    expect(await reserveApolloCredits(undefined)).toBe(true)
    expect(await reserveApolloCredits(null)).toBe(true)
  })

  it('allows the call through when the RPC reports the cap is not reached', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
    const supabase = { rpc }
    expect(await reserveApolloCredits(supabase)).toBe(true)
    expect(rpc).toHaveBeenCalledWith('apollo_reserve_credits', expect.objectContaining({ p_credits: 1 }))
  })

  it('blocks the call when the RPC reports the daily cap is reached', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: false, error: null }) }
    expect(await reserveApolloCredits(supabase)).toBe(false)
  })

  it('respects a custom credits argument', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
    await reserveApolloCredits({ rpc }, 3)
    expect(rpc).toHaveBeenCalledWith('apollo_reserve_credits', expect.objectContaining({ p_credits: 3 }))
  })

  it('fails open (allows the call) if the RPC itself errors — a DB hiccup should not take the whole scan down', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection reset' } }) }
    expect(await reserveApolloCredits(supabase)).toBe(true)
  })

  it('fails open (allows the call) if calling the RPC throws', async () => {
    const supabase = { rpc: vi.fn().mockRejectedValue(new Error('network down')) }
    expect(await reserveApolloCredits(supabase)).toBe(true)
  })
})

describe('dropGenericHiringWhereLiveJobsExist (Live Jobs "replace, not supplement")', () => {
  it('drops a hiring_activity entry for a company that also has a live_job entry', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Ltd', headline: 'Hiring push' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager' },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries)).toEqual([
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager' },
    ])
  })

  it('drops a job_posting_unclaimed entry the same way', () => {
    const entries = [
      { entryType: 'signal', signalType: 'job_posting_unclaimed', company: 'Acme Ltd', headline: 'Job ad up' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager' },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries).some(e => e.signalType === 'job_posting_unclaimed')).toBe(false)
  })

  it('matches company across legal-suffix variants, same normalization as dedup', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Limited', headline: 'Hiring push' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager' },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries)).toHaveLength(1)
  })

  it('leaves a hiring_activity entry alone when no live_job exists for that company', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Ltd', headline: 'Hiring push' },
      { entryType: 'live_job', company: 'Zenith Group', headline: 'Ops Director' },
    ]
    const result = dropGenericHiringWhereLiveJobsExist(entries)
    expect(result.some(e => e.company === 'Acme Ltd')).toBe(true)
  })

  it('never drops other signal types (e.g. funding) for a company with a live_job entry', () => {
    const entries = [
      { entryType: 'signal', signalType: 'funding', company: 'Acme Ltd', headline: 'Raises Series B' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager' },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries)).toHaveLength(2)
  })

  it('is a no-op when there are no live_job entries at all', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Ltd', headline: 'Hiring push' },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries)).toEqual(entries)
  })
})

describe('normalizeCompanyKey', () => {
  it('normalizes legal-suffix variants to the same key', () => {
    expect(normalizeCompanyKey('Acme Ltd')).toBe(normalizeCompanyKey('Acme Limited'))
  })

  it('treats genuinely different companies as different keys', () => {
    expect(normalizeCompanyKey('Acme Ltd')).not.toBe(normalizeCompanyKey('Zenith Group'))
  })
})

// verifyContact's contact cache (company_contacts, keyed by company AND
// title bucket — see titleBucketKey) — the actual fix for double-spending
// Apollo credits when several signals (or, with Live Jobs, several
// open-role entries for the SAME kind of role) hit the same company in one
// run. A mock supabase client stands in for the one real dependency; global
// fetch is stubbed so a cache hit can be proven by asserting it was never
// even called.
function makeMockSupabase({ cachedRow = null } = {}) {
  const upsertCalls = []
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
  const from = vi.fn((table) => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cachedRow, error: null }) }) }) }),
    upsert: async (payload) => { upsertCalls.push(payload); return { data: null, error: null } },
  }))
  return { supabase: { from, rpc }, upsertCalls, rpc }
}

describe('verifyContact — company + title-bucket contact cache', () => {
  it('returns a cached positive contact without spending an Apollo credit, when the cache is fresh', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { supabase, rpc } = makeMockSupabase({
      cachedRow: {
        contact_name: 'Jane Doe', contact_title: 'CFO', contact_linkedin_url: 'https://linkedin.com/in/jane',
        contact_email: 'jane@acme.com', contact_verified: true, checked_at: new Date().toISOString(),
      },
    })
    const result = await verifyContact('apollo-key', 'Acme Ltd', ['CFO'], supabase, 'org_123')
    expect(result).toEqual({ name: 'Jane Doe', title: 'CFO', linkedin_url: 'https://linkedin.com/in/jane', email: 'jane@acme.com' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('returns a cached negative result (already checked, nobody findable for this exact role) without retrying, when the cache is fresh', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { supabase } = makeMockSupabase({
      cachedRow: { contact_verified: false, checked_at: new Date().toISOString() },
    })
    const result = await verifyContact('apollo-key', 'Acme Ltd', ['CFO'], supabase, 'org_123')
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('treats a cache entry older than the TTL as a miss and falls through to a fresh lookup', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ people: [] }) })
    vi.stubGlobal('fetch', fetchSpy)
    const staleDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    const { supabase } = makeMockSupabase({
      cachedRow: { contact_verified: true, contact_name: 'Old Name', checked_at: staleDate },
    })
    await verifyContact('apollo-key', 'Acme Ltd', ['CFO'], supabase, 'org_123')
    expect(fetchSpy).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('returns null without spending a credit when there is no cache entry and no resolved apolloOrgId', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { supabase, rpc } = makeMockSupabase({ cachedRow: null })
    const result = await verifyContact('apollo-key', 'Acme Ltd', ['CFO'], supabase, null)
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const items = [30, 10, 20]
    const result = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise(r => setTimeout(r, ms))
      return ms
    })
    expect(result).toEqual([30, 10, 20])
  })

  it('never runs more than `limit` items concurrently', async () => {
    let active = 0
    let maxActive = 0
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(r => setTimeout(r, 10))
      active--
    })
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('handles an empty list without error', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([])
  })
})

describe('buildEnrichedSignalRow', () => {
  // company_enrichment is looked up with a single .eq(); company_contacts
  // (the contact cache — see titleBucketKey) with two chained .eq() calls,
  // one for company, one for the title bucket. Both return the same
  // `cachedRow` here since these tests only care about one table's fields
  // at a time.
  function makeCacheSupabase(cachedRow) {
    return {
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: cachedRow, error: null }) }),
            maybeSingle: async () => ({ data: cachedRow, error: null }),
          }),
        }),
        upsert: async () => ({ data: null, error: null }),
      })),
    }
  }

  it('forces signal_type to live_job for a live_job entry, ignoring whatever signalType the AI put on it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))
    const supabase = makeCacheSupabase({
      matched: true, apollo_org_id: 'org_1', domain: 'acme.com',
      contact_verified: true, contact_name: 'Jane Doe', checked_at: new Date().toISOString(),
    })
    const row = await buildEnrichedSignalRow(
      { entryType: 'live_job', signalType: 'hiring_activity', company: 'Acme Ltd', headline: 'Senior Finance Manager', sourceUrl: 'https://example.com/job', titleKeywords: ['CFO'] },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.signal_type).toBe('live_job')
    expect(row.company_name).toBe('Acme Ltd')
    expect(row.contact_name).toBe('Jane Doe')
    expect(row.dedup_key).toBe(normalizeKey('Acme Ltd', 'Senior Finance Manager', 'https://example.com/job'))
    vi.unstubAllGlobals()
  })

  it('resolves signal_type through resolveSignalType for an ordinary signal entry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))
    const supabase = makeCacheSupabase({ matched: false, contact_verified: false, contact_checked_at: new Date().toISOString() })
    const row = await buildEnrichedSignalRow(
      { entryType: 'signal', signalType: 'funding', company: 'Acme Ltd', headline: 'Raises Series B' },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.signal_type).toBe('funding')
    vi.unstubAllGlobals()
  })

  // Apollo occasionally returns a thin record with only a first name — that
  // used to be shown on a signal card as if it were a confirmed full
  // identity ("Naif, Project Development Manager"), which reads as broken,
  // not verified. This is the actual fix, exercised end to end through a
  // real Apollo cache-miss lookup rather than just unit-testing the guard
  // in isolation.
  it('does not treat a first-name-only Apollo result as a verified contact', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) {
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', primary_domain: 'acme.com' }] }) }
      }
      if (url.includes('mixed_people/api_search')) {
        return { ok: true, json: async () => ({ people: [{ first_name: 'Naif', last_name: '', title: 'Project Development Manager', id: 'p1' }] }) }
      }
      return { ok: true, text: async () => '' }
    }))
    const row = await buildEnrichedSignalRow(
      { entryType: 'signal', signalType: 'funding', company: 'Rabigh 1', headline: 'Gas plant expansion', titleKeywords: ['Project Development Manager'] },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.contact_verified).toBe(false)
    expect(row.contact_name).toBeNull()
    vi.unstubAllGlobals()
  })

  // A real, observed bug: the model itself sometimes writes citation-style
  // markup into its own JSON answer (imitating a format it's seen
  // elsewhere), and it was leaking straight into what a customer reads on
  // a signal card.
  it('strips citation markup and footnote markers out of every AI-written text field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))
    const supabase = makeCacheSupabase({ matched: false, contact_verified: false, checked_at: new Date().toISOString() })
    const row = await buildEnrichedSignalRow(
      {
        entryType: 'signal', signalType: 'funding', company: 'GCC Private Equity Funds',
        headline: 'Raises new fund <cite index="1-2">[1]</cite>',
        whyItMatters: 'This signals fresh capital <cite index="34-2,34-3">for hiring</cite>[2, 3].',
        whoToApproach: 'The CFO <cite index="5-1">is the right door</cite>.',
        introMessage: 'Saw the news <cite index="6-1">about the raise</cite>.',
        candidateAngle: 'A strong candidate <cite index="7-1">is available</cite>.',
        benchStrengthAngle: 'We know this space <cite index="8-1">well</cite>.',
      },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.headline).toBe('Raises new fund')
    expect(row.why_it_matters).toBe('This signals fresh capital for hiring.')
    expect(row.who_to_approach).toBe('The CFO is the right door.')
    expect(row.intro_message).toBe('Saw the news about the raise.')
    expect(row.candidate_angle).toBe('A strong candidate is available.')
    expect(row.bench_strength_angle).toBe('We know this space well.')
    for (const field of [row.headline, row.why_it_matters, row.who_to_approach, row.intro_message, row.candidate_angle, row.bench_strength_angle]) {
      expect(field).not.toMatch(/cite|\[\d/)
    }
    vi.unstubAllGlobals()
  })
})

// A stateful fake covering both cache tables buildEnrichedSignalRows relies
// on: company_enrichment (keyed by company_name_key alone — org id/domain,
// a genuine company-level fact) and company_contacts (keyed by company_name_key
// + title_key — see titleBucketKey's header for why a contact needs that
// second dimension). Upserts really persist and a subsequent select really
// sees what an earlier upsert wrote, which is the actual mechanism these
// tests are checking, not just "a mock that always reports a cache miss."
function makeTableAwareSupabase() {
  const companyEnrichment = new Map() // company_name_key -> row
  const companyContacts = new Map() // "company_name_key::title_key" -> row
  const from = vi.fn((table) => {
    if (table === 'company_enrichment') {
      return {
        select: () => ({ eq: (_col, key) => ({ maybeSingle: async () => ({ data: companyEnrichment.get(key) || null, error: null }) }) }),
        upsert: async (payload) => {
          companyEnrichment.set(payload.company_name_key, { ...(companyEnrichment.get(payload.company_name_key) || {}), ...payload })
          return { data: null, error: null }
        },
      }
    }
    if (table === 'company_contacts') {
      return {
        select: () => ({
          eq: (_col1, companyKey) => ({
            eq: (_col2, titleKey) => ({
              maybeSingle: async () => ({ data: companyContacts.get(`${companyKey}::${titleKey}`) || null, error: null }),
            }),
          }),
        }),
        upsert: async (payload) => {
          const k = `${payload.company_name_key}::${payload.title_key}`
          companyContacts.set(k, { ...(companyContacts.get(k) || {}), ...payload })
          return { data: null, error: null }
        },
      }
    }
    throw new Error(`unexpected table in test: ${table}`)
  })
  return { rpc: vi.fn().mockResolvedValue({ data: true, error: null }), from }
}

describe('buildEnrichedSignalRows — same-company sequencing (the actual Live Jobs "no double credits" guarantee)', () => {
  it('spends only one Apollo people-search credit for two live_job entries at the same company AND the same title bucket', async () => {
    const supabase = makeTableAwareSupabase()
    let peopleSearchCalls = 0
    let companySearchCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) {
        companySearchCalls++
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', primary_domain: 'acme.com' }] }) }
      }
      if (url.includes('mixed_people/api_search')) {
        peopleSearchCalls++
        return { ok: true, json: async () => ({ people: [{ first_name: 'Jane', last_name: 'Doe', title: 'CFO', id: 'p1' }] }) }
      }
      if (url.includes('people/match')) {
        return { ok: true, json: async () => ({ person: { email: 'jane@acme.com' } }) }
      }
      return { ok: true, text: async () => '' } // verifySourceUrl's HEAD check
    }))

    // Two near-duplicate postings for the SAME kind of role — this is the
    // realistic "don't double-spend" case, not two genuinely different roles.
    const entries = [
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Finance Manager', titleKeywords: ['CFO'], sourceUrl: 'https://x.com/1' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager', titleKeywords: ['CFO'], sourceUrl: 'https://x.com/2' },
    ]
    const rows = await buildEnrichedSignalRows(entries, { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' })

    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.contact_verified)).toBe(true)
    // The whole point: two entries for the SAME company and role must not
    // race each other into two separate Apollo people-search spends.
    expect(peopleSearchCalls).toBe(1)
    expect(companySearchCalls).toBe(1)
    vi.unstubAllGlobals()
  })

  it('does NOT reuse a cached contact across genuinely different roles at the same company — the exact bug this cache used to have', async () => {
    const supabase = makeTableAwareSupabase()
    let peopleSearchCalls = 0
    const seenTitles = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', primary_domain: 'acme.com' }] }) }
      if (url.includes('mixed_people/api_search')) {
        peopleSearchCalls++
        const body = JSON.parse(opts.body)
        seenTitles.push(body.person_titles)
        // Return a different person depending on which role was searched
        // for — a real Apollo call would too.
        const isFinance = body.person_titles?.includes('CFO')
        return { ok: true, json: async () => ({ people: [isFinance ? { first_name: 'Jane', last_name: 'Doe', title: 'CFO', id: 'p1' } : { first_name: 'Sam', last_name: 'Lee', title: 'Head of Engineering', id: 'p2' }] }) }
      }
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { email: 'x@acme.com' } }) }
      return { ok: true, text: async () => '' }
    }))

    // Two GENUINELY different roles at the same company — exactly what Live
    // Jobs introduces, and exactly the case a company-only cache key got wrong.
    const entries = [
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Finance Manager', titleKeywords: ['CFO'], sourceUrl: 'https://x.com/1' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Head of Engineering', titleKeywords: ['CTO', 'Head of Engineering'], sourceUrl: 'https://x.com/2' },
    ]
    const rows = await buildEnrichedSignalRows(entries, { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' })

    const financeRow = rows.find(r => r.headline === 'Finance Manager')
    const engRow = rows.find(r => r.headline === 'Head of Engineering')
    expect(financeRow.contact_name).toBe('Jane Doe')
    expect(engRow.contact_name).toBe('Sam Lee') // NOT Jane Doe reused from the other role
    // Two different roles legitimately need two separate lookups — this is
    // correct spend, not a double-spend on the SAME role.
    expect(peopleSearchCalls).toBe(2)
    vi.unstubAllGlobals()
  })

  it('still produces a row for every entry across different companies', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [] }) }
      return { ok: true, text: async () => '' }
    }))

    const entries = [
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Finance Manager', sourceUrl: 'https://x.com/1' },
      { entryType: 'live_job', company: 'Zenith Group', headline: 'Ops Director', sourceUrl: 'https://x.com/2' },
    ]
    const rows = await buildEnrichedSignalRows(entries, { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' })
    expect(rows.map(r => r.company_name).sort()).toEqual(['Acme Ltd', 'Zenith Group'])
    vi.unstubAllGlobals()
  })
})

describe('titleBucketKey', () => {
  it('is order-independent', () => {
    expect(titleBucketKey(['CFO', 'VP Finance'])).toBe(titleBucketKey(['VP Finance', 'CFO']))
  })

  it('is case-insensitive', () => {
    expect(titleBucketKey(['cfo'])).toBe(titleBucketKey(['CFO']))
  })

  it('buckets no titleKeywords under a stable "general" key rather than colliding with an empty array', () => {
    expect(titleBucketKey(undefined)).toBe('general')
    expect(titleBucketKey([])).toBe('general')
  })

  it('treats genuinely different roles as different buckets', () => {
    expect(titleBucketKey(['CFO'])).not.toBe(titleBucketKey(['CTO', 'Head of Engineering']))
  })
})

// "There should be no company mentioned on Annie without their logo" — the
// fix is enrichCompany always resolving a logo_url one way or another
// (Apollo's own, a Clearbit domain-based guess, or a Clearbit name-based
// guess when Apollo doesn't even match the company), and CompanyLogo.jsx as
// the final client-side fallback if even that fails to load. These pin the
// resolution order on the backend side.
describe('enrichCompany — logo resolution fallback chain', () => {
  it("prefers Apollo's own logo_url when Apollo provides one", async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) {
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', primary_domain: 'acme.com', logo_url: 'https://apollo.example/acme-logo.png' }] }) }
      }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    const result = await enrichCompany('apollo-key', 'Acme Ltd', supabase)
    expect(result.logo_url).toBe('https://apollo.example/acme-logo.png')
    vi.unstubAllGlobals()
  })

  it('builds a domain-based Clearbit logo when Apollo matched the company but gave no logo of its own', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) {
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', primary_domain: 'acme.com' }] }) }
      }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    const result = await enrichCompany('apollo-key', 'Acme Ltd', supabase)
    expect(result.logo_url).toBe('https://logo.clearbit.com/acme.com')
    vi.unstubAllGlobals()
  })

  it("falls back to Clearbit's name-based autocomplete for a domain guess when Apollo doesn't match the company at all", async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [] }) }
      if (url.includes('autocomplete.clearbit.com')) return { ok: true, json: async () => ([{ domain: 'zenith.io' }]) }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    const result = await enrichCompany('apollo-key', 'Zenith Group', supabase)
    expect(result.matched).toBe(false)
    expect(result.logo_url).toBe('https://logo.clearbit.com/zenith.io')
    vi.unstubAllGlobals()
  })

  it('returns a cached row\'s previously-resolved logo_url, even for an unmatched company, without any new network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const supabase = makeTableAwareSupabase()
    await supabase.from('company_enrichment').upsert({
      company_name_key: 'zenith group', company_name: 'Zenith Group',
      domain: null, matched: false, logo_url: 'https://logo.clearbit.com/zenith.io', apollo_org_id: null,
    })
    const result = await enrichCompany('apollo-key', 'Zenith Group', supabase)
    expect(result.logo_url).toBe('https://logo.clearbit.com/zenith.io')
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

// "Any prompt now with a hiring manager, should be addressed directly to
// them" — for leadership_change signals the AI names the actual appointee
// (appointedName), and this looks that exact person up by name rather than
// a generic title search, so the recruiter can be pointed at reaching out
// to them specifically.
describe('verifyContact — leadership_change name-based lookup', () => {
  it('looks up a named appointee via people/match, passing the name and company rather than a title search', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('people/match')) {
        const body = JSON.parse(opts.body)
        if (body.id) return { ok: true, json: async () => ({ person: { email: 'sarah@dewa.gov.ae' } }) }
        expect(body.name).toBe('Sarah Al Mazrouei')
        expect(body.organization_name).toBe('DEWA')
        return { ok: true, json: async () => ({ person: { first_name: 'Sarah', last_name: 'Al Mazrouei', title: 'CEO', id: 'p1' } }) }
      }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    const result = await verifyContact('apollo-key', 'DEWA', [], supabase, 'org_1', 'Sarah Al Mazrouei')
    expect(result).toEqual({ name: 'Sarah Al Mazrouei', title: 'CEO', linkedin_url: '', email: 'sarah@dewa.gov.ae' })
    vi.unstubAllGlobals()
  })

  it('uses a cache bucket separate from an ordinary title-based lookup for the same company, so neither shadows the other', async () => {
    const supabase = makeTableAwareSupabase()
    let titleSearchCalls = 0
    let nameMatchCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('mixed_people/api_search')) { titleSearchCalls++; return { ok: true, json: async () => ({ people: [] }) } }
      if (url.includes('people/match')) {
        const body = JSON.parse(opts.body)
        if (body.name) nameMatchCalls++
        return { ok: true, json: async () => ({ person: {} }) }
      }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    await verifyContact('apollo-key', 'DEWA', ['CEO'], supabase, 'org_1')
    await verifyContact('apollo-key', 'DEWA', ['CEO'], supabase, 'org_1', 'Sarah Al Mazrouei')
    expect(titleSearchCalls).toBe(1)
    expect(nameMatchCalls).toBe(1)
    vi.unstubAllGlobals()
  })
})

describe('buildEnrichedSignalRow — candidateProfile and leadership_change contact resolution', () => {
  it('stores a sanitized candidate_profile, bounding each company list to its max length', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))
    const supabase = makeTableAwareSupabase()
    const row = await buildEnrichedSignalRow(
      {
        entryType: 'signal', signalType: 'funding', company: 'Acme Ltd', headline: 'Raises Series B',
        candidateProfile: {
          yearsMin: 5, yearsMax: 8, functionalExperience: 'Project finance',
          directCompetitors: ['Rival Co', 'Second Co', 'Third Co', 'Fourth Co'],
          similarIndustry: ['Peer Co'],
          widerScope: ['Big Consulting', 'Second Consulting', 'Third Consulting'],
        },
      },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.candidate_profile).toEqual({
      yearsMin: 5, yearsMax: 8, functionalExperience: 'Project finance',
      directCompetitors: ['Rival Co', 'Second Co', 'Third Co'],
      similarIndustry: ['Peer Co'],
      widerScope: ['Big Consulting', 'Second Consulting'],
    })
    vi.unstubAllGlobals()
  })

  it('stores null when the AI leaves candidateProfile blank or omits it entirely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))
    const supabase = makeTableAwareSupabase()
    const row = await buildEnrichedSignalRow(
      { entryType: 'signal', signalType: 'funding', company: 'Acme Ltd', headline: 'Raises Series B' },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.candidate_profile).toBeNull()
    vi.unstubAllGlobals()
  })

  it('only passes appointedName through to contact resolution for leadership_change signals, never for other signal types', async () => {
    const supabase = makeTableAwareSupabase()
    let nameMatchCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', primary_domain: 'acme.com' }] }) }
      if (url.includes('mixed_people/api_search')) return { ok: true, json: async () => ({ people: [] }) }
      if (url.includes('people/match')) {
        const body = JSON.parse(opts.body)
        if (body.name) nameMatchCalls++
        return { ok: true, json: async () => ({ person: {} }) }
      }
      return { ok: true, text: async () => '' }
    }))
    await buildEnrichedSignalRow(
      { entryType: 'signal', signalType: 'funding', company: 'Acme Ltd', headline: 'Raises Series B', appointedName: 'Someone Irrelevant', titleKeywords: ['CFO'] },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(nameMatchCalls).toBe(0)
    vi.unstubAllGlobals()
  })

  it("resolves a leadership_change signal's contact by the appointed name", async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', primary_domain: 'dewa.gov.ae' }] }) }
      if (url.includes('people/match')) {
        const body = JSON.parse(opts.body)
        if (body.id) return { ok: true, json: async () => ({ person: {} }) }
        return { ok: true, json: async () => ({ person: { first_name: 'Sarah', last_name: 'Al Mazrouei', title: 'CEO', id: 'p1' } }) }
      }
      return { ok: true, text: async () => '' }
    }))
    const row = await buildEnrichedSignalRow(
      { entryType: 'signal', signalType: 'leadership_change', company: 'DEWA', headline: 'Appoints new CEO', appointedName: 'Sarah Al Mazrouei' },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.contact_verified).toBe(true)
    expect(row.contact_name).toBe('Sarah Al Mazrouei')
    vi.unstubAllGlobals()
  })
})

describe('looksLikeJobPostingUrl (live_job genuineness gate)', () => {
  it('accepts a company careers-page-shaped URL', () => {
    expect(looksLikeJobPostingUrl('https://acme.com/careers/senior-finance-manager')).toBe(true)
  })

  it('accepts a /jobs/ path', () => {
    expect(looksLikeJobPostingUrl('https://acme.com/jobs/12345')).toBe(true)
  })

  it('accepts a genuine LinkedIn Jobs posting URL', () => {
    expect(looksLikeJobPostingUrl('https://www.linkedin.com/jobs/view/1234567890')).toBe(true)
  })

  it('rejects a plain LinkedIn post/article URL — not a Jobs posting', () => {
    expect(looksLikeJobPostingUrl('https://www.linkedin.com/posts/someone_hiring-activity-1234')).toBe(false)
  })

  it('trusts any Adzuna URL, whatever its path — real by construction (see discoverAdzunaJobs)', () => {
    expect(looksLikeJobPostingUrl('https://www.adzuna.co.uk/details/1234567')).toBe(true)
  })

  it('rejects a news-article-shaped URL', () => {
    expect(looksLikeJobPostingUrl('https://gulfnews.com/business/acme-is-hiring-1.500469474')).toBe(false)
  })

  it('rejects a missing or malformed URL rather than throwing', () => {
    expect(looksLikeJobPostingUrl('')).toBe(false)
    expect(looksLikeJobPostingUrl(null)).toBe(false)
    expect(looksLikeJobPostingUrl('not a url')).toBe(false)
  })
})

describe('verifyContactsAcrossFunctions — the multi-contact fallback for funding/expansion', () => {
  it('returns one contact per function bucket that actually resolves someone', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('mixed_people/api_search')) {
        const body = JSON.parse(opts.body)
        const titles = body.person_titles || []
        if (titles.includes('Head of Product')) return { ok: true, json: async () => ({ people: [{ first_name: 'Priya', last_name: 'Nair', title: 'Head of Product', id: 'p1' }] }) }
        if (titles.includes('Head of Engineering')) return { ok: true, json: async () => ({ people: [{ first_name: 'Sam', last_name: 'Lee', title: 'Head of Engineering', id: 'p2' }] }) }
        return { ok: true, json: async () => ({ people: [] }) } // commercial: nobody found
      }
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { email: 'x@acme.com' } }) }
      return { ok: true, text: async () => '' }
    }))
    const results = await verifyContactsAcrossFunctions('apollo-key', 'Acme Ltd', supabase, 'org_1')
    expect(results).toHaveLength(2) // commercial came back empty, correctly omitted rather than shown as a blank entry
    expect(results.find(r => r.function === 'product').name).toBe('Priya Nair')
    expect(results.find(r => r.function === 'engineering').name).toBe('Sam Lee')
    expect(results.find(r => r.function === 'commercial')).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('reuses the existing per-(company, title-bucket) cache — a second call for the same company and functions spends no further credit', async () => {
    const supabase = makeTableAwareSupabase()
    let peopleSearchCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_people/api_search')) { peopleSearchCalls++; return { ok: true, json: async () => ({ people: [{ first_name: 'Priya', last_name: 'Nair', title: 'Head of Product', id: 'p1' }] }) } }
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { email: 'x@acme.com' } }) }
      return { ok: true, text: async () => '' }
    }))
    await verifyContactsAcrossFunctions('apollo-key', 'Acme Ltd', supabase, 'org_1', ['product'])
    await verifyContactsAcrossFunctions('apollo-key', 'Acme Ltd', supabase, 'org_1', ['product'])
    expect(peopleSearchCalls).toBe(1)
    vi.unstubAllGlobals()
  })
})

describe('buildEnrichedSignalRow — always a contact recommendation on the 4 whitelisted BD Actions types', () => {
  it('a funding signal with no single obvious contact gets a multi-function contact_candidates panel instead, and no single verified contact', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', primary_domain: 'acme.com' }] }) }
      if (url.includes('mixed_people/api_search')) {
        const body = JSON.parse(opts.body)
        if (body.person_titles?.includes('Head of Product')) return { ok: true, json: async () => ({ people: [{ first_name: 'Priya', last_name: 'Nair', title: 'Head of Product', id: 'p1' }] }) }
        return { ok: true, json: async () => ({ people: [] }) }
      }
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { email: 'x@acme.com' } }) }
      return { ok: true, text: async () => '' }
    }))
    const row = await buildEnrichedSignalRow(
      { entryType: 'signal', signalType: 'funding', company: 'Acme Ltd', headline: 'Raises Series B', likelyRoles: ['Head of Product', 'Head of Engineering'] },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.contact_verified).toBe(false)
    expect(row.contact_name).toBeNull()
    expect(row.contact_candidates).toEqual([{ function: 'product', name: 'Priya Nair', title: 'Head of Product', linkedin_url: '', email: 'x@acme.com' }])
    expect(row.likely_roles).toEqual(['Head of Product', 'Head of Engineering'])
    vi.unstubAllGlobals()
  })

  it('a live_job signal whose single-contact lookup finds nobody falls back to the multi-function panel', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', primary_domain: 'acme.com' }] }) }
      if (url.includes('mixed_people/api_search')) {
        const body = JSON.parse(opts.body)
        // The specific role's own title search comes back empty...
        if (body.person_titles?.includes('Finance Manager')) return { ok: true, json: async () => ({ people: [] }) }
        // ...but the commercial bucket resolves someone.
        if (body.person_titles?.includes('Commercial Director')) return { ok: true, json: async () => ({ people: [{ first_name: 'Omar', last_name: 'Khalil', title: 'Commercial Director', id: 'p2' }] }) }
        return { ok: true, json: async () => ({ people: [] }) }
      }
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { email: 'x@acme.com' } }) }
      return { ok: true, text: async () => '' }
    }))
    const row = await buildEnrichedSignalRow(
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Finance Manager', sourceUrl: 'https://acme.com/careers/finance-manager', titleKeywords: ['Finance Manager'] },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.contact_verified).toBe(false)
    expect(row.contact_candidates.some(c => c.name === 'Omar Khalil')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('demotes a live_job entry to hiring_activity when its sourceUrl does not resolve to a recognisable job posting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))
    const supabase = makeTableAwareSupabase()
    const row = await buildEnrichedSignalRow(
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager', sourceUrl: 'https://gulfnews.com/business/acme-hiring-story-1.500469474' },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.signal_type).toBe('hiring_activity')
    vi.unstubAllGlobals()
  })

  it('keeps signal_type live_job when the sourceUrl genuinely looks like a job posting', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }))
    const supabase = makeTableAwareSupabase()
    const row = await buildEnrichedSignalRow(
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager', sourceUrl: 'https://acme.com/careers/senior-finance-manager' },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.signal_type).toBe('live_job')
    vi.unstubAllGlobals()
  })
})

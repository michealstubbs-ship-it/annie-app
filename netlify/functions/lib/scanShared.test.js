// Regression tests for the exact fragile spots the pre-launch audit found:
// greedy JSON-extraction, dedup-key drift on legal-suffix variants, and
// eventDate values that were never checked for plausibility. Pure logic,
// no network calls, no Netlify runtime — this is the whole point of having
// pulled it out of the two scan functions in the first place.
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  extractJson, normalizeKey, toEventIso, resolveSignalType, splitToKeywords, buildSearchKeywords,
  buildJobTitleQueries, functionParentLabel, FUNCTION_JOB_TITLES, GENERIC_LEADERSHIP_TITLES,
  FUNCTION_SUBDISCIPLINES, buildFunctionBreadthHint,
  THEIRSTACK_SENIORITIES,
  mapLocationsToAdzunaCountries, SIGNAL_TYPES, reserveApolloCredits, releaseApolloCredits,
  normalizeCompanyKey, extractFundingSignature, fundingFuzzyKey, dropGenericHiringWhereLiveJobsExist, verifyContact,
  buildEnrichedSignalRow, buildEnrichedSignalRows, mapWithConcurrency, titleBucketKey,
  enrichCompany, looksLikeJobPostingUrl, verifyContactsAcrossFunctions, createTimeoutFetch,
  mapLocationsToTheirStackCountries, reserveTheirStackCredits, discoverTheirStackJobs, discoverHotCompanies,
  looksTruncatedByTokenLimit, getLearnedSources, recordLearnedDiscoveries, isJunkLearnedSourceValue,
  normalizeLearnedLocation,
  writeToSignalPool, fetchSignalPoolMatches, personalizePoolHits,
  logMarketCoverage, getMarketCoverageReport,
  getCustomerWatchlistCompanies, buildCustomerWatchlistHint,
  buildLiveJobBoardHint, buildTargetFirmHint,
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

describe('buildSearchKeywords', () => {
  // The real bug, reproduced with Michael's own onboarding data: 6 sectors
  // split into 8 keyword fragments on their own, so the old
  // [...sectors, ...functions].slice(0, 6) never let a single function
  // keyword through — not just his weakest function, every one of them.
  it("doesn't let a customer with many sectors crowd out every function keyword", () => {
    const sectors = ['Financial Services', 'Technology', 'Energy & Utilities', 'Real Estate', 'Private Equity', 'Government & Public Sector']
    const functions = ['Strategy & Corporate Development', 'Policy & Government Affairs', 'Finance & Accounting', 'Investment & Asset Management']
    const keywords = buildSearchKeywords(sectors, functions)
    expect(keywords).toHaveLength(6)
    // At least one fragment from every selected function must survive, not
    // just the first one — this is what "not Strategy-specific" means.
    expect(keywords).toContain('Strategy')
    expect(keywords.some(k => ['Strategy', 'Corporate Development'].includes(k))).toBe(true)
    expect(keywords.some(k => ['Policy', 'Government Affairs'].includes(k))).toBe(true)
  })

  it('still returns sector-only keywords when no functions are set, same as before', () => {
    expect(buildSearchKeywords(['Financial Services', 'Technology'], [])).toEqual(['Financial Services', 'Technology'])
  })

  it('still returns function-only keywords when no sectors are set', () => {
    expect(buildSearchKeywords([], ['Strategy & Corporate Development'])).toEqual(['Strategy', 'Corporate Development'])
  })

  it('handles empty input on both sides without throwing', () => {
    expect(buildSearchKeywords([], [])).toEqual([])
    expect(buildSearchKeywords(null, null)).toEqual([])
  })

  it('respects a custom max', () => {
    expect(buildSearchKeywords(['Financial Services', 'Technology', 'Real Estate'], ['Strategy'], 2)).toEqual(['Financial Services', 'Strategy'])
  })
})

describe('functionParentLabel', () => {
  it('returns a bare parent label unchanged', () => {
    expect(functionParentLabel('Finance & Accounting')).toBe('Finance & Accounting')
  })

  it('strips the sub-option from a "Parent > Sub" value', () => {
    expect(functionParentLabel('Finance & Accounting > Financial Control')).toBe('Finance & Accounting')
  })

  it('handles empty and nullish input', () => {
    expect(functionParentLabel('')).toBe('')
    expect(functionParentLabel(null)).toBe('')
    expect(functionParentLabel(undefined)).toBe('')
  })
})

describe('buildJobTitleQueries (the 2026-08-31 live-jobs fix)', () => {
  it('returns real job titles, never the function label itself', () => {
    const titles = buildJobTitleQueries(['Finance & Accounting'])
    expect(titles).toContain('Chief Financial Officer')
    expect(titles).not.toContain('Finance & Accounting')
  })

  it('interleaves across functions so a later selection is still represented', () => {
    // The whole point of the old buildSearchKeywords interleave, kept here:
    // four functions and a cap of four must yield one title from each,
    // not four titles from the first.
    const titles = buildJobTitleQueries(
      ['Finance & Accounting', 'Legal & Compliance', 'HR & People', 'Risk & Audit'],
      4,
    )
    expect(titles).toEqual([
      'Chief Financial Officer',
      'General Counsel',
      'Chief People Officer',
      'Chief Risk Officer',
    ])
  })

  it('resolves "Parent > Sub" values to the parent’s titles', () => {
    expect(buildJobTitleQueries(['Legal & Compliance > Regulatory'])).toContain('General Counsel')
  })

  it('deduplicates a title two disciplines share', () => {
    const titles = buildJobTitleQueries(
      ['Operations & Supply Chain', 'General Management / Executive Leadership'],
      8,
    )
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('falls back to generic leadership titles for an unmapped or empty function list', () => {
    // Default max (6) now matches GENERIC_LEADERSHIP_TITLES' own length
    // exactly (2026-09-01) — see both constants' own comments for why they
    // moved together.
    expect(buildJobTitleQueries([])).toEqual(GENERIC_LEADERSHIP_TITLES)
    expect(buildJobTitleQueries(null)).toEqual(GENERIC_LEADERSHIP_TITLES)
    expect(buildJobTitleQueries(['Not A Real Function'])).toEqual(GENERIC_LEADERSHIP_TITLES)
  })

  it('respects the max', () => {
    expect(buildJobTitleQueries(['Finance & Accounting'], 2)).toHaveLength(2)
  })

  it('every mapped function has at least 4 real titles (2026-09-01 breadth expansion, most have 6) and none is its own label', () => {
    for (const [label, titles] of Object.entries(FUNCTION_JOB_TITLES)) {
      expect(titles.length).toBeGreaterThanOrEqual(4)
      expect(titles).not.toContain(label)
    }
  })

  // A live_job signal exists to surface a real BD mandate — the same
  // manager-level floor as functionTaxonomy.js's own corporate-function
  // keywords (2026-09-01, Michael: "make sure they [are] no less than
  // manager level... that will not be interesting for customers"), applied
  // here to every function (job POSTINGS, unlike contact-title matching,
  // are a decision to hire — a junior opening is never a mandate, in any
  // discipline). None of the titles below "Director/Head/VP/Chief/Manager/
  // President/Country Manager/Dean/Provost" seniority words should ever
  // appear in these lists.
  it('every FUNCTION_JOB_TITLES and GENERIC_LEADERSHIP_TITLES entry reads as manager-level or above', () => {
    const seniorityWords = ['chief', 'director', 'head of', 'vp ', 'vp of', 'president', 'manager', 'officer', 'dean', 'provost', 'controller', 'counsel']
    const allTitles = [...Object.values(FUNCTION_JOB_TITLES).flat(), ...GENERIC_LEADERSHIP_TITLES]
    for (const title of allTitles) {
      const lower = title.toLowerCase()
      expect(seniorityWords.some(w => lower.includes(w))).toBe(true)
    }
  })
})

describe('buildFunctionBreadthHint (2026-09-01: cross-industry-by-function search)', () => {
  it('every FUNCTION_JOB_TITLES parent also has a sub-discipline breakdown', () => {
    for (const label of Object.keys(FUNCTION_JOB_TITLES)) {
      expect(FUNCTION_SUBDISCIPLINES[label]?.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('names real sub-disciplines a function covers beyond its most senior title', () => {
    const hint = buildFunctionBreadthHint(['Finance & Accounting'])
    expect(hint).toContain('Finance & Accounting includes')
    expect(hint).toContain('Tax')
    expect(hint).toContain('Treasury')
    // The breadth hint exists specifically so a search doesn't collapse to
    // only the C-suite title — CFO itself isn't a sub-discipline entry.
    expect(hint).not.toContain('Chief Financial Officer')
  })

  it('covers Technology beyond Software Engineering (Michael\'s own example: Data, AI/Cyber)', () => {
    const hint = buildFunctionBreadthHint(['Technology, Data & Engineering'])
    expect(hint).toContain('Cybersecurity')
    expect(hint).toContain('Data & Analytics')
  })

  it('is general for any account\'s own chosen functions, not hardcoded to one set', () => {
    const hint = buildFunctionBreadthHint(['Legal & Compliance', 'HR & People'])
    expect(hint).toContain('Legal & Compliance includes')
    expect(hint).toContain('HR & People includes')
    expect(hint).not.toContain('Finance & Accounting')
  })

  it('resolves a "Parent > Sub" selection to its parent, same as buildJobTitleQueries', () => {
    const hint = buildFunctionBreadthHint(['Finance & Accounting > Treasury'])
    expect(hint).toContain('Finance & Accounting includes')
  })

  it('dedupes when the same parent appears twice via different sub-selections', () => {
    const hint = buildFunctionBreadthHint(['Finance & Accounting > Treasury', 'Finance & Accounting > Tax'])
    expect(hint.match(/Finance & Accounting includes/g)).toHaveLength(1)
  })

  it('returns an empty string for no functions rather than throwing', () => {
    expect(buildFunctionBreadthHint([])).toBe('')
    expect(buildFunctionBreadthHint(null)).toBe('')
  })

  it('skips an unmapped/renamed function label rather than throwing', () => {
    expect(buildFunctionBreadthHint(['Not A Real Function'])).toBe('')
  })
})

describe('THEIRSTACK_SENIORITIES', () => {
  it('only contains values TheirStack’s own enum accepts', () => {
    // Confirmed live 2026-08-31 by sending a bad value and reading the
    // validation error: 'c_level', 'staff', 'senior', 'junior', 'mid_level'.
    const allowed = ['c_level', 'staff', 'senior', 'junior', 'mid_level']
    for (const s of THEIRSTACK_SENIORITIES) expect(allowed).toContain(s)
  })

  it('excludes junior and mid_level, which are not mandates', () => {
    expect(THEIRSTACK_SENIORITIES).not.toContain('junior')
    expect(THEIRSTACK_SENIORITIES).not.toContain('mid_level')
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

describe('reserveApolloCredits (per-customer + platform-wide spend cap)', () => {
  const caps = { userDailyCap: 120, platformDailyCap: 1200 }

  it('fails open when no supabase client is passed', async () => {
    expect(await reserveApolloCredits(undefined, 'u1')).toBe(true)
    expect(await reserveApolloCredits(null, 'u1')).toBe(true)
  })

  it('allows the call through when the RPC reports ok, passing userId/credits/caps through', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'ok', error: null })
    const supabase = { rpc }
    expect(await reserveApolloCredits(supabase, 'u1', 1, caps)).toBe(true)
    expect(rpc).toHaveBeenCalledWith('apollo_reserve_credits', { p_credits: 1, p_user_id: 'u1', p_user_daily_cap: 120, p_platform_daily_cap: 1200 })
  })

  it('blocks the call when the RPC reports this customer\'s own daily cap is reached', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 'user_cap', error: null }) }
    expect(await reserveApolloCredits(supabase, 'u1', 1, caps)).toBe(false)
  })

  it('blocks the call when the RPC reports the platform-wide daily cap is reached', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 'platform_cap', error: null }) }
    expect(await reserveApolloCredits(supabase, 'u1', 1, caps)).toBe(false)
  })

  it('respects a custom credits argument', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'ok', error: null })
    await reserveApolloCredits({ rpc }, 'u1', 3, caps)
    expect(rpc).toHaveBeenCalledWith('apollo_reserve_credits', expect.objectContaining({ p_credits: 3 }))
  })

  it('passes a null userId through as null for a system-level call with no customer context', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'ok', error: null })
    await reserveApolloCredits({ rpc }, null, 1, caps)
    expect(rpc).toHaveBeenCalledWith('apollo_reserve_credits', expect.objectContaining({ p_user_id: null }))
  })

  it('falls back to the env-var/default platform cap and a null user cap when caps is omitted', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'ok', error: null })
    await reserveApolloCredits({ rpc }, 'u1')
    expect(rpc).toHaveBeenCalledWith('apollo_reserve_credits', { p_credits: 1, p_user_id: 'u1', p_user_daily_cap: null, p_platform_daily_cap: 1200 })
  })

  it('fails open (allows the call) if the RPC itself errors — a DB hiccup should not take the whole scan down', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection reset' } }) }
    expect(await reserveApolloCredits(supabase, 'u1', 1, caps)).toBe(true)
  })

  it('fails open (allows the call) if calling the RPC throws', async () => {
    const supabase = { rpc: vi.fn().mockRejectedValue(new Error('network down')) }
    expect(await reserveApolloCredits(supabase, 'u1', 1, caps)).toBe(true)
  })
})

// 4th-pass audit fix (2026-08-26): every real Apollo call site reserved
// credits before calling but never released them on failure — a timeout,
// 429, 500, or bad key still permanently cost credits against both caps,
// exactly as if the call had succeeded, making a real outage exhaust the
// shared platform-wide cap FASTER than normal operation. Mirrors
// reserveApolloCredits' own test coverage above.
describe('releaseApolloCredits (refunds a reservation a failed call never actually spent)', () => {
  it('is a no-op when no supabase client is passed', async () => {
    const result = await releaseApolloCredits(undefined, 'u1', 1)
    expect(result).toBeUndefined()
  })

  it('is a no-op when credits is zero, negative, or missing', async () => {
    const rpc = vi.fn()
    await releaseApolloCredits({ rpc }, 'u1', 0)
    await releaseApolloCredits({ rpc }, 'u1', -1)
    await releaseApolloCredits({ rpc }, 'u1', null)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('calls the release RPC with the credits and userId given', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    await releaseApolloCredits({ rpc }, 'u1', 1)
    expect(rpc).toHaveBeenCalledWith('apollo_release_credits', { p_credits: 1, p_user_id: 'u1' })
  })

  it('passes a null userId through as null for a system-level call with no customer context', async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null })
    await releaseApolloCredits({ rpc }, null, 1)
    expect(rpc).toHaveBeenCalledWith('apollo_release_credits', expect.objectContaining({ p_user_id: null }))
  })

  it('logs but does not throw if the RPC reports a query-level error', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ error: { message: 'connection reset' } }) }
    await expect(releaseApolloCredits(supabase, 'u1', 1)).resolves.toBeUndefined()
  })

  it('logs but does not throw if calling the RPC itself throws', async () => {
    const supabase = { rpc: vi.fn().mockRejectedValue(new Error('network down')) }
    await expect(releaseApolloCredits(supabase, 'u1', 1)).resolves.toBeUndefined()
  })
})

describe('looksTruncatedByTokenLimit', () => {
  it('returns false for an empty or missing response', () => {
    expect(looksTruncatedByTokenLimit('')).toBe(false)
    expect(looksTruncatedByTokenLimit(undefined)).toBe(false)
    expect(looksTruncatedByTokenLimit(null)).toBe(false)
  })

  it('returns false for a genuine, cleanly-closed empty array', () => {
    expect(looksTruncatedByTokenLimit('[]')).toBe(false)
  })

  it('returns false for a genuine, cleanly-closed array with real entries', () => {
    const clean = JSON.stringify([{ entryType: 'signal', company: 'Acme', headline: 'Raised Series B' }])
    expect(looksTruncatedByTokenLimit(clean)).toBe(false)
  })

  it('returns false for a response that never even starts a JSON array (a stray narration line)', () => {
    expect(looksTruncatedByTokenLimit('I could not find any genuine signals for this sector today.')).toBe(false)
  })

  it('returns true for a response that opens an array, contains real content, but never closes it', () => {
    const truncated = '[{"entryType":"signal","company":"Acme Gulf Trading","headline":"Raised a Series B round","whyItMatters":"This funding round likely means Acme will expand its engineering and commercial teams over the next two quarters, opening several relevant roles for a recruiter with the right network","sourceUrl":"https://techcrunch.com/acme-series-b","introMessage":"I hope you are doing well.\\n\\nI wanted to reach out because'
    expect(looksTruncatedByTokenLimit(truncated)).toBe(true)
  })

  it('returns false for a short unclosed fragment — not enough content to distinguish from noise', () => {
    expect(looksTruncatedByTokenLimit('[{"entryType":"sig')).toBe(false)
  })
})

describe('mapLocationsToTheirStackCountries', () => {
  it('maps UAE/GCC to its member country codes', () => {
    expect(mapLocationsToTheirStackCountries(['UAE / GCC']).sort()).toEqual(['AE', 'BH', 'KW', 'OM', 'QA', 'SA'])
  })

  it('returns nothing for a market outside the three Annie actually serves', () => {
    // 2026-08-25, Michael: Annie only serves UAE/GCC, UK, US now — UK/US
    // already have real Adzuna coverage (see mapLocationsToAdzunaCountries),
    // so THEIRSTACK_COUNTRY_MAP only ever has a GCC entry on purpose.
    expect(mapLocationsToTheirStackCountries(['United Kingdom', 'United States'])).toEqual([])
  })

  it('is case/whitespace-insensitive the same way mapLocationsToAdzunaCountries is', () => {
    expect(mapLocationsToTheirStackCountries(['uae / gcc', ' UAE / GCC '])).toEqual(['AE', 'SA', 'QA', 'KW', 'BH', 'OM'])
  })
})

describe('reserveTheirStackCredits (per-customer + platform-wide spend cap)', () => {
  const caps = { userDailyCap: 40, platformDailyCap: 500 }

  it('fails open when no supabase client is passed', async () => {
    expect(await reserveTheirStackCredits(undefined, 'u1')).toBe(true)
  })

  it('allows the call through when the RPC reports ok', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'ok', error: null })
    expect(await reserveTheirStackCredits({ rpc }, 'u1', 10, caps)).toBe(true)
    expect(rpc).toHaveBeenCalledWith('theirstack_reserve_credits', { p_credits: 10, p_user_id: 'u1', p_user_daily_cap: 40, p_platform_daily_cap: 500 })
  })

  it('blocks the call when the RPC reports this customer\'s own daily cap is reached', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 'user_cap', error: null }) }
    expect(await reserveTheirStackCredits(supabase, 'u1', 10, caps)).toBe(false)
  })

  it('blocks the call when the RPC reports the platform-wide daily cap is reached', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 'platform_cap', error: null }) }
    expect(await reserveTheirStackCredits(supabase, 'u1', 10, caps)).toBe(false)
  })

  it('fails open if the RPC itself errors', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection reset' } }) }
    expect(await reserveTheirStackCredits(supabase, 'u1', 1, caps)).toBe(true)
  })
})

describe('discoverTheirStackJobs', () => {
  it('returns nothing without an API key, never calling fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await discoverTheirStackJobs('', { sectors: ['Technology'], functions: [], locations: ['UAE / GCC'] })).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('returns nothing for a customer with no GCC market selected, never calling fetch — Adzuna already covers UK/US', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await discoverTheirStackJobs('key123', { sectors: [], functions: [], locations: ['United Kingdom'] })).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not spend a request when the daily credit cap is reached', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: 'platform_cap', error: null }) }
    expect(await discoverTheirStackJobs('key123', { sectors: [], functions: [], locations: ['UAE / GCC'] }, supabase)).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('queries the real endpoint with GCC country codes and maps a real result into the same lead shape discoverAdzunaJobs uses', async () => {
    const fetchSpy = vi.fn(async (url, opts) => {
      expect(url).toBe('https://api.theirstack.com/v1/jobs/search')
      expect(opts.headers.Authorization).toBe('Bearer key123')
      const body = JSON.parse(opts.body)
      expect(body.job_country_code_or.sort()).toEqual(['AE', 'BH', 'KW', 'OM', 'QA', 'SA'])
      return {
        ok: true,
        json: async () => ({
          data: [{
            job_title: 'Head of Product',
            company: 'Skyro',
            location: 'Dubai',
            url: 'https://www.naukrigulf.com/head-of-product-jobs-in-dubai-jid-1',
            source_url: 'https://www.naukrigulf.com/head-of-product-jobs-in-dubai-jid-1',
            salary_string: null,
          }],
        }),
      }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) }
    const leads = await discoverTheirStackJobs('key123', { sectors: ['Financial Services'], functions: [], locations: ['UAE / GCC'] }, supabase)
    expect(leads).toEqual([{
      title: 'Head of Product',
      company: 'Skyro',
      location: 'Dubai',
      url: 'https://www.naukrigulf.com/head-of-product-jobs-in-dubai-jid-1',
      salary: null,
    }])
    vi.unstubAllGlobals()
  })

  it('drops a result missing a title, company or url rather than passing a half-formed lead to the prompt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ job_title: '', company: 'Skyro', url: 'https://x.com/1' }] }),
    }))
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) }
    expect(await discoverTheirStackJobs('key123', { sectors: [], functions: [], locations: ['UAE / GCC'] }, supabase)).toEqual([])
    vi.unstubAllGlobals()
  })

  it('fails soft (empty array, no throw) on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' }))
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) }
    expect(await discoverTheirStackJobs('bad-key', { sectors: [], functions: [], locations: ['UAE / GCC'] }, supabase)).toEqual([])
    vi.unstubAllGlobals()
  })

  // 2026-08-26 audit fix: a flat `limit` (10) credits used to be reserved
  // and never reconciled, regardless of how many jobs TheirStack actually
  // returned (or whether the call even succeeded) — permanently inflating
  // internal cost tracking relative to real per-job billing.
  describe('credit reconciliation (2026-08-26 fix)', () => {
    it('refunds the reservation gap when TheirStack returns fewer jobs than the limit reserved', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ job_title: 'Head of Product', company: 'Skyro', url: 'https://x.com/1' }] }), // 1 of 10 reserved
      }))
      const rpc = vi.fn().mockResolvedValue({ data: 'ok', error: null })
      await discoverTheirStackJobs('key123', { sectors: [], functions: [], locations: ['UAE / GCC'] }, { rpc }, 'u1')
      expect(rpc).toHaveBeenCalledWith('theirstack_release_credits', { p_credits: 9, p_user_id: 'u1' })
      vi.unstubAllGlobals()
    })

    it('refunds the whole reservation on a non-ok response, since nothing was actually billed', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' }))
      const rpc = vi.fn().mockResolvedValue({ data: 'ok', error: null })
      await discoverTheirStackJobs('bad-key', { sectors: [], functions: [], locations: ['UAE / GCC'] }, { rpc }, 'u1')
      expect(rpc).toHaveBeenCalledWith('theirstack_release_credits', { p_credits: 10, p_user_id: 'u1' })
      vi.unstubAllGlobals()
    })

    it('refunds the whole reservation when the call throws outright', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
      const rpc = vi.fn().mockResolvedValue({ data: 'ok', error: null })
      await discoverTheirStackJobs('key123', { sectors: [], functions: [], locations: ['UAE / GCC'] }, { rpc }, 'u1')
      expect(rpc).toHaveBeenCalledWith('theirstack_release_credits', { p_credits: 10, p_user_id: 'u1' })
      vi.unstubAllGlobals()
    })

    it('does not issue a refund when the API returns exactly the full limit of jobs', async () => {
      const tenJobs = Array.from({ length: 10 }, (_, i) => ({ job_title: `Role ${i}`, company: 'Skyro', url: `https://x.com/${i}` }))
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: tenJobs }) }))
      const rpc = vi.fn().mockResolvedValue({ data: 'ok', error: null })
      await discoverTheirStackJobs('key123', { sectors: [], functions: [], locations: ['UAE / GCC'] }, { rpc }, 'u1')
      expect(rpc).not.toHaveBeenCalledWith('theirstack_release_credits', expect.anything())
      vi.unstubAllGlobals()
    })
  })
})

// 2026-09-01 audit fix: found while checking how Sector and Function actually
// scope the live market — this call's own q_organization_job_titles used to
// be built from splitToKeywords(functions), the exact category error the
// 2026-08-31 fix (buildJobTitleQueries) already found and fixed for
// discoverAdzunaJobs/discoverTheirStackJobs above, just missed here. Apollo's
// own API docs are explicit that field wants real title strings ("sales
// manager"), not label fragments ("Real Estate, Facilities"). No prior test
// coverage existed for this function at all.
describe('discoverHotCompanies — Apollo pre-pass company discovery (2026-09-01 job-title fix)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends real senior job titles (via buildJobTitleQueries), not raw function-label fragments, as q_organization_job_titles', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ organizations: [] }) })
    vi.stubGlobal('fetch', fetchSpy)
    await discoverHotCompanies('key123', { sectors: ['Real Estate'], functions: ['Finance & Accounting'], locations: [] }, undefined)
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.q_organization_job_titles).toEqual(buildJobTitleQueries(['Finance & Accounting']))
    expect(body.q_organization_job_titles).toContain('Chief Financial Officer')
    // Never a bare label fragment like the old splitToKeywords output.
    expect(body.q_organization_job_titles).not.toContain('Finance & Accounting')
    expect(body.q_organization_job_titles).not.toContain('Finance')
  })

  it('still sends loose keyword fragments for q_organization_keyword_tags (sectors) — that side was always correct', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ organizations: [] }) })
    vi.stubGlobal('fetch', fetchSpy)
    await discoverHotCompanies('key123', { sectors: ['Real Estate, Facilities & Hospitality'], functions: [], locations: [] }, undefined)
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.q_organization_keyword_tags).toEqual(['Real Estate, Facilities', 'Hospitality'])
  })

  it('falls back to GENERIC_LEADERSHIP_TITLES when the customer picked no functions, same as the sibling Adzuna/TheirStack calls, rather than omitting the filter', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ organizations: [] }) })
    vi.stubGlobal('fetch', fetchSpy)
    await discoverHotCompanies('key123', { sectors: ['Real Estate'], functions: [], locations: [] }, undefined)
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body)
    expect(body.q_organization_job_titles).toEqual(GENERIC_LEADERSHIP_TITLES)
  })

  it('maps organizations from the response into the plain shape the rest of the scan expects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ organizations: [{ name: 'Acme Developments', industry: 'Real Estate', estimated_num_employees: 500 }] }),
    }))
    const leads = await discoverHotCompanies('key123', { sectors: ['Real Estate'], functions: ['Finance & Accounting'], locations: [] }, undefined)
    expect(leads).toEqual([{ name: 'Acme Developments', industry: 'Real Estate', employees: 500 }])
  })

  it('fails soft (empty array) on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    expect(await discoverHotCompanies('bad-key', { sectors: [], functions: [], locations: [] }, undefined)).toEqual([])
  })
})

describe('dropGenericHiringWhereLiveJobsExist (Live Jobs "replace, not supplement")', () => {
  // A real posting URL — passes looksLikeJobPostingUrl — is what makes a
  // live_job entry entitled to suppress a same-company generic-hiring
  // entry as of 2026-08-26; every "drops..." case below needs one.
  const REAL_POSTING_URL = 'https://acme.com/careers/senior-finance-manager'

  it('drops a hiring_activity entry for a company that also has a verified-URL live_job entry', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Ltd', headline: 'Hiring push' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager', sourceUrl: REAL_POSTING_URL },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries)).toEqual([
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager', sourceUrl: REAL_POSTING_URL },
    ])
  })

  it('drops a job_posting_unclaimed entry the same way', () => {
    const entries = [
      { entryType: 'signal', signalType: 'job_posting_unclaimed', company: 'Acme Ltd', headline: 'Job ad up' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager', sourceUrl: REAL_POSTING_URL },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries).some(e => e.signalType === 'job_posting_unclaimed')).toBe(false)
  })

  it('matches company across legal-suffix variants, same normalization as dedup', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Limited', headline: 'Hiring push' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager', sourceUrl: REAL_POSTING_URL },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries)).toHaveLength(1)
  })

  it('leaves a hiring_activity entry alone when no live_job exists for that company', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Ltd', headline: 'Hiring push' },
      { entryType: 'live_job', company: 'Zenith Group', headline: 'Ops Director', sourceUrl: REAL_POSTING_URL },
    ]
    const result = dropGenericHiringWhereLiveJobsExist(entries)
    expect(result.some(e => e.company === 'Acme Ltd')).toBe(true)
  })

  it('never drops other signal types (e.g. funding) for a company with a live_job entry', () => {
    const entries = [
      { entryType: 'signal', signalType: 'funding', company: 'Acme Ltd', headline: 'Raises Series B' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager', sourceUrl: REAL_POSTING_URL },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries)).toHaveLength(2)
  })

  it('is a no-op when there are no live_job entries at all', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Ltd', headline: 'Hiring push' },
    ]
    expect(dropGenericHiringWhereLiveJobsExist(entries)).toEqual(entries)
  })

  // 2026-08-26: the real ordering bug this fixes — a live_job entry whose
  // sourceUrl doesn't actually look like a genuine posting (a news article
  // that merely mentions hiring, or a hallucinated URL) used to still count
  // as "this company has a live job" here, discarding a real, well-sourced
  // hiring_activity entry in its favour — before buildEnrichedSignalRow's
  // own per-entry check ever got a chance to demote that unverified entry.
  // Net loss: the genuinely good entry gone, the unverified one kept.
  it('does NOT drop a hiring_activity entry in favour of a live_job entry whose URL is not a real posting', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Ltd', headline: 'On a genuine hiring push, well sourced' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager', sourceUrl: 'https://technews.example.com/2026/08/acme-raises-funding-and-hiring' },
    ]
    const result = dropGenericHiringWhereLiveJobsExist(entries)
    expect(result.some(e => e.signalType === 'hiring_activity')).toBe(true)
  })

  it('does NOT drop a hiring_activity entry when the live_job entry has no sourceUrl at all', () => {
    const entries = [
      { entryType: 'signal', signalType: 'hiring_activity', company: 'Acme Ltd', headline: 'On a genuine hiring push, well sourced' },
      { entryType: 'live_job', company: 'Acme Ltd', headline: 'Senior Finance Manager' },
    ]
    const result = dropGenericHiringWhereLiveJobsExist(entries)
    expect(result.some(e => e.signalType === 'hiring_activity')).toBe(true)
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

// 2026-09-01, real incident: the same Fasset $68M Series C round got written
// as two separate signals because two different articles (khaleejtimes.com,
// fasset.com's own blog) covered it — normalizeKey's sourceUrl-based key is
// exactly right for a re-paraphrased headline of the SAME article, but can't
// catch two genuinely different articles about the same real event. See
// fundingFuzzyKey's own header for why this is scoped to funding only.
describe('extractFundingSignature', () => {
  it('extracts a round letter and dollar amount when both are confidently present', () => {
    expect(extractFundingSignature('Dubai fintech raises $68M Series C, hits $1B valuation')).toBe('c:68m')
    expect(extractFundingSignature('Series C $68M raises fintech to unicorn status')).toBe('c:68m')
  })

  it('returns null when only one of round/amount is present', () => {
    expect(extractFundingSignature('Fasset hits $1B valuation')).toBeNull()
    expect(extractFundingSignature('Fasset closes a new funding round')).toBeNull()
  })

  it('returns null for empty/missing text', () => {
    expect(extractFundingSignature('')).toBeNull()
    expect(extractFundingSignature(null)).toBeNull()
  })

  it('distinguishes different rounds and different amounts', () => {
    expect(extractFundingSignature('Raises $51M Series B')).not.toBe(extractFundingSignature('Raises $68M Series C'))
  })
})

describe('fundingFuzzyKey', () => {
  it('produces the same key for the same company+round+amount regardless of headline wording', () => {
    const a = fundingFuzzyKey('Fasset', 'funding', 'Dubai fintech raises $68M Series C, hits $1B valuation')
    const b = fundingFuzzyKey('Fasset', 'funding', 'Series C $68M raises fintech to unicorn status')
    expect(a).toBe(b)
    expect(a).not.toBeNull()
  })

  it('falls back to whyItMatters when the headline itself has no figures', () => {
    const key = fundingFuzzyKey('Fasset', 'funding', 'Fasset hits unicorn status', 'The $68M Series C round values the company at $1B.')
    expect(key).not.toBeNull()
  })

  it('is null for a non-funding signal type, even with the same figures', () => {
    expect(fundingFuzzyKey('Fasset', 'leadership_change', 'Fasset raises $68M Series C')).toBeNull()
  })

  it('is null when no round+amount can be confidently extracted', () => {
    expect(fundingFuzzyKey('Fasset', 'funding', 'Fasset closes a new funding round')).toBeNull()
  })

  it('keeps genuinely different rounds for the same company as different keys', () => {
    const seriesB = fundingFuzzyKey('Fasset', 'funding', 'Fasset raises $51M Series B for global expansion')
    const seriesC = fundingFuzzyKey('Fasset', 'funding', 'Dubai fintech raises $68M Series C, hits $1B valuation')
    expect(seriesB).not.toBe(seriesC)
  })
})

// verifyContact's contact cache (company_contacts, keyed by company AND
// title bucket — see titleBucketKey) — the actual fix for double-spending
// Apollo credits when several signals (or, with Live Jobs, several
// open-role entries for the SAME kind of role) hit the same company in one
// run. A mock supabase client stands in for the one real dependency; global
// fetch is stubbed so a cache hit can be proven by asserting it was never
// even called.
function makeMockSupabase({ cachedRow = null, readError = null } = {}) {
  const upsertCalls = []
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null })
  const from = vi.fn((table) => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cachedRow, error: readError }) }) }) }),
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

  // 4th-pass audit fix: same reserve/release gap as discoverTheirStackJobs
  // above, applied to verifyContact's own search-call reservation — a
  // failed Apollo people-search call used to permanently cost the credit
  // reserved for it.
  it('releases the reserved search credit when the Apollo people-search call returns a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' }))
    const { supabase, rpc } = makeMockSupabase()
    await verifyContact('apollo-key', 'Acme Ltd', ['CFO'], supabase, 'org_123', null, 'u1')
    expect(rpc).toHaveBeenCalledWith('apollo_release_credits', { p_credits: 1, p_user_id: 'u1' })
    vi.unstubAllGlobals()
  })

  it('releases the reserved search credit when the Apollo people-search call throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { supabase, rpc } = makeMockSupabase()
    await verifyContact('apollo-key', 'Acme Ltd', ['CFO'], supabase, 'org_123', null, 'u1')
    expect(rpc).toHaveBeenCalledWith('apollo_release_credits', { p_credits: 1, p_user_id: 'u1' })
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

  // 2026-08-26 audit fix: a query-level cache-read failure (RLS denial, a
  // bad filter) used to fall through silently, indistinguishable in the
  // logs from an ordinary cache miss.
  it('logs a query-level cache-read failure instead of silently treating it as a cache miss', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ people: [] }) })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = makeMockSupabase({ readError: { message: 'RLS denied' } })
    await verifyContact('apollo-key', 'Acme Ltd', ['CFO'], supabase, 'org_123')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('contact cache lookup failed'), 'RLS denied')
    consoleSpy.mockRestore()
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
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'Rabigh 1', primary_domain: 'acme.com' }] }) }
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

  // 2026-08-24 — the actual root cause of Today's BD Actions going
  // completely empty for every customer, industry-wide: confirmed live
  // against the real Apollo API that mixed_people/api_search masks last
  // names on this account's plan (a `last_name_obfuscated` field like
  // "Re***n", never a usable `last_name`), while the reveal endpoint
  // (people/match, already called for email) returns the real, unmasked
  // name for the same person. The old code required `p.last_name` straight
  // off the search result, which is never present on this plan — so this
  // discarded EVERY Apollo result, for every company, every signal type,
  // even ones Apollo could actually identify. This is the regression test:
  // a masked search result must still resolve to a real verified contact,
  // using the name the reveal call actually gives back.
  it('resolves a real contact from a masked search result, taking the real name from the reveal call — the 2026-08-24 fix', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (url.includes('mixed_companies/search')) {
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'DP World', primary_domain: 'dpworld.com' }] }) }
      }
      if (url.includes('mixed_people/api_search')) {
        // This is what Apollo's search endpoint actually returns on this
        // plan — no last_name at all, only its obfuscated form.
        return {
          ok: true,
          json: async () => ({ people: [{ first_name: 'Risalat', last_name_obfuscated: 'Re***n', title: 'Chief Financial Officer', id: 'p1' }] }),
        }
      }
      if (url.includes('people/match')) {
        const body = JSON.parse(opts.body)
        expect(body.id).toBe('p1') // reveal is keyed by the exact person id from search
        return { ok: true, json: async () => ({ person: { first_name: 'Risalat', last_name: 'Rehman', email: 'risalat.rehman@dpworld.com' } }) }
      }
      return { ok: true, text: async () => '' }
    }))
    const row = await buildEnrichedSignalRow(
      { entryType: 'signal', signalType: 'funding', company: 'DP World', headline: 'Raises new fund', titleKeywords: ['Chief Financial Officer'] },
      { userId: 'u1', apolloKey: 'k', companiesHouseKey: 'ch', supabase, logPrefix: '[test]' },
    )
    expect(row.contact_candidates?.length || row.contact_verified).toBeTruthy()
    // funding signals go through verifyContactsAcrossFunctions, so this
    // shows up as a candidate rather than the single contact_verified field
    // — either way, the masked name must not have blocked a real match.
    const resolved = row.contact_verified ? row.contact_name : row.contact_candidates?.[0]?.name
    expect(resolved).toBe('Risalat Rehman')
    vi.unstubAllGlobals()
  })

  it('still returns null when the reveal call itself cannot confirm a real last name (a genuinely thin record, not just a masked one)', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'Acme Ltd', primary_domain: 'acme.com' }] }) }
      if (url.includes('mixed_people/api_search')) {
        return { ok: true, json: async () => ({ people: [{ first_name: 'Naif', last_name_obfuscated: '', title: 'Project Development Manager', id: 'p1' }] }) }
      }
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { first_name: 'Naif', email: null } }) } // no last_name even on reveal
      return { ok: true, text: async () => '' }
    }))
    const result = await verifyContact('apollo-key', 'Rabigh 1', ['Project Development Manager'], supabase, 'org_1')
    expect(result).toBeNull()
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
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'Acme Ltd', primary_domain: 'acme.com' }] }) }
      }
      if (url.includes('mixed_people/api_search')) {
        peopleSearchCalls++
        // Search results carry a masked last name on this account's Apollo
        // plan — 'Doe' here stands in for what would really be a masked
        // form (e.g. "D**"); the code under test now ignores it and takes
        // the real name from the people/match reveal below instead.
        return { ok: true, json: async () => ({ people: [{ first_name: 'Jane', last_name: 'Doe', title: 'CFO', id: 'p1' }] }) }
      }
      if (url.includes('people/match')) {
        return { ok: true, json: async () => ({ person: { first_name: 'Jane', last_name: 'Doe', email: 'jane@acme.com' } }) }
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
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'Acme Ltd', primary_domain: 'acme.com' }] }) }
      if (url.includes('mixed_people/api_search')) {
        peopleSearchCalls++
        const body = JSON.parse(opts.body)
        seenTitles.push(body.person_titles)
        // Return a different person depending on which role was searched
        // for — a real Apollo call would too.
        const isFinance = body.person_titles?.includes('CFO')
        return { ok: true, json: async () => ({ people: [isFinance ? { first_name: 'Jane', last_name: 'Doe', title: 'CFO', id: 'p1' } : { first_name: 'Sam', last_name: 'Lee', title: 'Head of Engineering', id: 'p2' }] }) }
      }
      if (url.includes('people/match')) {
        // Reveal is per-person (keyed by id) — must return the matching
        // real identity for whichever person id was actually revealed, not
        // one fixed name for every call, or this test couldn't tell the
        // two roles' contacts apart any more than the masked-name bug did.
        const body = JSON.parse(opts.body)
        const revealed = body.id === 'p1' ? { first_name: 'Jane', last_name: 'Doe' } : { first_name: 'Sam', last_name: 'Lee' }
        return { ok: true, json: async () => ({ person: { ...revealed, email: 'x@acme.com' } }) }
      }
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
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'Acme Ltd', primary_domain: 'acme.com', logo_url: 'https://apollo.example/acme-logo.png' }] }) }
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
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'Acme Ltd', primary_domain: 'acme.com' }] }) }
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

  // 4th-pass audit fix: a failed Apollo companies/search call used to
  // permanently cost the credit reserved for it. Confirms the release RPC
  // now fires for both a non-ok response and a thrown network error.
  it('releases the reserved credit when the Apollo companies/search call returns a non-ok response', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) return { ok: false, status: 401, text: async () => 'unauthorized' }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    await enrichCompany('apollo-key', 'Acme Ltd', supabase, [], 'u1')
    expect(supabase.rpc).toHaveBeenCalledWith('apollo_release_credits', { p_credits: 1, p_user_id: 'u1' })
    vi.unstubAllGlobals()
  })

  it('releases the reserved credit when the Apollo companies/search call throws', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await enrichCompany('apollo-key', 'Acme Ltd', supabase, [], 'u1')
    expect(supabase.rpc).toHaveBeenCalledWith('apollo_release_credits', { p_credits: 1, p_user_id: 'u1' })
    vi.unstubAllGlobals()
  })

  // 2026-08-26 audit fix: a query-level cache-read failure (RLS denial, a
  // bad filter) used to fall through silently, indistinguishable in the
  // logs from an ordinary cache miss.
  it('logs a query-level cache-read failure instead of silently treating it as a cache miss', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'RLS denied' } }) }) }),
        upsert: async () => ({ data: null, error: null }),
      }),
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    }
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [] }) }
      if (url.includes('autocomplete.clearbit.com')) return { ok: true, json: async () => ([]) }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    await enrichCompany('apollo-key', 'Acme Ltd', supabase)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('company_enrichment cache lookup failed'), 'RLS denied')
    consoleSpy.mockRestore()
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

// 2026-08-25 — a real, customer-facing bug: a signal genuinely about
// "Stitch" (a small GCC fintech) got Apollo contact data for "Stitch Fix"
// (an unrelated, much larger US public company) because enrichCompany used
// to blindly trust Apollo's top-ranked mixed_companies/search result with
// no check that it was actually the right company. These are the
// regression tests for pickBestOrgMatch, the fix.
describe('enrichCompany — pickBestOrgMatch (the Stitch / Stitch Fix wrong-company bug)', () => {
  it('does NOT take a same-search, different-name candidate just because it was ranked first', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) {
        // Apollo's actual top result for a bare "Stitch" query in the real
        // bug — ranked first, but the wrong company entirely.
        return { ok: true, json: async () => ({ organizations: [{ id: 'org_stitchfix', name: 'Stitch Fix', primary_domain: 'stitchfix.com' }] }) }
      }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    const result = await enrichCompany('apollo-key', 'Stitch', supabase)
    expect(result.matched).toBe(false)
    expect(result.apolloOrgId).toBeNull()
    expect(result.domain).not.toBe('stitchfix.com')
    vi.unstubAllGlobals()
  })

  it('picks the exact-name match even when it is ranked below a same-search decoy', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) {
        return {
          ok: true,
          json: async () => ({
            organizations: [
              { id: 'org_stitchfix', name: 'Stitch Fix', primary_domain: 'stitchfix.com' },
              { id: 'org_stitch_real', name: 'Stitch', primary_domain: 'stitch.money' },
            ],
          }),
        }
      }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    const result = await enrichCompany('apollo-key', 'Stitch', supabase)
    expect(result.apolloOrgId).toBe('org_stitch_real')
    expect(result.domain).toBe('stitch.money')
    vi.unstubAllGlobals()
  })

  // 2026-08-26: this used to only be resolvable via the location-hint
  // fallback, since a raw string compare treats "Stitch" and "Stitch FZ
  // LLC" as different companies. It's now caught earlier and more
  // precisely, by the suffix-normalized exact match (see the next
  // describe block) — "FZ LLC" is stripped as a legal suffix, so this
  // *is* an exact match once normalized, not just a location-based guess.
  // Kept as its own test since the assertion (right company wins) still
  // matters, even though it's no longer exercising the location-hint path
  // specifically.
  it('resolves the real GCC entity over a same-search decoy, suffix and all', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) {
        return {
          ok: true,
          json: async () => ({
            organizations: [
              { id: 'org_us', name: 'Stitch Fix', primary_domain: 'stitchfix.com', country: 'United States' },
              { id: 'org_ae', name: 'Stitch FZ LLC', primary_domain: 'stitch.money', country: 'United Arab Emirates' },
            ],
          }),
        }
      }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    const result = await enrichCompany('apollo-key', 'Stitch', supabase, ['United Arab Emirates'])
    expect(result.apolloOrgId).toBe('org_ae')
    vi.unstubAllGlobals()
  })

  // A genuine location-only fallback case: two candidates whose names are
  // BOTH unrelated to the target once suffixes are stripped (no exact
  // match, normalized or otherwise) — only the country hint can decide it.
  it('still falls back to a pure location-hint match when even the normalized names disagree', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) {
        return {
          ok: true,
          json: async () => ({
            organizations: [
              // Neither candidate's name reduces to bare "acme" even after
              // legal-suffix stripping ("International"/"Gulf" aren't
              // suffixes) — genuinely ambiguous without the location hint.
              { id: 'org_us', name: 'Acme International Trading', primary_domain: 'acmeintl.com', country: 'United States' },
              { id: 'org_ae', name: 'Acme Gulf Trading', primary_domain: 'acmegulf.ae', country: 'United Arab Emirates' },
            ],
          }),
        }
      }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    const result = await enrichCompany('apollo-key', 'Acme', supabase, ['United Arab Emirates'])
    expect(result.apolloOrgId).toBe('org_ae')
    vi.unstubAllGlobals()
  })

  it('picks a GCC-suffixed candidate over an unsuffixed decoy purely via suffix-normalized exact match, no location hint needed', async () => {
    const supabase = makeTableAwareSupabase()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('mixed_companies/search')) {
        return {
          ok: true,
          json: async () => ({
            organizations: [
              { id: 'org_decoy', name: 'Acme Global Ventures', primary_domain: 'acmeglobal.com' },
              { id: 'org_real', name: 'Acme Trading FZE', primary_domain: 'acmetrading.ae' },
            ],
          }),
        }
      }
      throw new Error(`unexpected fetch in this test: ${url}`)
    }))
    const result = await enrichCompany('apollo-key', 'Acme Trading', supabase)
    expect(result.apolloOrgId).toBe('org_real')
    expect(result.domain).toBe('acmetrading.ae')
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
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'Acme Ltd', primary_domain: 'acme.com' }] }) }
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
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'DEWA', primary_domain: 'dewa.gov.ae' }] }) }
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
      if (url.includes('people/match')) {
        const body = JSON.parse(opts.body)
        const revealed = body.id === 'p1' ? { first_name: 'Priya', last_name: 'Nair' } : { first_name: 'Sam', last_name: 'Lee' }
        return { ok: true, json: async () => ({ person: { ...revealed, email: 'x@acme.com' } }) }
      }
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
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { first_name: 'Priya', last_name: 'Nair', email: 'x@acme.com' } }) }
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
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'Acme Ltd', primary_domain: 'acme.com' }] }) }
      if (url.includes('mixed_people/api_search')) {
        const body = JSON.parse(opts.body)
        if (body.person_titles?.includes('Head of Product')) return { ok: true, json: async () => ({ people: [{ first_name: 'Priya', last_name: 'Nair', title: 'Head of Product', id: 'p1' }] }) }
        return { ok: true, json: async () => ({ people: [] }) }
      }
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { first_name: 'Priya', last_name: 'Nair', email: 'x@acme.com' } }) }
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
      if (url.includes('mixed_companies/search')) return { ok: true, json: async () => ({ organizations: [{ id: 'org_1', name: 'Acme Ltd', primary_domain: 'acme.com' }] }) }
      if (url.includes('mixed_people/api_search')) {
        const body = JSON.parse(opts.body)
        // The specific role's own title search comes back empty...
        if (body.person_titles?.includes('Finance Manager')) return { ok: true, json: async () => ({ people: [] }) }
        // ...but the commercial bucket resolves someone.
        if (body.person_titles?.includes('Commercial Director')) return { ok: true, json: async () => ({ people: [{ first_name: 'Omar', last_name: 'Khalil', title: 'Commercial Director', id: 'p2' }] }) }
        return { ok: true, json: async () => ({ people: [] }) }
      }
      if (url.includes('people/match')) return { ok: true, json: async () => ({ person: { first_name: 'Omar', last_name: 'Khalil', email: 'x@acme.com' } }) }
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

describe('createTimeoutFetch (2026-08-24 scan-now-background.js stall fix)', () => {
  // The actual regression: supabase-js gives its own internal fetch no
  // timeout at all, so a client built without this would hang on a stuck
  // connection forever — this pins that the wrapped fetch instead rejects
  // once its timeout elapses, the same guarantee fetchWithTimeout already
  // gives every direct external API call in this file.
  it('rejects a request that never resolves, once the timeout elapses', async () => {
    vi.stubGlobal('fetch', vi.fn((url, opts) => new Promise((resolve, reject) => {
      // A real hung connection: nothing ever calls resolve/reject on its
      // own — the only way this promise ever settles is via the abort
      // signal the wrapped fetch attaches, exactly like a real stuck
      // Postgres/PostgREST connection would only end via that same signal.
      opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const timeoutFetch = createTimeoutFetch(20)
    await expect(timeoutFetch('https://example.supabase.co/rest/v1/x')).rejects.toThrow()
    vi.unstubAllGlobals()
  })

  it('resolves normally for a request that completes well within the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }))
    const timeoutFetch = createTimeoutFetch(20000)
    const resp = await timeoutFetch('https://example.supabase.co/rest/v1/x')
    expect(resp.ok).toBe(true)
    vi.unstubAllGlobals()
  })
})

describe('getLearnedSources — error handling (2026-08-26 audit fix)', () => {
  // The error was already checked (correctly falls back to `empty` instead
  // of mistaking a query-level failure for "no learned sources yet"), but
  // never logged — silently indistinguishable in Netlify's own logs from
  // the genuinely-empty case. This pins that it's now logged too.
  it('logs a query-level read failure instead of silently swallowing it', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = {
      from: () => ({
        select: () => ({
          in: () => ({
            in: () => ({
              order: () => ({
                limit: async () => ({ data: null, error: { message: 'db down' } }),
              }),
            }),
          }),
        }),
      }),
    }
    const result = await getLearnedSources(supabase, ['Legal'], ['United Kingdom'])
    expect(result).toEqual({ companies: {}, sources: {} })
    expect(consoleSpy).toHaveBeenCalledWith('[scanShared] failed to read annie_learned_sources', 'db down')
    consoleSpy.mockRestore()
  })

  it('returns an empty result without querying anything when there are no sectors', async () => {
    const fromSpy = vi.fn()
    const result = await getLearnedSources({ from: fromSpy }, [], ['United Kingdom'])
    expect(result).toEqual({ companies: {}, sources: {} })
    expect(fromSpy).not.toHaveBeenCalled()
  })
})

// 2026-08-27 fix, Michael: "I think we need to up that cap... are you happy
// how Annie applies these learnings, or do you see any gaps?" — this was a
// real bug, not just a size question: ordering by first_seen_at ascending
// meant the OLDEST-ever-discovered entries permanently occupied every slot
// once a sector's list filled up, so brand new discoveries (the actual
// "getting smarter over time" this table exists for) could never surface
// again. Fixed to order by last_confirmed_at descending instead.
describe('getLearnedSources — recency ordering (2026-08-27 fix)', () => {
  it('queries ordered by last_confirmed_at descending, not first_seen_at, so freshest-confirmed entries win the available per-sector slots', async () => {
    const orderSpy = vi.fn(() => ({ limit: async () => ({ data: [], error: null }) }))
    const supabase = { from: () => ({ select: () => ({ in: () => ({ in: () => ({ order: orderSpy }) }) }) }) }
    await getLearnedSources(supabase, ['Technology'], ['United Kingdom'])
    expect(orderSpy).toHaveBeenCalledWith('last_confirmed_at', { ascending: false })
  })

  it('keeps the freshest-confirmed companies for a sector once it hits the per-sector cap, dropping the stalest rather than the newest', async () => {
    // Query already returns rows in last_confirmed_at-descending order (as
    // the real Supabase query now does) — freshest first. With a cap of 300
    // and only 2 rows here, both are kept regardless; this pins that the
    // bucket fill respects whatever order the query hands it rather than
    // re-sorting on its own.
    const rows = [
      { kind: 'company', sector: 'Technology', value: 'Newest Co' },
      { kind: 'company', sector: 'Technology', value: 'Older Co' },
    ]
    const supabase = { from: () => ({ select: () => ({ in: () => ({ in: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) }) }) }
    const result = await getLearnedSources(supabase, ['Technology'], ['United Kingdom'])
    expect(result.companies.Technology).toEqual(['Newest Co', 'Older Co'])
  })
})

describe('recordLearnedDiscoveries — last_confirmed_at refresh (2026-08-27 fix)', () => {
  // The bug: ignoreDuplicates: true (ON CONFLICT DO NOTHING) meant a repeat
  // discovery of the same company never refreshed last_confirmed_at, so it
  // stayed frozen at its very first insert forever — starving
  // getLearnedSources' new recency ordering of any real signal for the bulk
  // of what's in this table (Annie's own AI-discovered rows, as opposed to
  // customer-CRM-added ones, which the separate SQL trigger already handled
  // correctly).
  it('upserts WITHOUT ignoreDuplicates, so a repeat discovery updates the existing row instead of being silently ignored', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert: upsertSpy }) }
    await recordLearnedDiscoveries(supabase, [{ kind: 'company', sector: 'Technology', value: 'Acme Corp', foundVia: 'techcrunch.com' }])
    expect(upsertSpy).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: 'company', sector: 'Technology', value: 'Acme Corp' })],
      { onConflict: 'kind,sector,location,value_key' },
    )
    // No ignoreDuplicates key at all — its presence (even true) would put
    // this straight back into the ON CONFLICT DO NOTHING bug.
    expect(upsertSpy.mock.calls[0][1]).not.toHaveProperty('ignoreDuplicates')
  })

  it('stamps last_confirmed_at fresh on every write, but never touches first_seen_at, so a repeat discovery reads as "still active" without losing when it was first found', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert: upsertSpy }) }
    await recordLearnedDiscoveries(supabase, [{ kind: 'company', sector: 'Technology', value: 'Acme Corp' }])
    const row = upsertSpy.mock.calls[0][0][0]
    expect(row.last_confirmed_at).toBeTruthy()
    expect(new Date(row.last_confirmed_at).toString()).not.toBe('Invalid Date')
    expect(row).not.toHaveProperty('first_seen_at')
  })
})

// 2026-09-01 bug fix (Michael): recordLearnedDiscoveries used to write
// location: e.location || 'Global' for EVERY row, because buildScanPrompt's
// annie_learned schema never actually asked the AI for a location — the
// fallback fired every single time, so the per-market half of "Annie
// learns by sector and market" was completely inert (a GCC recruiter and a
// UK recruiter drew on an identical learned set). Fixed by having the
// prompt ask for a location and having this write path keep it when it's a
// real, recognized one.
describe('normalizeLearnedLocation (2026-09-01 fix)', () => {
  it('passes through a recognized region exactly as given', () => {
    expect(normalizeLearnedLocation('UAE / GCC')).toBe('UAE / GCC')
    expect(normalizeLearnedLocation('United Kingdom')).toBe('United Kingdom')
  })

  it('is case- and whitespace-insensitive but still normalizes to the canonical spelling', () => {
    expect(normalizeLearnedLocation('  united kingdom  ')).toBe('United Kingdom')
    expect(normalizeLearnedLocation('uae / gcc')).toBe('UAE / GCC')
  })

  it('passes through "Global" regardless of case', () => {
    expect(normalizeLearnedLocation('global')).toBe('Global')
    expect(normalizeLearnedLocation('Global')).toBe('Global')
  })

  it('falls back to Global for a missing location, so a row is never left with no location at all', () => {
    expect(normalizeLearnedLocation(undefined)).toBe('Global')
    expect(normalizeLearnedLocation('')).toBe('Global')
  })

  it('falls back to Global for an unrecognized value, rather than writing a stray string getLearnedSources can never match', () => {
    expect(normalizeLearnedLocation('Dubai')).toBe('Global')
    expect(normalizeLearnedLocation('UK')).toBe('Global')
    expect(normalizeLearnedLocation('somewhere the AI made up')).toBe('Global')
  })
})

describe('recordLearnedDiscoveries — region-aware writes (2026-09-01 fix)', () => {
  it('writes the AI-supplied location when it is a real, recognized region, instead of collapsing everything to Global', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert: upsertSpy }) }
    await recordLearnedDiscoveries(supabase, [
      { kind: 'company', sector: 'Management Consulting', value: 'Some GCC Boutique', foundVia: 'consultancy-me.com', location: 'UAE / GCC' },
    ])
    const row = upsertSpy.mock.calls[0][0][0]
    expect(row.location).toBe('UAE / GCC')
  })

  it('still falls back to Global when the entry genuinely has no location (old behavior preserved as the safety net, not the common case)', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert: upsertSpy }) }
    await recordLearnedDiscoveries(supabase, [{ kind: 'company', sector: 'Technology', value: 'Acme Corp' }])
    const row = upsertSpy.mock.calls[0][0][0]
    expect(row.location).toBe('Global')
  })
})

describe('isJunkLearnedSourceValue / recordLearnedDiscoveries — junk-value guard (2026-08-27 asymmetry fix)', () => {
  // The gap: learn_company_for_sectors (the SQL customer-CRM write path)
  // got a junk-value/min-length guard the same day, but this JS write path
  // — Annie's own AI-discovered companies/sources — didn't, even though it
  // feeds the exact same shared table. Mirrors the SQL denylist exactly so
  // a value is judged the same way regardless of which path wrote it.
  it('rejects normalized keys shorter than 2 characters', () => {
    expect(isJunkLearnedSourceValue('x')).toBe(true)
    expect(isJunkLearnedSourceValue('')).toBe(true)
    expect(isJunkLearnedSourceValue(null)).toBe(true)
  })

  it('rejects known placeholder/junk values, but still allows real short/initialism company names', () => {
    expect(isJunkLearnedSourceValue('na')).toBe(true)
    expect(isJunkLearnedSourceValue('test')).toBe(true)
    expect(isJunkLearnedSourceValue('tbc')).toBe(true)
    expect(isJunkLearnedSourceValue('company')).toBe(true)
    // Real short/initialism names normalize to 2+ chars and aren't on the
    // denylist, so they pass — same behaviour as the SQL guard.
    expect(isJunkLearnedSourceValue('ey')).toBe(false)
    expect(isJunkLearnedSourceValue('bp')).toBe(false)
    expect(isJunkLearnedSourceValue('3m')).toBe(false)
  })

  it('recordLearnedDiscoveries silently drops junk-value entries instead of upserting them', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert: upsertSpy }) }
    await recordLearnedDiscoveries(supabase, [
      { kind: 'company', sector: 'Technology', value: 'Test', foundVia: 'scan' },
      { kind: 'company', sector: 'Technology', value: 'N/A', foundVia: 'scan' },
    ])
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('recordLearnedDiscoveries keeps legitimate entries in a mixed batch, dropping only the junk one', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert: upsertSpy }) }
    await recordLearnedDiscoveries(supabase, [
      { kind: 'company', sector: 'Technology', value: 'Acme Corp', foundVia: 'scan' },
      { kind: 'company', sector: 'Technology', value: 'TBC', foundVia: 'scan' },
    ])
    const rows = upsertSpy.mock.calls[0][0]
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toBe('Acme Corp')
  })
})

describe('writeToSignalPool (cross-customer signal pool write-through)', () => {
  it('upserts a pool row per entry, tagged with the discovering customer\'s own sector/location/function selections', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: vi.fn(() => ({ upsert: upsertSpy })) }
    const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: ['Engineering'] }
    await writeToSignalPool(supabase, [{
      company: 'Acme Corp', headline: 'Raises $50M Series B', signalType: 'funding',
      whyItMatters: 'Likely hiring', sourceUrl: 'https://example.com/a', sourceLabel: 'example.com',
      eventDate: '2026-08-20', whoToApproach: 'Head of Talent', titleKeywords: ['VP Engineering'],
      candidateAngle: 'A strong engineering leader', benchStrengthAngle: 'Peer companies X, Y',
      candidateProfile: { yearsMin: 5, yearsMax: 10 }, likelyRoles: ['VP Engineering', 'Head of Product'],
    }], ob)
    expect(supabase.from).toHaveBeenCalledWith('signal_pool')
    expect(upsertSpy).toHaveBeenCalledWith(
      [expect.objectContaining({
        company: 'Acme Corp',
        headline: 'Raises $50M Series B',
        entry_type: 'signal',
        signal_type: 'funding',
        sectors_hint: ['Technology'],
        locations_hint: ['United Kingdom'],
        functions_hint: ['Engineering'],
      })],
      { onConflict: 'dedup_key', ignoreDuplicates: true },
    )
  })

  it('never introduces intro_message — that field never exists on a pool row', async () => {
    const upsertSpy = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: vi.fn(() => ({ upsert: upsertSpy })) }
    await writeToSignalPool(supabase, [{ company: 'Acme', headline: 'Appoints new CFO', introMessage: 'Dear Sir or Madam...' }], { sectors: [], locations: [], functions: [] })
    const [rows] = upsertSpy.mock.calls[0]
    expect(rows[0].intro_message).toBeUndefined()
  })

  it('does nothing when there are no entries or no supabase client', async () => {
    const fromSpy = vi.fn()
    await writeToSignalPool({ from: fromSpy }, [], {})
    await writeToSignalPool(null, [{ company: 'Acme', headline: 'x' }], {})
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('logs, rather than throws, on a query-level write failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = { from: vi.fn(() => ({ upsert: vi.fn().mockResolvedValue({ error: { message: 'db down' } }) })) }
    await expect(writeToSignalPool(supabase, [{ company: 'Acme', headline: 'x' }], {})).resolves.not.toThrow()
    expect(consoleSpy).toHaveBeenCalledWith('[scanShared] signal_pool write-through failed:', 'db down')
    consoleSpy.mockRestore()
  })
})

describe('fetchSignalPoolMatches (matching a pool entry back to a different, overlapping customer)', () => {
  function makePoolSupabase(rows) {
    return {
      from: () => ({
        select: () => ({
          gte: () => ({
            order: () => ({
              limit: async () => ({ data: rows, error: null }),
            }),
          }),
        }),
      }),
    }
  }

  it('matches a signal entry on sector + location overlap alone (no function required)', async () => {
    const supabase = makePoolSupabase([
      { dedup_key: 'a', entry_type: 'signal', sectors_hint: ['Technology'], locations_hint: ['United Kingdom'], functions_hint: [] },
    ])
    const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: ['Sales'] }
    const result = await fetchSignalPoolMatches(supabase, ob, new Set(), 5)
    expect(result).toHaveLength(1)
  })

  it('excludes a live_job entry with no function overlap even when sector and location match', async () => {
    const supabase = makePoolSupabase([
      { dedup_key: 'a', entry_type: 'live_job', sectors_hint: ['Technology'], locations_hint: ['United Kingdom'], functions_hint: ['Legal'] },
    ])
    const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: ['Engineering'] }
    const result = await fetchSignalPoolMatches(supabase, ob, new Set(), 5)
    expect(result).toEqual([])
  })

  it('includes a live_job entry when function does overlap', async () => {
    const supabase = makePoolSupabase([
      { dedup_key: 'a', entry_type: 'live_job', sectors_hint: ['Technology'], locations_hint: ['United Kingdom'], functions_hint: ['Engineering'] },
    ])
    const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: ['Engineering'] }
    const result = await fetchSignalPoolMatches(supabase, ob, new Set(), 5)
    expect(result).toHaveLength(1)
  })

  it('excludes an entry with no sector overlap', async () => {
    const supabase = makePoolSupabase([
      { dedup_key: 'a', entry_type: 'signal', sectors_hint: ['Law'], locations_hint: ['United Kingdom'], functions_hint: [] },
    ])
    const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: [] }
    expect(await fetchSignalPoolMatches(supabase, ob, new Set(), 5)).toEqual([])
  })

  it('excludes an entry with no location overlap', async () => {
    const supabase = makePoolSupabase([
      { dedup_key: 'a', entry_type: 'signal', sectors_hint: ['Technology'], locations_hint: ['United States'], functions_hint: [] },
    ])
    const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: [] }
    expect(await fetchSignalPoolMatches(supabase, ob, new Set(), 5)).toEqual([])
  })

  it('excludes a dedup_key this customer already has, even if the profile overlaps', async () => {
    const supabase = makePoolSupabase([
      { dedup_key: 'already-have-this', entry_type: 'signal', sectors_hint: ['Technology'], locations_hint: ['United Kingdom'], functions_hint: [] },
    ])
    const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: [] }
    const result = await fetchSignalPoolMatches(supabase, ob, new Set(['already-have-this']), 5)
    expect(result).toEqual([])
  })

  it('never returns more than the requested limit', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ dedup_key: `k${i}`, entry_type: 'signal', sectors_hint: ['Technology'], locations_hint: ['United Kingdom'], functions_hint: [] }))
    const supabase = makePoolSupabase(rows)
    const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: [] }
    const result = await fetchSignalPoolMatches(supabase, ob, new Set(), 2)
    expect(result).toHaveLength(2)
  })

  it('returns nothing without a supabase client or a zero limit, never querying anything', async () => {
    expect(await fetchSignalPoolMatches(null, {}, new Set(), 5)).toEqual([])
    const fromSpy = vi.fn()
    expect(await fetchSignalPoolMatches({ from: fromSpy }, {}, new Set(), 0)).toEqual([])
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('logs, rather than throws, on a query-level read failure, and returns no matches', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = {
      from: () => ({ select: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'db down' } }) }) }) }) }),
    }
    const result = await fetchSignalPoolMatches(supabase, { sectors: ['Technology'], locations: ['United Kingdom'] }, new Set(), 5)
    expect(result).toEqual([])
    expect(consoleSpy).toHaveBeenCalledWith('[scanShared] signal_pool read failed:', 'db down')
    consoleSpy.mockRestore()
  })

  describe('quality feedback (dismiss_count/positive_count, populated by the signal_outcomes trigger)', () => {
    it('excludes an entry 3+ independent customers have dismissed with zero positive outcomes', async () => {
      const supabase = makePoolSupabase([
        { dedup_key: 'a', entry_type: 'signal', sectors_hint: ['Technology'], locations_hint: ['United Kingdom'], functions_hint: [], dismiss_count: 3, positive_count: 0 },
      ])
      const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: [] }
      expect(await fetchSignalPoolMatches(supabase, ob, new Set(), 5)).toEqual([])
    })

    it('still includes an entry with 3+ dismissals if it has at least one positive outcome too', async () => {
      const supabase = makePoolSupabase([
        { dedup_key: 'a', entry_type: 'signal', sectors_hint: ['Technology'], locations_hint: ['United Kingdom'], functions_hint: [], dismiss_count: 5, positive_count: 1 },
      ])
      const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: [] }
      expect(await fetchSignalPoolMatches(supabase, ob, new Set(), 5)).toHaveLength(1)
    })

    it('includes an entry with fewer than the dismiss threshold even with zero positive outcomes', async () => {
      const supabase = makePoolSupabase([
        { dedup_key: 'a', entry_type: 'signal', sectors_hint: ['Technology'], locations_hint: ['United Kingdom'], functions_hint: [], dismiss_count: 2, positive_count: 0 },
      ])
      const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: [] }
      expect(await fetchSignalPoolMatches(supabase, ob, new Set(), 5)).toHaveLength(1)
    })

    it('includes an entry with no dismiss/positive counts on it at all (a pre-feedback-migration or brand new row)', async () => {
      const supabase = makePoolSupabase([
        { dedup_key: 'a', entry_type: 'signal', sectors_hint: ['Technology'], locations_hint: ['United Kingdom'], functions_hint: [] },
      ])
      const ob = { sectors: ['Technology'], locations: ['United Kingdom'], functions: [] }
      expect(await fetchSignalPoolMatches(supabase, ob, new Set(), 5)).toHaveLength(1)
    })
  })
})

describe('personalizePoolHits (cheap, no-web-search re-voicing of an already-discovered pool fact)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns nothing without an API key or without any pool hits, never calling fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await personalizePoolHits('', [{ company: 'Acme', headline: 'x' }], {})).toEqual([])
    expect(await personalizePoolHits('sk-ant-key', [], {})).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps the AI\'s personalized text back onto each pool hit by index, preserving the pool\'s own facts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify([
          { index: 0, whyItMatters: 'Rewritten for this recruiter', introMessage: 'Paragraph one.\n\nParagraph two.\n\nParagraph three.', candidateAngle: 'Rewritten angle', benchStrengthAngle: 'Peer firms A, B', whoToApproach: 'Head of Talent' },
        ]) }],
      }),
    }))
    const poolHits = [{
      entry_type: 'signal', signal_type: 'funding', company: 'Acme Corp', headline: 'Raises $50M',
      why_it_matters: 'original fact', source_url: 'https://x.com/a', source_label: 'x.com',
      event_at: '2026-08-20T00:00:00.000Z', who_to_approach: 'CFO', appointed_name: null,
      title_keywords: ['VP Finance'], candidate_angle: 'original angle', bench_strength_angle: 'original bench',
      candidate_profile: { yearsMin: 5 }, likely_roles: ['VP Finance'],
    }]
    const result = await personalizePoolHits('sk-ant-key', poolHits, { firm_name: 'Acme Search', tone: 'friendly' })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      company: 'Acme Corp',
      headline: 'Raises $50M',
      whyItMatters: 'Rewritten for this recruiter',
      introMessage: 'Paragraph one.\n\nParagraph two.\n\nParagraph three.',
      candidateAngle: 'Rewritten angle',
      benchStrengthAngle: 'Peer firms A, B',
      whoToApproach: 'Head of Talent',
      titleKeywords: ['VP Finance'],
      likelyRoles: ['VP Finance'],
    })
  })

  it('falls back to the pool\'s own facts (not the empty string) for any field the AI left out, and leaves introMessage blank rather than guessing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '[]' }] }),
    }))
    const poolHits = [{ entry_type: 'signal', company: 'Acme', headline: 'x', why_it_matters: 'kept fact', candidate_angle: 'kept angle', bench_strength_angle: 'kept bench', who_to_approach: 'kept contact' }]
    const result = await personalizePoolHits('sk-ant-key', poolHits, {})
    expect(result[0].whyItMatters).toBe('kept fact')
    expect(result[0].candidateAngle).toBe('kept angle')
    expect(result[0].benchStrengthAngle).toBe('kept bench')
    expect(result[0].whoToApproach).toBe('kept contact')
    expect(result[0].introMessage).toBe('')
  })

  it('returns an empty array (falls back to fresh discovery) rather than throwing when the call fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }))
    const result = await personalizePoolHits('sk-ant-key', [{ company: 'Acme', headline: 'x' }], {})
    expect(result).toEqual([])
    consoleSpy.mockRestore()
  })

  it('returns an empty array when fetch itself throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const result = await personalizePoolHits('sk-ant-key', [{ company: 'Acme', headline: 'x' }], {})
    expect(result).toEqual([])
    consoleSpy.mockRestore()
  })
})

describe('logMarketCoverage (one row per scan attempt, found-something or not)', () => {
  it('inserts a row with the scan\'s own sectors/locations/functions and found count', async () => {
    const insertSpy = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: vi.fn(() => ({ insert: insertSpy })) }
    const ob = { user_id: 'user_1', sectors: ['Technology'], locations: ['United Kingdom'], functions: ['Engineering'] }
    await logMarketCoverage(supabase, ob, 3)
    expect(supabase.from).toHaveBeenCalledWith('market_coverage_log')
    expect(insertSpy).toHaveBeenCalledWith({
      user_id: 'user_1', sectors: ['Technology'], locations: ['United Kingdom'], functions: ['Engineering'], found_count: 3,
    })
  })

  it('does nothing without a supabase client', async () => {
    await expect(logMarketCoverage(null, {}, 0)).resolves.not.toThrow()
  })

  it('logs, rather than throws, on a write failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = { from: () => ({ insert: vi.fn().mockResolvedValue({ error: { message: 'db down' } }) }) }
    await expect(logMarketCoverage(supabase, {}, 0)).resolves.not.toThrow()
    expect(consoleSpy).toHaveBeenCalledWith('[scanShared] market_coverage_log write failed:', 'db down')
    consoleSpy.mockRestore()
  })
})

describe('getMarketCoverageReport (aggregating scan history into a per sector+location coverage picture)', () => {
  // Two tables are read now: market_coverage_log (scan attempts) and, new
  // as of the 2026-08-27 "annie_under_informed vs genuinely_quiet" fix,
  // annie_learned_sources (how much Annie already knows per sector). Routed
  // by table name so each test can control both independently; learnedRows
  // defaults to none, which the tests below rely on to check the
  // "under-informed" default cleanly.
  function makeCoverageSupabase(rows, learnedRows = []) {
    return {
      from: (table) => {
        if (table === 'annie_learned_sources') {
          return { select: () => ({ in: () => ({ limit: async () => ({ data: learnedRows, error: null }) }) }) }
        }
        return { select: () => ({ gte: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }
      },
    }
  }

  it('flags a sector+location pair as thin only once it has enough distinct customers, enough scans, and zero signals found', async () => {
    const rows = [
      { user_id: 'u1', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
      { user_id: 'u2', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
      { user_id: 'u3', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
      { user_id: 'u3', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
      { user_id: 'u3', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
    ]
    const result = await getMarketCoverageReport(makeCoverageSupabase(rows), { minScans: 5, minCustomers: 3 })
    expect(result).toEqual([{
      sector: 'Law', location: 'UAE / GCC', scans: 5, distinctCustomers: 3, totalFound: 0, thin: true,
      knownCompanies: 0, knownSources: 0, likelyCause: 'annie_under_informed',
    }])
  })

  it('does not flag a pair as thin if it has real signals, even with plenty of scan history', async () => {
    const rows = [
      { user_id: 'u1', sectors: ['Technology'], locations: ['United Kingdom'], found_count: 2 },
      { user_id: 'u2', sectors: ['Technology'], locations: ['United Kingdom'], found_count: 0 },
      { user_id: 'u3', sectors: ['Technology'], locations: ['United Kingdom'], found_count: 1 },
    ]
    const result = await getMarketCoverageReport(makeCoverageSupabase(rows), { minScans: 3, minCustomers: 3 })
    expect(result[0]).toMatchObject({ thin: false, totalFound: 3, likelyCause: null })
  })

  it('does not flag a pair as thin without enough distinct customers, even with many scans from the same one', async () => {
    const rows = Array.from({ length: 10 }, () => ({ user_id: 'u1', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 }))
    const result = await getMarketCoverageReport(makeCoverageSupabase(rows), { minScans: 5, minCustomers: 3 })
    expect(result[0]).toMatchObject({ thin: false, distinctCustomers: 1, likelyCause: null })
  })

  it('attributes one scan row to every sector x location pair it spans', async () => {
    const rows = [{ user_id: 'u1', sectors: ['Law', 'Technology'], locations: ['UAE / GCC', 'United Kingdom'], found_count: 1 }]
    const result = await getMarketCoverageReport(makeCoverageSupabase(rows))
    const pairs = result.map(r => `${r.sector}|${r.location}`).sort()
    expect(pairs).toEqual(['Law|UAE / GCC', 'Law|United Kingdom', 'Technology|UAE / GCC', 'Technology|United Kingdom'].sort())
  })

  it('returns an empty array without a supabase client, and logs rather than throws on a read failure', async () => {
    expect(await getMarketCoverageReport(null)).toEqual([])
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = { from: () => ({ select: () => ({ gte: () => ({ limit: async () => ({ data: null, error: { message: 'db down' } }) }) }) }) }
    const result = await getMarketCoverageReport(supabase)
    expect(result).toEqual([])
    expect(consoleSpy).toHaveBeenCalledWith('[scanShared] market_coverage_log read failed:', 'db down')
    consoleSpy.mockRestore()
  })

  it('labels a thin pair "genuinely_quiet" once Annie already knows enough companies/sources for that sector', async () => {
    const rows = [
      { user_id: 'u1', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
      { user_id: 'u2', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
      { user_id: 'u3', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
    ]
    const learnedRows = Array.from({ length: 4 }, () => ({ sector: 'Law', kind: 'company' }))
      .concat(Array.from({ length: 4 }, () => ({ sector: 'Law', kind: 'source' })))
    const result = await getMarketCoverageReport(makeCoverageSupabase(rows, learnedRows), { minScans: 3, minCustomers: 3 })
    expect(result[0]).toMatchObject({ thin: true, knownCompanies: 4, knownSources: 4, likelyCause: 'genuinely_quiet' })
  })

  it('labels a thin pair "annie_under_informed" when few or no companies/sources are known for that sector', async () => {
    const rows = [
      { user_id: 'u1', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
      { user_id: 'u2', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
      { user_id: 'u3', sectors: ['Law'], locations: ['UAE / GCC'], found_count: 0 },
    ]
    const learnedRows = [{ sector: 'Law', kind: 'company' }, { sector: 'Law', kind: 'company' }]
    const result = await getMarketCoverageReport(makeCoverageSupabase(rows, learnedRows), { minScans: 3, minCustomers: 3 })
    expect(result[0]).toMatchObject({ thin: true, knownCompanies: 2, knownSources: 0, likelyCause: 'annie_under_informed' })
  })

  it('does not query annie_learned_sources at all when there is no scan history', async () => {
    const fromSpy = vi.fn((table) => ({ select: () => ({ gte: () => ({ limit: async () => ({ data: [], error: null }) }), in: () => ({ limit: async () => ({ data: [], error: null }) }) }) }))
    const result = await getMarketCoverageReport({ from: fromSpy })
    expect(result).toEqual([])
    expect(fromSpy).not.toHaveBeenCalledWith('annie_learned_sources')
  })
})

// "Annie always learning" extension #4, 2026-08-27 (Michael: "annie starts
// to analyze the companies either they are adding, or that have come from
// their CSV, start monitoring those companies and their competitors").
describe('getCustomerWatchlistCompanies (personal, per-account company watchlist fed from the CRM)', () => {
  function makeWatchlistSupabase({ teamId = null, companiesByUser = [], candidatesByUser = [], companiesByTeam = [], candidatesByTeam = [], errorTable = null } = {}) {
    return {
      from: (table) => {
        if (table === 'team_members') {
          return {
            select: () => ({
              eq: () => ({
                limit: () => ({
                  single: async () => (errorTable === 'team_members'
                    ? { data: null, error: { message: 'db down' } }
                    : { data: teamId ? { team_id: teamId } : null, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'companies' || table === 'candidates') {
          const byUser = table === 'companies' ? companiesByUser : candidatesByUser
          const byTeam = table === 'companies' ? companiesByTeam : candidatesByTeam
          return {
            select: () => ({
              eq: (col) => ({
                order: () => ({
                  limit: async () => {
                    if (errorTable === table) return { data: null, error: { message: 'db down' } }
                    return { data: col === 'team_id' ? byTeam : byUser, error: null }
                  },
                }),
              }),
            }),
          }
        }
        throw new Error(`unexpected table ${table}`)
      },
    }
  }

  it('returns an empty array without a supabase client or without a user_id', async () => {
    expect(await getCustomerWatchlistCompanies(null, { user_id: 'u1' })).toEqual([])
    expect(await getCustomerWatchlistCompanies(makeWatchlistSupabase(), {})).toEqual([])
  })

  it('collects company names from both companies added directly and candidates\' current employers', async () => {
    const supabase = makeWatchlistSupabase({
      companiesByUser: [{ name: 'Acme Corp' }],
      candidatesByUser: [{ company: 'Beta Industries' }],
    })
    const result = await getCustomerWatchlistCompanies(supabase, { user_id: 'u1' })
    expect(result.sort()).toEqual(['Acme Corp', 'Beta Industries'])
  })

  it('dedupes the same company name showing up from both a companies row and a candidate\'s employer', async () => {
    const supabase = makeWatchlistSupabase({
      companiesByUser: [{ name: 'Acme Corp' }],
      candidatesByUser: [{ company: 'Acme Corp' }],
    })
    const result = await getCustomerWatchlistCompanies(supabase, { user_id: 'u1' })
    expect(result).toEqual(['Acme Corp'])
  })

  it('also pulls in a teammate\'s companies/candidates when this user belongs to a team, on top of their own', async () => {
    const supabase = makeWatchlistSupabase({
      teamId: 'team_1',
      companiesByUser: [{ name: 'Acme Corp' }],
      companiesByTeam: [{ name: 'Teammate Co' }],
      candidatesByTeam: [{ company: 'Teammate Candidate Employer' }],
    })
    const result = await getCustomerWatchlistCompanies(supabase, { user_id: 'u1' })
    expect(result.sort()).toEqual(['Acme Corp', 'Teammate Candidate Employer', 'Teammate Co'])
  })

  it('does not query companies/candidates by team_id at all when this user has no team', async () => {
    const supabase = makeWatchlistSupabase({ companiesByUser: [{ name: 'Solo Co' }] })
    const result = await getCustomerWatchlistCompanies(supabase, { user_id: 'u1' })
    expect(result).toEqual(['Solo Co'])
  })

  it('respects the requested cap on how many company names come back', async () => {
    const supabase = makeWatchlistSupabase({
      companiesByUser: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    })
    const result = await getCustomerWatchlistCompanies(supabase, { user_id: 'u1' }, 2)
    expect(result).toHaveLength(2)
  })

  it('logs rather than throws when one of the underlying queries fails, and still returns whatever the other queries found', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = makeWatchlistSupabase({
      companiesByUser: [{ name: 'Acme Corp' }],
      errorTable: 'candidates',
    })
    const result = await getCustomerWatchlistCompanies(supabase, { user_id: 'u1' })
    expect(result).toEqual(['Acme Corp'])
    expect(consoleSpy).toHaveBeenCalledWith('[scanShared] failed to read customer watchlist companies:', 'db down')
    consoleSpy.mockRestore()
  })

  it('never throws even if the whole call blows up unexpectedly', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const supabase = { from: () => { throw new Error('kaboom') } }
    const result = await getCustomerWatchlistCompanies(supabase, { user_id: 'u1' })
    expect(result).toEqual([])
    expect(consoleSpy).toHaveBeenCalledWith('[scanShared] failed to read customer watchlist companies:', 'kaboom')
    consoleSpy.mockRestore()
  })
})

describe('buildCustomerWatchlistHint', () => {
  it('returns an empty string when there are no companies to mention', () => {
    expect(buildCustomerWatchlistHint([])).toBe('')
    expect(buildCustomerWatchlistHint(null)).toBe('')
    expect(buildCustomerWatchlistHint(undefined)).toBe('')
  })

  it('names every company and explicitly asks for their competitors to be checked too, as an addition rather than a replacement', () => {
    const hint = buildCustomerWatchlistHint(['Acme Corp', 'Beta Industries'])
    expect(hint).toContain('Acme Corp')
    expect(hint).toContain('Beta Industries')
    expect(hint).toContain('competitors')
    expect(hint).toContain('In addition to the sector/location/function-driven search above')
  })
})

describe('buildLiveJobBoardHint — UAE federal jobs board (2026-09-01)', () => {
  it('names federaljobs.gov.ae alongside the existing UAE government portals for a UAE/GCC customer', () => {
    const hint = buildLiveJobBoardHint(['UAE / GCC'], [])
    expect(hint).toContain('federaljobs.gov.ae')
    expect(hint).toContain('MOHRE Careers')
  })

  it('never mentions federaljobs.gov.ae for a customer who did not select UAE / GCC as a market', () => {
    const hint = buildLiveJobBoardHint(['United Kingdom', 'United States'], [])
    expect(hint).not.toContain('federaljobs.gov.ae')
  })
})

describe('buildTargetFirmHint (2026-09-01: Private Equity, Financial Services, location-scoped Government & Public Sector)', () => {
  it('keeps the global (non-location-keyed) shape working for Management Consulting', () => {
    const hint = buildTargetFirmHint(['Management Consulting'], null, ['United Kingdom'])
    expect(hint).toContain('Deloitte')
    expect(hint).toContain('consultancy-me.com')
  })

  it('shows UAE sovereign funds and independent PE firms, plus the DFSA/ADGM registers, only for a customer who selected UAE / GCC', () => {
    const hint = buildTargetFirmHint(['Private Equity'], null, ['UAE / GCC'])
    expect(hint).toContain('Mubadala Investment Company')
    expect(hint).toContain('Abu Dhabi Investment Authority (ADIA)')
    expect(hint).toContain('dfsa.ae/public-register/funds')
    expect(hint).toContain('adgm.com/public-registers/fsra')
  })

  it('never mentions UAE PE firms or the DFSA/ADGM registers for a customer who only selected UK/US', () => {
    const hint = buildTargetFirmHint(['Private Equity'], null, ['United Kingdom', 'United States'])
    expect(hint).not.toContain('Mubadala')
    expect(hint).not.toContain('dfsa.ae')
  })

  it('shows major UAE banks and the Central Bank register for Financial Services, only for a UAE / GCC customer', () => {
    const hint = buildTargetFirmHint(['Financial Services'], null, ['UAE / GCC'])
    expect(hint).toContain('Emirates NBD')
    expect(hint).toContain('First Abu Dhabi Bank (FAB)')
    expect(hint).toContain('centralbank.ae')
  })

  it('splits Government & Public Sector by location instead of showing every region to every customer', () => {
    const ukOnly = buildTargetFirmHint(['Government & Public Sector'], null, ['United Kingdom'])
    expect(ukOnly).toContain('Cabinet Office')
    expect(ukOnly).not.toContain('FAHR')
    expect(ukOnly).not.toContain('General Services Administration')

    const uaeOnly = buildTargetFirmHint(['Government & Public Sector'], null, ['UAE / GCC'])
    expect(uaeOnly).toContain('Federal Authority for Government Human Resources (FAHR)')
    expect(uaeOnly).not.toContain('Cabinet Office')
  })

  it('still layers in learned companies for a location-keyed sector on top of the seed anchors', () => {
    const learned = { companies: { 'Private Equity': ['Some New Fund Manager'] } }
    const hint = buildTargetFirmHint(['Private Equity'], learned, ['UAE / GCC'])
    expect(hint).toContain('Some New Fund Manager')
    expect(hint).toContain('Mubadala Investment Company')
  })

  it('returns an empty string for a sector with no matching location entry and nothing learned yet, rather than a bare or broken block', () => {
    const hint = buildTargetFirmHint(['Real Estate'], null, ['United States'])
    expect(hint).toBe('')
  })
})

describe('buildTargetFirmHint — UK/US Private Equity + Financial Services, and new sectors (2026-09-01)', () => {
  it('shows UK PE anchors and the FCA register for a UK customer', () => {
    const hint = buildTargetFirmHint(['Private Equity'], null, ['United Kingdom'])
    expect(hint).toContain('CVC Capital Partners')
    expect(hint).toContain('fca.org.uk/firms/financial-services-register')
  })

  it('shows US PE anchors and the SEC IAPD database for a US customer', () => {
    const hint = buildTargetFirmHint(['Private Equity'], null, ['United States'])
    expect(hint).toContain('Blackstone')
    expect(hint).toContain('adviserinfo.sec.gov/pubsearch')
  })

  it('shows UK banks for Financial Services, and never mixes in UAE or US banks for a UK-only customer', () => {
    const hint = buildTargetFirmHint(['Financial Services'], null, ['United Kingdom'])
    expect(hint).toContain('Barclays')
    expect(hint).not.toContain('Emirates NBD')
    expect(hint).not.toContain('JPMorgan Chase')
  })

  it('shows US banks and the SEC IAPD database for Financial Services in the US', () => {
    const hint = buildTargetFirmHint(['Financial Services'], null, ['United States'])
    expect(hint).toContain('JPMorgan Chase')
    expect(hint).toContain('adviserinfo.sec.gov/pubsearch')
  })

  it('shows UAE Real Estate developers and the RERA/DLD register, and nothing for a customer with no UAE/GCC market selected', () => {
    const uae = buildTargetFirmHint(['Real Estate'], null, ['UAE / GCC'])
    expect(uae).toContain('Emaar Properties')
    expect(uae).toContain('dubailand.gov.ae')
    const ukOnly = buildTargetFirmHint(['Real Estate'], null, ['United Kingdom'])
    expect(ukOnly).toBe('')
  })

  it('shows Industrial anchors and the ENR ranking regardless of which market the customer selected, since these are genuinely global players', () => {
    const uk = buildTargetFirmHint(['Industrial'], null, ['United Kingdom'])
    const uae = buildTargetFirmHint(['Industrial'], null, ['UAE / GCC'])
    expect(uk).toContain('Bechtel')
    expect(uk).toContain('enr.com/toplists')
    expect(uae).toContain('Bechtel')
  })

  it('shows UK Healthcare anchors and the CQC register for a UK customer, and nothing for UAE/US where no register was confirmed', () => {
    const uk = buildTargetFirmHint(['Healthcare'], null, ['United Kingdom'])
    expect(uk).toContain('Bupa')
    expect(uk).toContain('cqc.org.uk')
    const uae = buildTargetFirmHint(['Healthcare'], null, ['UAE / GCC'])
    expect(uae).toBe('')
  })

  it('shows UK Energy & Utilities anchors and the Ofgem register for a UK customer, and nothing for UAE/US', () => {
    const uk = buildTargetFirmHint(['Energy & Utilities'], null, ['United Kingdom'])
    expect(uk).toContain('Octopus Energy')
    expect(uk).toContain('ofgem.gov.uk')
    const uae = buildTargetFirmHint(['Energy & Utilities'], null, ['UAE / GCC'])
    expect(uae).toBe('')
  })

  it('explicitly instructs Annie to look past the seed anchors for emerging/rising firms, not just the well-known names, and to check their hiring', () => {
    const hint = buildTargetFirmHint(['Private Equity'], null, ['UAE / GCC'])
    expect(hint).toContain('ones to watch')
    expect(hint).toContain('rising stars')
    expect(hint.toLowerCase()).toContain('careers')
  })
})

describe('buildTargetFirmHint — Technology (2026-09-01)', () => {
  it('shows UK tech scaleups and Sifted for a UK customer, never FAANG names', () => {
    const hint = buildTargetFirmHint(['Technology'], null, ['United Kingdom'])
    expect(hint).toContain('Revolut')
    expect(hint).toContain('sifted.eu')
    expect(hint).not.toContain('Google')
    expect(hint).not.toContain('Amazon')
  })

  it('shows UAE tech unicorns and MAGNiTT for a UAE/GCC customer', () => {
    const hint = buildTargetFirmHint(['Technology'], null, ['UAE / GCC'])
    expect(hint).toContain('Careem')
    expect(hint).toContain('Tabby')
    expect(hint).toContain('magnitt.com')
  })

  it('shows US tech companies and CB Insights for a US customer, never FAANG names', () => {
    const hint = buildTargetFirmHint(['Technology'], null, ['United States'])
    expect(hint).toContain('Salesforce')
    expect(hint).toContain('cbinsights.com')
    expect(hint).not.toContain('Apple')
    expect(hint).not.toContain('Meta')
  })

  it('never mixes UK, UAE and US tech anchors together for a customer who only selected one of those markets', () => {
    const ukOnly = buildTargetFirmHint(['Technology'], null, ['United Kingdom'])
    expect(ukOnly).not.toContain('Careem')
    expect(ukOnly).not.toContain('Salesforce')
  })
})

describe('buildTargetFirmHint — Consumer & Retail (2026-09-01)', () => {
  it('shows UK retailers and Retail Week for a UK customer', () => {
    const hint = buildTargetFirmHint(['Consumer & Retail'], null, ['United Kingdom'])
    expect(hint).toContain('Tesco')
    expect(hint).toContain('retail-week.com')
  })

  it('shows UAE retail conglomerates and points at the general regional press, not a fabricated ranking site', () => {
    const hint = buildTargetFirmHint(['Consumer & Retail'], null, ['UAE / GCC'])
    expect(hint).toContain('Majid Al Futtaim')
    expect(hint).toContain('Chalhoub Group')
    expect(hint).not.toContain('retail-week.com')
    expect(hint).not.toContain('nrf.com')
  })

  it('shows US retailers, NRF Top 100, and the Hot 25 "ones to watch" list for a US customer', () => {
    const hint = buildTargetFirmHint(['Consumer & Retail'], null, ['United States'])
    expect(hint).toContain('Walmart')
    expect(hint).toContain('nrf.com')
    expect(hint).toContain('Hot 25')
  })

  it('never mixes UK, UAE and US retail anchors together for a customer who only selected one of those markets', () => {
    const usOnly = buildTargetFirmHint(['Consumer & Retail'], null, ['United States'])
    expect(usOnly).not.toContain('Tesco')
    expect(usOnly).not.toContain('Majid Al Futtaim')
  })
})

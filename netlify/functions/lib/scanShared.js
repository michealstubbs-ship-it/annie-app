// Shared logic for the two scan entry points (scan-now-background.js, the
// one-time onboarding scan, and intelligence-scan.js, the recurring cron).
// This used to be copy-pasted independently into both files — harmless
// while the codebase was young, but it had already started to drift (the
// same 5-day lookback constant had two different names in the two files)
// and every fix made to one copy silently didn't apply to the other. Only
// the genuinely different orchestration logic (parallel sector groups vs a
// single call, the broaden-pass safety net, model/budget choices) stays
// separate in each file — everything here is identical between them by
// definition, so it only exists once.
//
// Also the reason this logic is unit-testable at all: pulling it out of an
// unexported closure inside a Netlify function and into a real module means
// scanShared.test.js can import it directly, no live API calls, no Netlify
// runtime required.
import { normalizeCompanyName } from '../../../src/lib/companyMatch.js'
import { extractJson } from '../../../src/lib/jsonExtract.js'
import { SIGNAL_TYPES } from '../../../src/lib/signalTypes.js'
import { stripAiArtifacts, sanitizeStringList } from '../../../src/lib/textSanitize.js'
import { reportServerError } from './reportError.js'

// Re-exported so every existing backend caller (scan-now-background.js,
// intelligence-scan.js) keeps importing these from here unchanged — both
// now live in src/lib because they're genuinely shared with the frontend
// too, not backend-only. See jsonExtract.js, signalTypes.js and
// textSanitize.js for why.
export { extractJson, SIGNAL_TYPES, stripAiArtifacts }

// How far back Apollo/Adzuna discovery counts as "actively happening right
// now", and how the AI prompts describe their own main search window. One
// name, one value, used by both scan files.
export const SIGNAL_LOOKBACK_DAYS = 5

// How far back a Companies House filing can be and still count as
// confirming a leadership_change signal. Wider than SIGNAL_LOOKBACK_DAYS on
// purpose: real appointments/resignations are often filed weeks after the
// actual event, filings lag reality.
export const LEADERSHIP_VERIFY_WINDOW_DAYS = 45

// How far in the past an eventDate can be and still be trusted, wider than
// even the broaden pass's 4-week window so a genuinely real, slightly older
// signal isn't discarded, while a wildly stale or fabricated date is.
const MAX_EVENT_AGE_DAYS = 60

export function isoDateDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// Plain fetch() has no default timeout. Previously a hung Apollo/Companies
// House/Adzuna call could sit forever, and in the background function
// (15-minute wall-clock budget) that meant the whole run could get hard-
// killed mid-scan after status was already set to "running" but before any
// terminal status was ever written — leaving a customer's dashboard stuck
// on "Annie is researching" indefinitely. Every external call below now
// goes through this instead of a bare fetch().
export async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// 2026-08-24: root cause of scan-now-background.js silently consuming its
// entire 15-minute background-function budget with zero signals, zero
// errors, and zero status update. Every direct external call in this file
// (Apollo/Adzuna/Companies House/Anthropic) already goes through
// fetchWithTimeout/fetchWithRetry above — but every Supabase call
// (verifyContact's company_contacts cache read/write, enrichCompany's
// company_enrichment cache, the apollo_reserve_credits/anthropic_reserve_tokens
// RPCs, the final intelligence_signals upsert) had no timeout anywhere,
// because supabase-js's own internal fetch has none by default. Those calls
// run deep inside buildEnrichedSignalRows's per-company sequential loop,
// itself run by a handful of concurrent workers (mapWithConcurrency) whose
// own outer Promise.all only resolves once every worker returns — so a
// single hung Postgres/PostgREST connection anywhere in that chain was
// enough to permanently stall every worker's queue, and therefore the whole
// function, past Netlify's hard kill, with the code still parked inside one
// unresolved `await` the entire time (which is exactly why nothing ever
// reached a catch block or a status write).
//
// Passed into createClient's `global.fetch` option, this timeout covers
// every REST and RPC call the resulting client makes — one guard at each
// client's construction site, rather than hunting down and individually
// wrapping every one of the ~10 call sites spread across this file. 20s is
// far more than any of these calls should ever legitimately need (they're
// simple keyed reads/writes/RPCs, not web search), so this should never
// fire under normal conditions — it exists purely to convert "hangs
// forever" into "fails after 20s, gets caught, gets logged, gets retried
// next run" the same way every external HTTP call in this file already
// behaves.
export function createTimeoutFetch(timeoutMs = 20000) {
  return (url, options = {}) => fetchWithTimeout(url, options, timeoutMs)
}

// Exponential backoff for the external calls where a transient 429/5xx
// shouldn't mean "customer sees nothing this run." A genuine 4xx other than
// 429 (bad request, bad key) is NOT retried — retrying that just spends the
// same budget three times over for the same guaranteed failure. Jittered
// backoff so a real outage doesn't turn into every customer's retry landing
// on the provider in the same instant.
export async function fetchWithRetry(url, options = {}, timeoutMs = 12000, retries = 2) {
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, options, timeoutMs)
      if (resp.ok || (resp.status < 500 && resp.status !== 429)) return resp
      lastErr = new Error(`HTTP ${resp.status}`)
    } catch (err) {
      lastErr = err
    }
    if (attempt < retries) {
      const backoffMs = 500 * Math.pow(2, attempt) + Math.random() * 250
      await new Promise(r => setTimeout(r, backoffMs))
    }
  }
  throw lastErr
}

// Blocker #5 from the pre-launch audit: 8 of 9 signal types had zero
// independent verification, the AI's own word was the entire product. This
// can't verify the CLAIM is true, but it verifies the one cheap, meaningful
// thing that stands between "AI-reported" and "actively misleading": that
// sourceUrl is a real, live page a recruiter could actually go read, not a
// hallucinated or malformed link. HEAD first (cheap, no body download);
// falls back to GET only if the server doesn't support HEAD at all (405/501
// are "method not supported", not "page doesn't exist").
export async function verifySourceUrl(url) {
  if (!url) return false
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' }, 8000)
    if (head.ok) return true
    if (head.status !== 405 && head.status !== 501) return false
    const get = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow' }, 8000)
    return get.ok
  } catch (err) {
    console.error(`[scanShared] source URL verification failed for "${url}":`, err.message)
    return false
  }
}

// Today's BD Actions requires a live_job entry to be a genuine, specific
// open role — real title, from the company's own careers page, a job board,
// or a LinkedIn Jobs post — never a news article merely mentioning hiring.
// Adzuna-sourced entries are already real postings by construction (see
// discoverAdzunaJobs), but a live_job entry the AI surfaces via its own web
// search (see the scan prompts' live_job field list) needs the same
// guarantee some other way, since the model can otherwise cite a news
// article as if it were a posting. This is a coarse, deliberately
// conservative URL-shape check, not a guarantee the page is genuinely a
// posting — paired at the call site with a demotion to hiring_activity
// (never a silent drop) for anything that doesn't pass, so a real signal
// still surfaces somewhere even when this can't confirm it belongs in the
// stricter live_job category.
export function looksLikeJobPostingUrl(url) {
  if (!url) return false
  try {
    const { pathname, hostname } = new URL(url)
    const host = hostname.toLowerCase()
    const path = pathname.toLowerCase()
    // Adzuna-sourced entries are real postings by construction (see
    // discoverAdzunaJobs) — Adzuna's own redirect URLs don't follow a
    // /jobs/-style path, so they're trusted by host alone rather than
    // failing the generic path check below.
    if (host.includes('adzuna.')) return true
    if (host.includes('linkedin.com') && /\/jobs\/view\//.test(path)) return true
    return /\/(job|jobs|career|careers|vacanc(y|ies))(\/|-|$)/.test(path)
  } catch {
    return false
  }
}

// Best-effort ops alert for the one failure mode retries can't fix: every
// customer in a run coming back with zero new signals, which almost always
// means a systemic problem (a suspended key, an outage) rather than every
// market genuinely going quiet at once — and previously nothing paged
// anyone, it just looked like a quiet news day in the logs. No-ops silently
// if SLACK_WEBHOOK_URL isn't set, since there's no requirement to have one
// configured — this degrades to "still just a log line" rather than a hard
// failure.
export async function alertIfConfigured(message) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL
  if (!webhookUrl) return
  try {
    await fetchWithTimeout(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    }, 8000)
  } catch (err) {
    console.error('[scanShared] alert webhook failed:', err.message)
  }
}

// Global daily cap on Apollo.io API credits, spent from ANY call site
// (LinkedIn import enrichment, the onboarding scan, the recurring cron).
// Enforced here rather than trusted to good behaviour at each call site,
// because a bug, a retried request, or a stranger hitting an endpoint
// directly could otherwise run up an unbounded bill on a paid third-party
// API that has no ceiling of its own. See supabase-migrations/2026-08-21-
// apollo-credit-cap.sql for the table and the atomic reservation function
// this calls — the reservation happens in a single SQL statement, so
// concurrent calls (parallel sector-group scans, two customers' scans
// running at once) can't both read a stale total and both slip past the
// cap the way a check-then-write done in JS could.
const DEFAULT_APOLLO_DAILY_CAP = 500

export async function reserveApolloCredits(supabase, credits = 1) {
  // No supabase client passed (e.g. a unit test calling these functions
  // directly) — fail open rather than block a context that was never meant
  // to be capped in the first place.
  if (!supabase) return true
  const dailyCap = parseInt(process.env.APOLLO_DAILY_CREDIT_CAP, 10) || DEFAULT_APOLLO_DAILY_CAP
  try {
    const { data, error } = await supabase.rpc('apollo_reserve_credits', { p_credits: credits, p_daily_cap: dailyCap })
    if (error) {
      // A DB hiccup here shouldn't take the whole scan down with it — fail
      // open, same philosophy as every other "degrade gracefully" branch in
      // this file.
      console.error('[scanShared] apollo_reserve_credits RPC failed, allowing the call through:', error.message)
      return true
    }
    if (!data) console.error(`[scanShared] Apollo daily credit cap (${dailyCap}) reached for today, skipping call`)
    return data
  } catch (err) {
    console.error('[scanShared] apollo_reserve_credits threw, allowing the call through:', err.message)
    return true
  }
}

// A listing/category page (e.g. a site's whole "/category/funding-news"
// feed) is not a stable per-article fact the way a specific article URL is —
// it's a live URL that genuinely goes on to host many different stories over
// time. Found auditing this exact fix: two real CargoX signals a day apart
// shared exactly this kind of URL (dxbstart.com/category/funding-news), and
// treating that shared URL as "same article" would risk silently dropping a
// genuinely new, different story that happens to appear under the same
// listing page next time. Detected by path segments that are pure category
// words with no article slug/id after them — a real article URL almost
// always ends in a long, specific, mixed slug or a numeric id.
function looksLikeListingPage(pathAndQuery) {
  return /\/(category|categories|tag|tags|topic|topics|section|sections)(\/[a-z0-9-]+)?\/?$/.test(pathAndQuery)
}

// Strips everything that varies without the underlying article changing —
// protocol, www, a trailing slash, query string, hash fragment — so the same
// URL fetched two different ways (or with tracking params appended) still
// dedupes as the same source. Returns '' (meaning "not a reliable per-story
// key") for a listing/category page — see looksLikeListingPage above.
function normalizeSourceUrl(url) {
  if (!url) return ''
  const cleaned = url.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
  const path = cleaned.replace(/^[^/]+/, '') // strip the domain, keep /path onward
  if (looksLikeListingPage(path)) return ''
  return cleaned
}

// Company-name normalization now goes through the same helper the rest of
// the app already uses to tell "Acme Ltd" and "Acme Limited" apart from two
// genuinely different companies (src/lib/companyMatch.js) — previously the
// dedup key here did its own separate, cruder lowercase-only normalization,
// so the same real company re-surfacing with a slightly different legal
// suffix across two scan runs would dedupe as two different companies.
//
// Real incident, 2026-08-23: the exact same DP World leadership-change
// article, same source_url, got written as two separate signals two days
// apart because the AI paraphrased the headline differently each run
// ("Ahmad Al-Hassan elevated to GCC CEO from CFO role" vs "Ahmad Al-Hassan
// appointed GCC CEO in February 2026") — headline-based dedup can never be
// reliable against that, the AI has no reason to phrase a summary
// identically twice. sourceUrl is a hard fact, not AI prose, so it's now the
// dedup key whenever a signal has one; headline-based matching is kept only
// as the fallback for the rarer signal with no single source article to key
// off (found is empty string).
export function normalizeKey(company, headline, sourceUrl) {
  const companyKey = normalizeCompanyName(company) || (company || '').trim().toLowerCase()
  const normalizedUrl = normalizeSourceUrl(sourceUrl)
  if (normalizedUrl) return `${companyKey}::url:${normalizedUrl}`
  const headlineKey = (headline || '').trim().toLowerCase().slice(0, 80)
  return `${companyKey}::${headlineKey}`
}

// Same company-name normalization as normalizeKey, without the headline —
// used to group/compare entries by company alone (e.g. deciding whether a
// generic hiring_activity signal should yield to specific live_job entries
// found for that same company in the same run).
export function normalizeCompanyKey(company) {
  return normalizeCompanyName(company) || (company || '').trim().toLowerCase()
}

// Implements the "replace, don't supplement" product decision for Live
// Jobs: when Annie found actual, specific open roles (live_job entries) at a
// company, the generic "this company is hiring" narrative signal for that
// same company is now redundant, and confusing side-by-side with the real
// roles behind it. Enforced here, once, on the merged list — rather than
// only as a prompt instruction the model might not follow consistently
// across several parallel sector-group calls that don't see each other's
// output — so the behaviour is guaranteed regardless of what any single AI
// call decided to also mention.
const GENERIC_HIRING_SIGNAL_TYPES = ['hiring_activity', 'job_posting_unclaimed']

export function dropGenericHiringWhereLiveJobsExist(entries) {
  const companiesWithLiveJobs = new Set(
    entries.filter(e => e.entryType === 'live_job').map(e => normalizeCompanyKey(e.company))
  )
  if (!companiesWithLiveJobs.size) return entries
  return entries.filter(e => {
    if (e.entryType === 'live_job') return true
    if (!GENERIC_HIRING_SIGNAL_TYPES.includes(e.signalType)) return true
    return !companiesWithLiveJobs.has(normalizeCompanyKey(e.company))
  })
}

// Turns a compound label like "Strategy & Corporate Development" into loose
// keyword fragments for Apollo/Adzuna's fuzzy keyword matching.
export function splitToKeywords(label) {
  return (label || '')
    .split(/&|\//)
    .map(s => s.trim())
    .filter(Boolean)
}

// Validates a model-reported eventDate is plausible before it's trusted:
// not in the future (a hallucinated or misread date), and not so far in the
// past that it can't genuinely be what a "signals from the last N days"
// prompt was asking for. Returns a real ISO timestamp or null — never lets
// an implausible date through just because Date.parse() could read it.
export function toEventIso(eventDateStr) {
  if (!eventDateStr) return null
  const t = Date.parse(eventDateStr)
  if (isNaN(t)) return null
  const now = Date.now()
  if (t > now + 24 * 60 * 60 * 1000) return null // more than a day in the future isn't a real past event
  const ageDays = (now - t) / (24 * 60 * 60 * 1000)
  if (ageDays > MAX_EVENT_AGE_DAYS) return null
  return new Date(t).toISOString()
}

// Off-list signalType values (a typo, or a category the model invented) are
// still shown, relabeled to the closest safe default, but now logged so
// drift in the model's output format is visible instead of silently eating
// signals into a generic bucket forever.
export function resolveSignalType(signalType, logPrefix) {
  if (SIGNAL_TYPES.includes(signalType)) return signalType
  console.error(`${logPrefix} unrecognised signalType "${signalType}", falling back to public_commentary`)
  return 'public_commentary'
}

// Adzuna only covers a specific set of countries, and takes an ISO country
// code, not a free-text market name. A market Annie has customers in but
// Adzuna doesn't cover (GCC, etc) correctly maps to nothing, so that
// customer just gets no Adzuna leads rather than a wrong one.
export const ADZUNA_COUNTRY_MAP = {
  uk: 'gb', 'united kingdom': 'gb', gb: 'gb', britain: 'gb',
  us: 'us', usa: 'us', 'united states': 'us', 'united states of america': 'us',
  canada: 'ca', ca: 'ca',
  australia: 'au', au: 'au',
  france: 'fr', fr: 'fr',
  netherlands: 'nl', nl: 'nl',
  poland: 'pl', pl: 'pl',
  india: 'in', in: 'in',
  brazil: 'br', br: 'br',
  'south africa': 'za', za: 'za',
}

export function mapLocationsToAdzunaCountries(locations) {
  const set = new Set()
  for (const loc of locations || []) {
    const key = (loc || '').trim().toLowerCase()
    if (ADZUNA_COUNTRY_MAP[key]) set.add(ADZUNA_COUNTRY_MAP[key])
  }
  return [...set]
}

// Adzuna is a real, live jobs board, actual job ads with a real posting
// date, not a news article's best guess — exactly the evidence
// signalType "job_posting_unclaimed" needs. Free API, no credit cost. A
// discovery input handed to the AI, not a final answer: Adzuna's own data
// doesn't reliably flag agency-posted vs direct-posted, so the AI still has
// to read each ad's language before writing it up.
export async function discoverAdzunaJobs(appId, appKey, { sectors, functions, locations }) {
  if (!appId || !appKey) return []
  const countries = mapLocationsToAdzunaCountries(locations)
  if (!countries.length) return []

  const keywords = [...(sectors || []).flatMap(splitToKeywords), ...(functions || []).flatMap(splitToKeywords)].slice(0, 6)
  if (!keywords.length) return []

  const results = []
  for (const country of countries.slice(0, 2)) {
    try {
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        results_per_page: '10',
        what: keywords.join(' '),
        max_days_old: String(SIGNAL_LOOKBACK_DAYS),
        sort_by: 'date',
      })
      const resp = await fetchWithRetry(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params.toString()}`)
      if (!resp.ok) continue
      const data = await resp.json()
      for (const j of data.results || []) {
        const title = (j.title || '').replace(/<[^>]+>/g, '').trim()
        const company = j.company?.display_name || ''
        if (!title || !company) continue
        results.push({
          title,
          company,
          location: j.location?.display_name || '',
          url: j.redirect_url || '',
          salary: j.salary_min ? `${Math.round(j.salary_min)}${j.salary_max && j.salary_max !== j.salary_min ? `-${Math.round(j.salary_max)}` : ''}` : null,
        })
      }
    } catch (err) {
      console.error('[scanShared] adzuna discovery failed:', err.message)
    }
  }
  return results.slice(0, 10)
}

// Same daily-spend-cap pattern as reserveApolloCredits (see that function's
// own comment, and 2026-08-25-theirstack-credit-cap.sql for the table this
// calls) — TheirStack is a paid third-party API with no ceiling of its
// own, so a bug or a retried request shouldn't be able to run up an
// unbounded bill. `credits` should be the number of jobs actually
// requested (TheirStack's own pricing is per job returned, not per call —
// confirmed against the account's real usage during evaluation, not
// assumed), not a flat 1 per call the way some other APIs bill.
const DEFAULT_THEIRSTACK_DAILY_CAP = 40

export async function reserveTheirStackCredits(supabase, credits = 1) {
  if (!supabase) return true
  const dailyCap = parseInt(process.env.THEIRSTACK_DAILY_CREDIT_CAP, 10) || DEFAULT_THEIRSTACK_DAILY_CAP
  try {
    const { data, error } = await supabase.rpc('theirstack_reserve_credits', { p_credits: credits, p_daily_cap: dailyCap })
    if (error) {
      console.error('[scanShared] theirstack_reserve_credits RPC failed, allowing the call through:', error.message)
      return true
    }
    if (!data) console.error(`[scanShared] TheirStack daily credit cap (${dailyCap}) reached for today, skipping call`)
    return data
  } catch (err) {
    console.error('[scanShared] theirstack_reserve_credits threw, allowing the call through:', err.message)
    return true
  }
}

// 2026-08-25, Michael: Annie now only actually serves UAE/GCC, United
// Kingdom, and United States — see buildLiveJobBoardHint/
// REGIONAL_SOURCE_DIRECTORY's own headers for why UK/US already have real
// Adzuna coverage and don't need this. TheirStack (theirstack.com) is a
// genuine, verified-live job-posting aggregator — evaluated directly
// against this account's real API key before integrating, not taken on
// faith — that fills the one real gap: UAE/GCC has no Adzuna coverage at
// all (see ADZUNA_COUNTRY_MAP). Only ever holds GCC country codes on
// purpose; if Annie ever expands to serve another market again, add it
// here deliberately rather than assuming broader coverage is safe.
export const THEIRSTACK_COUNTRY_MAP = {
  'uae / gcc': ['AE', 'SA', 'QA', 'KW', 'BH', 'OM'],
}

export function mapLocationsToTheirStackCountries(locations) {
  const set = new Set()
  for (const loc of locations || []) {
    const key = (loc || '').trim().toLowerCase()
    if (THEIRSTACK_COUNTRY_MAP[key]) THEIRSTACK_COUNTRY_MAP[key].forEach(c => set.add(c))
  }
  return [...set]
}

// Mirrors discoverAdzunaJobs's shape exactly (same lead fields: title,
// company, location, url, salary) so both feed opts.theirStackLeads /
// opts.adzunaLeads into the prompt the same way and the AI's existing
// agency-vs-direct-posting judgement call applies identically to both —
// no separate handling needed downstream. Deliberately does NOT filter by
// company name — evaluated live against this account's real key first: a
// company-name search came back noisy (fuzzy/partial matching pulled in
// unrelated similarly-named companies, the same class of risk
// pickBestOrgMatch exists to guard against for Apollo), where a plain
// country + keyword search came back clean, real, freshly-dated postings
// sourced from real boards (NaukriGulf, Indeed, LinkedIn Jobs confirmed
// live). So this only ever does the safe query shape, and leaves company
// identity resolution to the same AI read + verifyContact/enrichCompany
// pipeline every other lead source already goes through.
export async function discoverTheirStackJobs(apiKey, { sectors, functions, locations }, supabase) {
  if (!apiKey) return []
  const countries = mapLocationsToTheirStackCountries(locations)
  if (!countries.length) return []

  const keywords = [...(sectors || []).flatMap(splitToKeywords), ...(functions || []).flatMap(splitToKeywords)].slice(0, 6)

  const limit = 10
  if (!(await reserveTheirStackCredits(supabase, limit))) return []

  try {
    const body = {
      limit,
      offset: 0,
      posted_at_max_age_days: SIGNAL_LOOKBACK_DAYS,
      job_country_code_or: countries,
    }
    if (keywords.length) body.job_title_or = keywords

    const resp = await fetchWithRetry('https://api.theirstack.com/v1/jobs/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      console.error(`[scanShared] TheirStack jobs/search non-ok response: ${resp.status}`)
      return []
    }
    const data = await resp.json()
    return (data.data || [])
      .map(j => ({
        title: (j.job_title || '').trim(),
        company: (j.company || '').trim(),
        location: j.location || j.short_location || '',
        url: j.url || j.final_url || j.source_url || '',
        salary: j.salary_string || null,
      }))
      .filter(j => j.title && j.company && j.url)
      .slice(0, limit)
  } catch (err) {
    console.error('[scanShared] TheirStack discovery failed:', err.message)
    return []
  }
}

// Apollo tracks real job postings directly, it isn't guessing from news.
// Querying it BEFORE the AI call gives the AI a head start of real,
// independently-confirmed leads rather than relying purely on whatever
// general news search happens to surface.
export async function discoverHotCompanies(apolloKey, { sectors, functions, locations }, supabase) {
  if (!apolloKey) return []
  if (!(await reserveApolloCredits(supabase))) return []
  try {
    const body = { per_page: 8, organization_num_jobs_range: { min: 1 } }
    body.organization_job_posted_at_range = { min: isoDateDaysAgo(SIGNAL_LOOKBACK_DAYS) }

    const sectorKeywords = (sectors || []).flatMap(splitToKeywords)
    if (sectorKeywords.length) body.q_organization_keyword_tags = sectorKeywords.slice(0, 20)

    const titleKeywords = (functions || []).flatMap(splitToKeywords)
    if (titleKeywords.length) body.q_organization_job_titles = titleKeywords.slice(0, 20)

    if (locations?.length) body.organization_locations = locations.slice(0, 10)

    const resp = await fetchWithRetry('https://api.apollo.io/v1/mixed_companies/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return []
    const data = await resp.json()
    const orgs = [...(data.organizations || []), ...(data.accounts || [])]
    return orgs
      .map(o => ({ name: o.name, industry: o.industry || null, employees: o.estimated_num_employees || null }))
      .filter(o => o.name)
      .slice(0, 8)
  } catch (err) {
    console.error('[scanShared] apollo discovery failed:', err.message)
    return []
  }
}

// A verified hiring-manager contact is close to a company-level fact, but
// NOT purely one — it depends on which role/title was actually being
// searched for. This TTL balances "don't re-verify every single scan run"
// against "a contact from 6 months ago might have moved on."
const CONTACT_CACHE_TTL_DAYS = 60

// The cache key needs a title dimension, not just the company: an earlier
// version of this cache keyed purely on company, so the FIRST contact ever
// resolved for a company (say, a CFO found for a funding signal) would be
// served back as "the verified contact" for a completely different role at
// the same company later — confidently wrong, not just missing. Latent
// until Live Jobs made "several different open roles at the same company in
// one run" a real, common case. Order-independent (so ['CFO','VP Finance']
// and ['VP Finance','CFO'] hit the same cache entry) and case-insensitive;
// no titleKeywords at all buckets under 'general' rather than colliding with
// an empty string key.
export function titleBucketKey(titleKeywords) {
  if (!titleKeywords?.length) return 'general'
  return [...titleKeywords].map(t => (t || '').trim().toLowerCase()).filter(Boolean).sort().join('|') || 'general'
}

// Contact info is only ever trusted from Apollo. An AI-mentioned name is
// reasoning, not a fact, it stays in who_to_approach, never in the verified
// contact fields.
//
// apolloOrgId is required, not optional in practice: as of August 2026,
// Apollo deprecated the old mixed_people/search endpoint for API callers
// entirely (confirmed live in production — every single call was coming
// back 422 "This endpoint is deprecated for API callers", which is the
// actual reason 0 of a real customer's 12 signals ever got a verified
// contact, not a bad key or a plan restriction). Its replacement,
// mixed_people/api_search, doesn't accept a free-text company name at all —
// only organization_ids or a domain — so callers must resolve the company
// via enrichCompany() FIRST and pass its apolloOrgId through here. Without
// one, there's no way to search people by company any more, so this
// returns null rather than guessing.
// appointedName: for leadership_change signals the AI names the actual
// person appointed (see appointedName in both scan prompts) — when given,
// this looks that exact person up by name instead of a generic title
// search, since the whole point of a leadership_change signal is reaching
// the new decision-maker themselves, not just anyone holding a similar
// title. Still only ever trusted once Apollo itself confirms the match
// (see the header comment above), the AI's name is a lead to search for,
// not a fact accepted on its own.
export async function verifyContact(apolloKey, company, titleKeywords, supabase, apolloOrgId, appointedName) {
  if (!apolloKey || !company) return null

  const cacheKey = enrichmentCacheKey(company)
  // Name-based lookups get their own cache bucket, separate from role-based
  // ones, so a leadership_change re-run for the same company doesn't collide
  // with (or get shadowed by) an unrelated title-bucket cache entry.
  const titleKey = appointedName ? `name:${normalizeNameKey(appointedName)}` : titleBucketKey(titleKeywords)

  // 1. Check the shared cache first — company_contacts, one row per
  // (company, title bucket), NOT company_enrichment's older one-contact-
  // per-company columns (see titleBucketKey's header for why that was
  // wrong). Covers a negative result too (contact_verified: false means
  // "we already looked for this exact kind of role, nobody findable") so a
  // company/role combination that never yields a contact isn't retried on
  // every single run either.
  if (supabase) {
    try {
      const { data: cached } = await supabase
        .from('company_contacts')
        .select('contact_name, contact_title, contact_linkedin_url, contact_email, contact_verified, checked_at')
        .eq('company_name_key', cacheKey)
        .eq('title_key', titleKey)
        .maybeSingle()
      if (cached?.checked_at) {
        const ageDays = (Date.now() - new Date(cached.checked_at).getTime()) / (24 * 60 * 60 * 1000)
        if (ageDays <= CONTACT_CACHE_TTL_DAYS) {
          return cached.contact_verified
            ? { name: cached.contact_name, title: cached.contact_title || '', linkedin_url: cached.contact_linkedin_url || '', email: cached.contact_email || null }
            : null
        }
      }
    } catch (err) {
      console.error(`[scanShared] contact cache lookup failed for "${company}" (${titleKey}):`, err.message)
    }
  }

  // 2. Cache miss (or stale) — only now does this spend anything, and only
  // now does the lack of a resolved org id actually matter.
  if (!apolloOrgId) return null
  if (!(await reserveApolloCredits(supabase))) return null

  const result = appointedName
    ? await lookupContactByName(apolloKey, company, appointedName, supabase)
    : await lookupContact(apolloKey, company, titleKeywords, supabase, apolloOrgId)

  // 3. Write through regardless of hit or miss — a negative result is a
  // cache-worthy fact too, see the comment on step 1.
  if (supabase) {
    try {
      // 2026-08-24 Task 5: the try/catch here only ever caught a network-
      // level throw — the Supabase client resolves normally with `error`
      // set on a query-level failure (RLS denial, constraint violation), so
      // that case was silently invisible despite looking handled. Result:
      // the cache never actually writes, and every future scan re-spends an
      // Apollo credit re-looking-up a company/contact that was supposedly
      // already cached, with nothing in the logs to explain the drift.
      const { error } = await supabase.from('company_contacts').upsert({
        company_name_key: cacheKey,
        title_key: titleKey,
        contact_name: result?.name || null,
        contact_title: result?.title || null,
        contact_linkedin_url: result?.linkedin_url || null,
        contact_email: result?.email || null,
        contact_verified: !!result,
        checked_at: new Date().toISOString(),
      }, { onConflict: 'company_name_key,title_key' })
      if (error) console.error(`[scanShared] contact cache write failed for "${company}" (${titleKey}):`, error.message)
    } catch (err) {
      console.error(`[scanShared] contact cache write failed for "${company}" (${titleKey}):`, err.message)
    }
  }

  return result
}

async function lookupContact(apolloKey, company, titleKeywords, supabase, apolloOrgId) {
  try {
    const resp = await fetchWithRetry('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify({ organization_ids: [apolloOrgId], person_titles: titleKeywords?.length ? titleKeywords : undefined, page: 1, per_page: 1 }),
    })
    if (!resp.ok) {
      // This used to only go to console.error — invisible the same way the
      // intelligence_signals write failures were, just in a different file.
      const bodyPreview = await resp.text().catch(() => '')
      console.error(`[scanShared] verifyContact non-ok response for "${company}": ${resp.status}`)
      await reportServerError('scanShared:verifyContact', new Error(`Apollo mixed_people/api_search returned ${resp.status}`), {
        company, apolloOrgId, titleKeywords, status: resp.status, bodyPreview: bodyPreview.slice(0, 500),
      })
      return null
    }
    const data = await resp.json()
    const p = (data.people || [])[0]
    if (!p) return null
    // 2026-08-24: mixed_people/api_search masks last names on this account's
    // Apollo plan tier — the raw response carries `last_name_obfuscated`
    // (e.g. "Re***n"), never a usable `last_name`, confirmed directly
    // against the live API, not assumed. Requiring p.last_name straight off
    // this search result — the previous behavior — meant every single
    // result from this endpoint, for every company, every signal type, was
    // silently discarded here. That's the actual root cause of Today's BD
    // Actions going completely empty: the "always require a real contact"
    // rule was correctly enforcing itself against a pipeline that could
    // never produce one. A first name is still enough to know there's a
    // real person worth revealing — the full identity comes from the same
    // reveal call already made below for the email, which returns an
    // unmasked name (confirmed live: search gave "Re***n", the reveal call
    // for that same person id gave "Rehman").
    if (!p.first_name) return null

    // Reveal is no longer "just for email" — for this endpoint it's now the
    // only source of the real, unmasked last name too, so it's always
    // attempted once there's a person id, not conditioned on already having
    // a full name from search (which this endpoint never actually gives).
    let email = null
    let revealedFirstName = null
    let revealedLastName = null
    let revealedTitle = null
    let revealedLinkedin = null
    if (p.id && (await reserveApolloCredits(supabase))) {
      try {
        const matchResp = await fetchWithRetry('https://api.apollo.io/v1/people/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
          body: JSON.stringify({ id: p.id, reveal_personal_emails: true }),
        }, 12000, 1)
        if (matchResp.ok) {
          const matchData = await matchResp.json()
          const revealedPerson = matchData?.person
          revealedFirstName = revealedPerson?.first_name || null
          revealedLastName = revealedPerson?.last_name || null
          revealedTitle = revealedPerson?.title || null
          revealedLinkedin = revealedPerson?.linkedin_url || null
          const revealed = revealedPerson?.email
          if (revealed && !revealed.includes('email_not_unlocked') && !revealed.includes('locked')) email = revealed
        } else {
          console.error(`[scanShared] email reveal non-ok response for "${company}"/"${p.first_name}": ${matchResp.status}`)
        }
      } catch (err) {
        // Never let a failed reveal cost visibility into why — this is now
        // also the only source of the last name, so a failure here means
        // no contact at all, not just no email, and that's worth knowing.
        console.error(`[scanShared] email reveal failed for "${company}"/"${p.first_name}":`, err.message)
      }
    }

    // Same bar as before — a confirmed first AND last name, not a thin
    // partial record — just checked against the reveal response, the only
    // place a real (unmasked) last name actually exists, instead of the
    // search response, which never has one on this plan.
    const firstName = revealedFirstName || p.first_name
    const lastName = revealedLastName
    if (!firstName || !lastName) return null
    const name = `${firstName} ${lastName}`.trim()

    return { name, title: revealedTitle || p.title || '', linkedin_url: revealedLinkedin || p.linkedin_url || '', email }
  } catch (err) {
    console.error(`[scanShared] verifyContact failed for "${company}":`, err.message)
    await reportServerError('scanShared:verifyContact', err, { company, titleKeywords })
    return null
  }
}

// Looks up a specific named person at a company, via Apollo's people/match
// endpoint — used only for leadership_change signals, where the AI already
// named the person appointed (appointedName) and the goal is reaching that
// exact individual, not a generic title match. Falls back to null (never to
// a generic title search within this same call) if Apollo can't confirm a
// match on the name, since showing a different, unrelated person under "the
// new leader" would be worse than showing no verified contact at all.
async function lookupContactByName(apolloKey, company, fullName, supabase) {
  try {
    // people/match (People Enrichment) takes a name plus a company hint, not
    // an organization_id — unlike mixed_people/api_search above, which is a
    // search endpoint that filters by org id. organization_name is passed as
    // the company hint here so Apollo can disambiguate a common name.
    const resp = await fetchWithRetry('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify({ name: fullName, organization_name: company }),
    }, 12000, 1)
    if (!resp.ok) {
      console.error(`[scanShared] lookupContactByName non-ok response for "${fullName}" at "${company}": ${resp.status}`)
      return null
    }
    const data = await resp.json()
    const p = data?.person
    // Same bar as the title-based lookup: a confirmed first AND last name,
    // not a thin partial record.
    if (!p || !p.first_name || !p.last_name) return null
    const name = `${p.first_name} ${p.last_name}`.trim()

    let email = null
    if (p.id && (await reserveApolloCredits(supabase))) {
      try {
        const matchResp = await fetchWithRetry('https://api.apollo.io/v1/people/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
          body: JSON.stringify({ id: p.id, reveal_personal_emails: true }),
        }, 12000, 1)
        if (matchResp.ok) {
          const matchData = await matchResp.json()
          const revealed = matchData?.person?.email
          if (revealed && !revealed.includes('email_not_unlocked') && !revealed.includes('locked')) email = revealed
        } else {
          console.error(`[scanShared] email reveal non-ok response for "${company}"/"${name}": ${matchResp.status}`)
        }
      } catch (err) {
        console.error(`[scanShared] email reveal failed for "${company}"/"${name}":`, err.message)
      }
    }

    return { name, title: p.title || '', linkedin_url: p.linkedin_url || '', email }
  } catch (err) {
    console.error(`[scanShared] lookupContactByName failed for "${fullName}" at "${company}":`, err.message)
    await reportServerError('scanShared:lookupContactByName', err, { company, fullName })
    return null
  }
}

// Funding/expansion signals rarely have one obvious "the" contact the way a
// leadership_change does — the actionable question is closer to "who would
// this company likely be hiring for off the back of this", which is
// naturally several people across different functions, not one. These are
// the buckets Annie searches by default; every one of the four whitelisted
// Today's BD Actions signal types (see BD_ACTION_SIGNAL_TYPES in
// actionsEngine.js) is required to always carry at least one usable contact
// recommendation, so this is the fallback that guarantees that when a single
// verifyContact call comes back empty.
const FUNCTION_TITLE_BUCKETS = {
  product: ['Head of Product', 'VP Product', 'Product Director'],
  engineering: ['Head of Engineering', 'VP Engineering', 'Engineering Director'],
  commercial: ['Commercial Director', 'VP Sales', 'Head of Business Development'],
}

// Searches several functional title-buckets at once for the same company,
// instead of the single title-keyword search verifyContact normally does.
// Deliberately reuses verifyContact itself rather than a parallel lookup
// path: the contact cache (company_contacts) is already keyed on
// (company, title bucket) — see titleBucketKey — so calling verifyContact
// several times with different title arrays for the same company already
// returns distinct people correctly today (proven by
// scanShared.test.js's "does NOT reuse a cached contact across genuinely
// different roles" case), it's just never been called more than once per
// signal before. Runs with limited concurrency so a single funding signal
// doesn't spend its whole run's worth of Apollo credit budget in one burst;
// each bucket search still goes through the same reserveApolloCredits cap
// verifyContact itself already enforces.
export async function verifyContactsAcrossFunctions(apolloKey, company, supabase, apolloOrgId, functions = Object.keys(FUNCTION_TITLE_BUCKETS)) {
  const results = await mapWithConcurrency(functions, 2, async (fn) => {
    const contact = await verifyContact(apolloKey, company, FUNCTION_TITLE_BUCKETS[fn] || [fn], supabase, apolloOrgId)
    return contact ? { function: fn, ...contact } : null
  })
  return results.filter(Boolean)
}

// Same normalization idea as enrichmentCacheKey, for a person's name rather
// than a company name — used to bucket the name-based contact cache key.
function normalizeNameKey(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// Normalizes a company name into the same lowercase cache key
// apollo-enrich-companies.js already uses for the shared `company_enrichment`
// table, so a company enriched once via LinkedIn import (by any customer)
// or once via a scan run (for any customer) is never re-enriched by Apollo
// again anywhere else in the product.
function enrichmentCacheKey(name) {
  return (name || '').trim().toLowerCase()
}

// Best-effort domain guess for a company Apollo didn't match, via
// Clearbit's free, keyless autocomplete endpoint — the only remaining way
// to still resolve a real logo for a company we otherwise know nothing
// about. This is a visual guess only, never treated as confirmed company
// data (Apollo stays the only source of truth for domain/industry/
// apolloOrgId) — it exists purely so a signal card never has to fall back
// to the plain initials placeholder.
async function lookupDomainViaClearbit(company) {
  try {
    const resp = await fetchWithRetry(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(company)}`, {}, 5000, 1)
    if (!resp.ok) return null
    const data = await resp.json()
    return data?.[0]?.domain || null
  } catch (err) {
    console.error(`[scanShared] Clearbit domain lookup failed for "${company}":`, err.message)
    return null
  }
}

// Resolves the logo to actually show: Apollo's own if it gave one, else a
// domain-based logo built from whatever domain is available (Apollo's own
// match, or the Clearbit guess above as a last resort). Kept as its own
// step rather than folded silently into the org lookup above so it's clear
// this is a display concern, not a data-matching one.
async function resolveLogoUrl(company, domain, existingLogoUrl) {
  if (existingLogoUrl) return existingLogoUrl
  const resolvedDomain = domain || await lookupDomainViaClearbit(company)
  return resolvedDomain ? `https://logo.clearbit.com/${resolvedDomain}` : null
}

// Apollo's org-name search is a fuzzy/relevance search, not an exact-match
// lookup — for a short or generic company name it can rank a completely
// unrelated, larger, better-known company above the actual one a signal is
// about (confirmed live: a signal genuinely about "Stitch", a GCC fintech
// that raised a Series A, got matched to "Stitch Fix", the unrelated US
// public company — and every "Stitch"-named signal afterward inherited the
// same wrong match via the cache below, since enrichCompany used to just
// take candidates[0] with no check at all). This picks, in order: (1) a
// candidate whose name matches the input exactly (case/whitespace
// insensitive) — the only case that's actually safe to trust blindly; (2)
// failing that, a candidate whose country matches one of the customer's
// monitored locations, as a best-effort disambiguator when Apollo has
// location data for the org; (3) otherwise null. A wrong-but-plausible
// guess is worse than no match here — an unmatched company still shows
// fine (no logo/no contact), where a wrong match puts a real stranger's
// name and email on a card for the wrong business.
function pickBestOrgMatch(candidates, company, locationHints = []) {
  if (!candidates?.length) return null
  const norm = (v) => (v || '').trim().toLowerCase().replace(/\s+/g, ' ')
  const target = norm(company)
  const exact = candidates.find((c) => norm(c.name) === target)
  if (exact) return exact
  if (locationHints.length) {
    const hints = locationHints.map(norm).filter(Boolean)
    const locationMatch = candidates.find((c) => {
      const country = norm(c.country)
      return country && hints.some((h) => country.includes(h) || h.includes(country))
    })
    if (locationMatch) return locationMatch
  }
  return null
}

export async function enrichCompany(apolloKey, company, supabase, locationHints = []) {
  if (!company) return null
  const cacheKey = enrichmentCacheKey(company)

  // 1. Check the shared, cross-customer cache first — this is the same
  // `company_enrichment` table apollo-enrich-companies.js populates from the
  // LinkedIn import flow, extended here so the scan pipeline benefits from
  // it too instead of maintaining its own separate, never-shared cache (or
  // no cache at all, which is what this function did before: every scan run
  // re-spent a credit on the same company every time it resurfaced).
  if (supabase) {
    try {
      const { data: cached } = await supabase
        .from('company_enrichment')
        .select('domain, industry, city, state, country, logo_url, matched, apollo_org_id')
        .eq('company_name_key', cacheKey)
        .maybeSingle()
      // A cache row from before apollo_org_id existed (matched=true but the
      // new column is still null) is treated as a miss, not a hit — falls
      // through to a fresh lookup so it gets backfilled, rather than
      // returning apolloOrgId: null forever and silently breaking
      // verifyContact for every company enriched before today's fix.
      //
      // Always returns an object now, even for an unmatched company — a
      // cached row still carries whatever best-effort logo_url was resolved
      // below the first time this company was looked up, and "no company
      // shown without a logo" has to hold on a cache hit too, not just a
      // fresh lookup.
      if (cached && (!cached.matched || cached.apollo_org_id)) {
        return {
          domain: cached.domain, industry: cached.industry, city: cached.city, state: cached.state,
          country: cached.country, logo_url: cached.logo_url, apolloOrgId: cached.apollo_org_id || null,
          matched: cached.matched,
        }
      }
    } catch (err) {
      console.error(`[scanShared] company_enrichment cache lookup failed for "${company}":`, err.message)
    }
  }

  // 2. Cache miss — only now does this spend anything (the Apollo call;
  // the logo fallback below never spends a credit, Clearbit is free).
  let result = null
  if (apolloKey && (await reserveApolloCredits(supabase))) {
    try {
      // per_page: 5 (was 1) — pickBestOrgMatch needs real candidates to
      // choose between, not just Apollo's single top-ranked (and, for a
      // short/generic name, not necessarily correct) guess.
      const resp = await fetchWithRetry('https://api.apollo.io/v1/mixed_companies/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
        body: JSON.stringify({ q_organization_name: company, page: 1, per_page: 5 }),
      })
      if (!resp.ok) {
        console.error(`[scanShared] enrichCompany non-ok response for "${company}": ${resp.status}`)
        await reportServerError('scanShared:enrichCompany', new Error(`Apollo mixed_companies/search returned ${resp.status}`), { company })
      } else {
        const data = await resp.json()
        const candidates = [...(data.organizations || []), ...(data.accounts || [])]
        const org = pickBestOrgMatch(candidates, company, locationHints)
        if (!org && candidates.length) {
          console.log(`[scanShared] enrichCompany: no confident match for "${company}" among ${candidates.length} Apollo candidates (top candidate: "${candidates[0]?.name}") — leaving unmatched rather than guessing`)
        }
        if (org) {
          result = {
            domain: org.primary_domain || org.domain || null,
            industry: org.industry || null,
            city: org.city || null,
            state: org.state || null,
            country: org.country || null,
            logo_url: org.logo_url || null,
            // Needed by verifyContact — see that function's header. Captured
            // here so the one companies/search credit this call already
            // spends also resolves people search, instead of a second,
            // separate lookup for the same company.
            apolloOrgId: org.id || org.organization_id || null,
          }
        }
      }
    } catch (err) {
      console.error(`[scanShared] enrichCompany failed for "${company}":`, err.message)
    }
  }

  const logoUrl = await resolveLogoUrl(company, result?.domain, result?.logo_url)

  // 3. Write through to the cache regardless of hit or miss, matched or not
  // — an unmatched company also never costs a repeat credit, same reasoning
  // apollo-enrich-companies.js already uses. logo_url is cached here too,
  // whether it came from Apollo or the Clearbit fallback, so it's resolved
  // at most once per company rather than re-guessed on every scan.
  if (supabase) {
    try {
      // 2026-08-24 Task 5: same gap as company_contacts above — a
      // query-level `error` resolves normally rather than throwing, so this
      // catch alone never saw it. Checked explicitly now.
      const { error } = await supabase.from('company_enrichment').upsert({
        company_name_key: cacheKey,
        company_name: company,
        domain: result?.domain || null,
        industry: result?.industry || null,
        city: result?.city || null,
        state: result?.state || null,
        country: result?.country || null,
        logo_url: logoUrl,
        apollo_org_id: result?.apolloOrgId || null,
        matched: !!result,
        enriched_at: new Date().toISOString(),
      }, { onConflict: 'company_name_key' })
      if (error) console.error(`[scanShared] company_enrichment cache write failed for "${company}":`, error.message)
    } catch (err) {
      console.error(`[scanShared] company_enrichment cache write failed for "${company}":`, err.message)
    }
  }

  // Always an object once a company name was given — never bare null just
  // because Apollo didn't match anything, since logoUrl (the Clearbit
  // fallback) can still be real even without an Apollo match. Every
  // existing caller already reads fields off this via `?.`, so a
  // no-Apollo-match company with a fallback logo behaves exactly like an
  // unmatched company always has (apolloOrgId: null, etc.) except it now
  // also carries a logo.
  return {
    domain: result?.domain || null,
    industry: result?.industry || null,
    city: result?.city || null,
    state: result?.state || null,
    country: result?.country || null,
    logo_url: logoUrl,
    apolloOrgId: result?.apolloOrgId || null,
    matched: !!result,
  }
}

// Companies House is the UK's own public register, a director appointment
// or resignation here is a verified FACT, not a news article's best guess.
// Only called for leadership_change signals, and only ever upgrades a
// signal's credibility, never blocks one — if nothing matches this quietly
// returns null and the AI's own writeup stands on its own.
export async function verifyLeadershipChange(chApiKey, companyName) {
  if (!chApiKey || !companyName) return null
  try {
    const authHeader = 'Basic ' + Buffer.from(`${chApiKey}:`).toString('base64')

    const searchResp = await fetchWithRetry(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=5`, {
      headers: { Authorization: authHeader },
    })
    if (!searchResp.ok) return null
    const searchData = await searchResp.json()
    const items = searchData.items || []
    const best = items.find(c => c.company_status === 'active') || items[0]
    if (!best?.company_number) return null

    const officersResp = await fetchWithRetry(`https://api.company-information.service.gov.uk/company/${best.company_number}/officers?items_per_page=50`, {
      headers: { Authorization: authHeader },
    })
    if (!officersResp.ok) return null
    const officersData = await officersResp.json()

    const cutoff = Date.now() - LEADERSHIP_VERIFY_WINDOW_DAYS * 24 * 60 * 60 * 1000
    let mostRecent = null
    let mostRecentTime = 0
    for (const o of officersData.items || []) {
      const dateStr = o.resigned_on || o.appointed_on
      if (!dateStr) continue
      const t = new Date(dateStr).getTime()
      if (isNaN(t) || t < cutoff) continue
      if (t > mostRecentTime) { mostRecent = o; mostRecentTime = t }
    }
    if (!mostRecent) return null

    const changeType = mostRecent.resigned_on ? 'resigned as' : 'appointed as'
    const changeDate = mostRecent.resigned_on || mostRecent.appointed_on
    return {
      detail: `Companies House confirms: ${mostRecent.name} ${changeType} ${mostRecent.officer_role || 'officer'} on ${changeDate}.`,
    }
  } catch (err) {
    console.error('[scanShared] Companies House verification failed:', err.message)
    return null
  }
}

// Cleans and bounds the AI's candidateProfile object before it's stored —
// the same "what to look for" structure has to render identically on every
// signal card (see CandidateProfileBox.jsx), so this guards against the AI
// returning the wrong shape, non-numeric years, or an unbounded company
// list, rather than trusting raw model JSON straight into a jsonb column.
function sanitizeCandidateProfile(profile) {
  if (!profile || typeof profile !== 'object') return null
  const yearsMin = Number.isFinite(profile.yearsMin) ? Math.max(0, Math.round(profile.yearsMin)) : null
  const yearsMax = Number.isFinite(profile.yearsMax) ? Math.max(0, Math.round(profile.yearsMax)) : null
  const functionalExperience = stripAiArtifacts(profile.functionalExperience) || ''
  const directCompetitors = sanitizeStringList(profile.directCompetitors, 3)
  const similarIndustry = sanitizeStringList(profile.similarIndustry, 3)
  const widerScope = sanitizeStringList(profile.widerScope, 2)

  const isEmpty = yearsMin === null && yearsMax === null && !functionalExperience &&
    !directCompetitors.length && !similarIndustry.length && !widerScope.length
  if (isEmpty) return null

  return { yearsMin, yearsMax, functionalExperience, directCompetitors, similarIndustry, widerScope }
}

// Builds one intelligence_signals row from a raw scan entry (an AI-written
// signal, or an Adzuna-sourced live_job entry), running every enrichment
// call the row depends on: company info + Apollo org id (enrichCompany), a
// verified contact (verifyContact — cached at the company level, see that
// function's own header), Companies House confirmation for
// leadership_change signals, and a liveness check on the source URL.
//
// This used to be a ~35-line block pasted independently into both
// scan-now-background.js and intelligence-scan.js, differing only in which
// user_id to attribute rows to and which log prefix to attribute an
// unrecognised signalType to. Every field this session added (intro_message,
// bench_strength_angle, the live_job branch) had to be hand-applied to both
// copies — exactly the drift risk the rest of this file already exists to
// avoid for the orchestration logic, just not yet for this part.
//
// signal_type is forced to 'live_job' in code from the entry's own
// entryType field for live_job entries, never trusted to the AI's own
// signalType choice — see dropGenericHiringWhereLiveJobsExist above and
// both scan files' prompts.
export async function buildEnrichedSignalRow(s, { userId, apolloKey, companiesHouseKey, supabase, logPrefix, locationHints = [] }) {
  // enrichCompany runs first, not in parallel with verifyContact: Apollo's
  // people-search now requires a resolved organization_id (see
  // verifyContact's header), which only enrichCompany's own company lookup
  // can provide — running them in parallel would mean verifyContact never
  // has an id to search with.
  const [companyInfo, chVerification, sourceVerified] = await Promise.all([
    enrichCompany(apolloKey, s.company, supabase, locationHints),
    s.signalType === 'leadership_change' ? verifyLeadershipChange(companiesHouseKey, s.company) : Promise.resolve(null),
    verifySourceUrl(s.sourceUrl),
  ])

  const isLiveJob = s.entryType === 'live_job'
  // A live_job entry the AI surfaced via its own web search (rather than
  // Adzuna, which is already real-by-construction) has to actually resolve
  // to a genuine job-posting-shaped URL — see looksLikeJobPostingUrl. One
  // that doesn't is demoted to hiring_activity, not dropped: it's still a
  // real signal about the company, just not one Today's BD Actions can
  // treat as a verified specific open role.
  const liveJobUrlVerified = !isLiveJob || looksLikeJobPostingUrl(s.sourceUrl)
  if (isLiveJob && !liveJobUrlVerified) {
    console.error(`${logPrefix} live_job entry for "${s.company}" demoted to hiring_activity — sourceUrl doesn't resolve to a recognisable job posting: ${s.sourceUrl}`)
  }
  const signalType = isLiveJob && liveJobUrlVerified ? 'live_job' : resolveSignalType(isLiveJob ? 'hiring_activity' : s.signalType, logPrefix)

  // 2026-08-25 correction: this comment used to say "the four whitelisted
  // Today's BD Actions signal types ... see BD_ACTION_SIGNAL_TYPES in
  // actionsEngine.js" — both wrong. That file doesn't exist anymore (the
  // constant lives in src/lib/todaysActions/eligibility.js), and the live
  // whitelist there is currently just ['leadership_change', 'live_job'] —
  // funding/expansion were narrowed out on 2026-08-24. This function still
  // enriches all four types the same way regardless, on purpose: a
  // funding/expansion signal can still reach Today's BD Actions via the
  // "Add to Today's BD Actions" manual bypass from the Feed, and it needs
  // the same real contact data as anything else, not a worse version just
  // because it took the manual path. See eligibility.js for the actual
  // current whitelist and sourcedPool.js for how the manual bypass works.
  // Funding/expansion rarely have one obvious single contact the way a
  // named leadership appointment or a specific job posting does — see
  // verifyContactsAcrossFunctions's own header — so those two go straight
  // to the multi-function search instead of a single generic title-keyword
  // lookup that would usually come back empty anyway. live_job/
  // leadership_change keep their existing single-contact lookup as the
  // primary path, falling back to the same multi-function search only if
  // that comes back with nobody, so the "always a contact" guarantee holds
  // for all four types, not just the two with an obvious single person.
  const isFundingOrExpansion = ['funding', 'expansion'].includes(signalType)
  let contact = null
  let contactCandidates = []
  if (isFundingOrExpansion) {
    if (companyInfo?.apolloOrgId) {
      contactCandidates = await verifyContactsAcrossFunctions(apolloKey, s.company, supabase, companyInfo.apolloOrgId)
    }
  } else {
    contact = await verifyContact(apolloKey, s.company, s.titleKeywords, supabase, companyInfo?.apolloOrgId, signalType === 'leadership_change' ? s.appointedName : null)
    if (!contact && companyInfo?.apolloOrgId) {
      contactCandidates = await verifyContactsAcrossFunctions(apolloKey, s.company, supabase, companyInfo.apolloOrgId)
    }
  }

  return {
    user_id: userId,
    company_name: s.company,
    company_domain: companyInfo?.domain || null,
    company_industry: companyInfo?.industry || null,
    company_city: companyInfo?.city || null,
    company_state: companyInfo?.state || null,
    company_country: companyInfo?.country || null,
    company_logo_url: companyInfo?.logo_url || null,
    signal_type: signalType,
    headline: stripAiArtifacts(s.headline),
    why_it_matters: stripAiArtifacts(s.whyItMatters) || '',
    source_url: s.sourceUrl || '',
    source_label: s.sourceLabel || '',
    source_verified: sourceVerified,
    event_at: toEventIso(s.eventDate),
    who_to_approach: stripAiArtifacts(s.whoToApproach) || '',
    intro_message: stripAiArtifacts(s.introMessage) || '',
    candidate_angle: stripAiArtifacts(s.candidateAngle) || '',
    bench_strength_angle: stripAiArtifacts(s.benchStrengthAngle) || '',
    candidate_profile: sanitizeCandidateProfile(s.candidateProfile),
    contact_name: contact?.name || null,
    contact_title: contact?.title || null,
    contact_linkedin_url: contact?.linkedin_url || null,
    contact_email: contact?.email || null,
    contact_verified: !!contact,
    // Populated only via the multi-function fallback above — a single
    // verified contact and a multi-contact panel are mutually exclusive on
    // any one signal, never both at once, so the frontend only ever needs
    // to render whichever one is actually present.
    contact_candidates: contactCandidates.length ? contactCandidates : null,
    // What roles this funding/expansion signal likely means the company
    // will be hiring for — the structured counterpart to candidate_angle,
    // used to introduce the multi-contact panel above with something more
    // concrete than a bare list of names ("they'll likely be hiring for
    // product, engineering and commercial — here's who to reach in each").
    likely_roles: sanitizeStringList(s.likelyRoles, 5),
    title_keywords: Array.isArray(s.titleKeywords) ? s.titleKeywords.slice(0, 6) : [],
    ch_verified: !!chVerification,
    ch_verified_detail: chVerification?.detail || null,
    dedup_key: normalizeKey(s.company, s.headline, s.sourceUrl),
    status: 'new',
  }
}

// Runs `fn` over `items` with at most `limit` in flight at once, resolving
// to an array in the SAME order as `items` regardless of finishing order.
// Plain code, no library — the concurrency need here is small and narrow
// enough not to justify a dependency.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return results
}

// Runs buildEnrichedSignalRow across every entry, in parallel where it's
// actually safe to do so. Before this, both scan files' row-building loops
// ran one entry fully to completion (enrichCompany → verifyContact, at
// least one Apollo round trip each) before starting the next — pure wall-
// clock waste once MAX_TOTAL_SIGNALS was raised this session, since most
// entries are for entirely unrelated companies with no dependency on each
// other.
//
// Entries are grouped by company and each company's own entries are run
// strictly in order within their group — this is the part that has to stay
// sequential. Two live_job entries for the SAME company (exactly the
// scenario Live Jobs introduces) must not both race a cache miss on
// verifyContact's company-level contact cache and both spend an Apollo
// credit; running the same company's entries one after another guarantees
// the second one always sees the first one's cache write. Different
// companies have no such dependency, so those groups run concurrently.
//
// Output order becomes "grouped by company" rather than strict input order
// — harmless, since the result is only ever used as a set for a bulk
// upsert, never rendered in array order.
export async function buildEnrichedSignalRows(entries, { userId, apolloKey, companiesHouseKey, supabase, logPrefix, concurrency = 4, locationHints = [] }) {
  const groups = new Map()
  for (const s of entries) {
    const key = normalizeCompanyKey(s.company)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }

  const groupRows = await mapWithConcurrency([...groups.values()], concurrency, async (group) => {
    const rows = []
    for (const s of group) {
      rows.push(await buildEnrichedSignalRow(s, { userId, apolloKey, companiesHouseKey, supabase, logPrefix, locationHints }))
    }
    return rows
  })

  return groupRows.flat()
}


// Regional trade-press directory: real, named sources per market, checked
// directly (not assumed from training data) on 2026-08-25 against Annie's
// own sector taxonomy, so the AI's own web search gets a genuine head start
// per market instead of guessing what's out there — the same role
// Adzuna/Apollo's lead lists already play for live jobs, just for the
// press/deal-data landscape instead. Keyed on the exact LOCATIONS values
// from Onboarding.jsx's picker so a customer's selected market maps
// directly to a hint with no fuzzy matching needed. "Global" has no entry
// on purpose — it isn't a real regional press ecosystem, and buildRegionalSourceHint
// below silently skips any location with no matching key rather than
// inventing something for it.
export const REGIONAL_SOURCE_DIRECTORY = {
  'UAE / GCC': {
    general: ['Zawya', 'AGBI', 'Arabian Business', 'Gulf Business'],
    sectors: {
      'Financial Services': 'Fintech News UAE (fintechnews.ae)',
      Technology: 'TahawulTech, Wamda',
      Law: 'Legal 500 Middle East',
      Healthcare: 'AGBI Health, Omnia Health',
      'Energy & Utilities': 'MEES (Middle East Economic Survey)',
      'Real Estate': 'MEED, Construction Week',
      'Consumer & Retail': 'Hotelier Middle East',
      Industrial: 'MEED, Construction Week',
      'Management Consulting': 'Consultancy-me.com',
      'Private Equity': 'MAGNiTT',
      'Government & Public Sector': 'WAM (Emirates News Agency)',
    },
    registries: "ADGM (adgm.com/media, adgm.com/public-registers) and DIFC (difc.com/whats-on/news) — a company newly registering with either free zone is itself a genuine expansion signal, particularly for Financial Services, Private Equity and Management Consulting.",
  },
  'United Kingdom': {
    general: ['Financial Times', 'Reuters UK', 'TheBusinessDesk.com', 'Insider Media'],
    sectors: {
      'Financial Services': 'Financial News London (efinancialnews.com)',
      Technology: 'UKTN (uktech.news)',
      Law: 'The Lawyer',
      Healthcare: 'HSJ (Health Service Journal)',
      'Energy & Utilities': 'Utility Week',
      'Real Estate': 'Property Week',
      'Consumer & Retail': 'Retail Week',
      Industrial: "Insider Media's manufacturing vertical",
      'Management Consulting': 'Consultancy.uk',
      'Private Equity': 'Unquote',
      'Government & Public Sector': 'Civil Service World',
    },
    registries: 'Companies House (already used elsewhere in this product to verify leadership changes) is also worth a direct check for brand new incorporations as an expansion signal.',
  },
  Europe: {
    general: ['Sifted', 'Tech.eu', 'EU-Startups', 'Politico Europe', 'Euractiv'],
    sectors: {
      'Financial Services': 'Finextra',
      Technology: 'Sifted',
      Law: 'The Global Legal Post — Europe',
      Healthcare: 'pharmaphorum',
      'Energy & Utilities': 'Montel News',
      'Real Estate': 'IPE Real Assets — Europe',
      'Consumer & Retail': 'RetailDetail EU',
      Industrial: 'Industry Europe',
      'Management Consulting': 'Consultancy.eu',
      'Private Equity': 'Unquote',
      'Government & Public Sector': 'Politico Europe, Euractiv',
    },
    registries: null,
  },
  'United States': {
    general: ['Reuters', 'Bloomberg', 'Axios Business'],
    sectors: {
      'Financial Services': 'American Banker',
      Technology: 'TechCrunch',
      Law: 'Law360',
      Healthcare: 'Modern Healthcare',
      'Energy & Utilities': 'Utility Dive',
      'Real Estate': 'The Real Deal',
      'Consumer & Retail': 'Retail Dive',
      Industrial: 'ENR for construction/infrastructure, IndustryWeek for manufacturing',
      'Management Consulting': 'Consulting Magazine',
      'Private Equity': 'Axios Pro Rata',
      'Government & Public Sector': 'GovExec, Route Fifty',
    },
    registries: null,
  },
  'Asia Pacific': {
    general: ['Nikkei Asia', 'South China Morning Post Business', 'DealStreetAsia'],
    sectors: {
      'Financial Services': 'Regulation Asia',
      Technology: 'Tech in Asia',
      Law: 'Asian Legal Business',
      Healthcare: 'Healthcare Asia Magazine',
      'Energy & Utilities': 'Asian Power',
      'Real Estate': 'Mingtiandi',
      'Consumer & Retail': 'Inside Retail Asia',
      'Management Consulting': 'Consultancy.asia',
      'Private Equity': 'AVCJ, DealStreetAsia',
      'Government & Public Sector': 'GovInsider',
    },
    registries: null,
  },
}

// Composes a compact, named-source hint for the scan prompt — deliberately
// short (a source list, not the full research behind it) since this is one
// paragraph among many in an already-long prompt. Only ever mentions a
// market the customer actually selected, and only ever a sector they
// actually placed into, so a Technology-only recruiter in the UK isn't
// handed eight irrelevant trade titles for sectors they never picked.
// `learned` (optional, from getLearnedSources below) layers in whatever
// Annie has discovered on her own since this was last hand-curated — see
// that function's header for why this grows over time instead of staying
// fixed at today's names.
export function buildRegionalSourceHint(locations, sectors, learned) {
  const parts = (locations || []).map(loc => {
    const dir = REGIONAL_SOURCE_DIRECTORY[loc]
    if (!dir) return null
    const sectorLines = (sectors || [])
      .map(s => (dir.sectors[s] ? `${s} → ${dir.sectors[s]}` : null))
      .filter(Boolean)
    const bits = [`general: ${dir.general.join(', ')}`]
    if (sectorLines.length) bits.push(`sector-specific: ${sectorLines.join('; ')}`)
    if (dir.registries) bits.push(dir.registries)
    return `${loc} — ${bits.join('. ')}.`
  }).filter(Boolean)

  const learnedSourceLines = (sectors || [])
    .map(s => (learned?.sources?.[s]?.length ? `${s} → ${learned.sources[s].join(', ')}` : null))
    .filter(Boolean)
  const learnedCompanyLines = (sectors || [])
    .map(s => (learned?.companies?.[s]?.length
      ? `${s} → ${learned.companies[s].slice(0, 30).join(', ')}${learned.companies[s].length > 30 ? ', and others already tracked' : ''}`
      : null))
    .filter(Boolean)

  if (!parts.length && !learnedSourceLines.length && !learnedCompanyLines.length) return ''

  let out = ''
  if (parts.length) {
    out += `\nNamed regional sources worth checking directly, not just generic search, since these carry richer BD signal than a blind web search often surfaces on their own:\n${parts.join('\n')}\n`
  }
  if (learnedSourceLines.length) {
    out += `\nAnnie has also learned these additional sources from past scans, worth checking the same way as the named ones above:\n${learnedSourceLines.join('\n')}\n`
  }
  if (learnedCompanyLines.length) {
    out += `\nNotable, previously-confirmed active players Annie already knows about in these sectors and markets — don't limit yourself to only these, but do check whether any have fresh news too, so real coverage isn't always the same handful of famous names:\n${learnedCompanyLines.join('\n')}\n`
  }
  out += `\nAnnie's own knowledge here should keep growing the way a human researcher's would: while searching, if you come across a genuinely good, specific website worth checking again on future scans for one of this customer's sectors (not a generic search-results aggregator), or a real, active, notable company in one of these sectors and markets that isn't already named anywhere above, report it as an "annie_learned" entry (see the output format below — kind "source" or "company" respectively) so it's remembered for next time instead of being rediscovered from scratch on every scan.\n`
  return out
}

// Live-job board directory, parallel to REGIONAL_SOURCE_DIRECTORY above but
// for job boards specifically rather than press/deal-data. Adzuna (a real,
// live jobs API, see ADZUNA_COUNTRY_MAP) only actually matches two of the
// six location options on Onboarding.jsx's picker — United Kingdom and
// United States — every other market a customer can select needs the AI's
// own web search pointed at real, named boards instead of a blind search,
// the same reason REGIONAL_SOURCE_DIRECTORY exists for press.
//
// 2026-08-25: this used to be one hardcoded paragraph in each scan prompt
// that only ever named GCC boards (Bayt, GulfTalent, NaukriGulf, Dubizzle
// Jobs), unconditionally, for every customer regardless of which markets
// they actually selected — a UK-only account was being told to search Bayt
// and GulfTalent on every single scan, and a Europe or Asia Pacific
// customer (also uncovered by Adzuna) got no named boards at all, just a
// generic "search the careers page and LinkedIn" fallback. This directory
// and buildLiveJobBoardHint below fix both: keyed on the exact LOCATIONS
// values from Onboarding.jsx, same as REGIONAL_SOURCE_DIRECTORY, so the
// hint only ever names boards for markets this customer actually picked,
// and now has real entries for Europe and Asia Pacific too. United Kingdom
// and United States have no entry here on purpose — Adzuna already covers
// them with real, live postings. "Global" has no entry for the same reason
// REGIONAL_SOURCE_DIRECTORY skips it — there's no single "Global" job-board
// ecosystem to name; see the location-coverage discussion elsewhere for
// what (if anything) to do about a Global-only customer.
export const LIVE_JOB_BOARD_DIRECTORY = {
  'UAE / GCC': {
    general: ['Bayt', 'GulfTalent', 'NaukriGulf', 'Dubizzle Jobs'],
    sectors: {
      'Financial Services': 'eFinancialCareers',
      'Consumer & Retail': 'Hosco, Caterer Middle East (hospitality roles)',
    },
    govPortal: 'MOHRE Careers / Dubai Careers / Tamm — official UAE government job portals; many public-sector openings never appear on a general board at all.',
  },
  Europe: {
    // Otta was acquired by and rebranded into Welcome to the Jungle in
    // 2024 — named this way, not "Otta", so the AI's search actually finds
    // the live site rather than a defunct brand.
    general: ['Welcome to the Jungle (formerly Otta)', 'StepStone', 'Xing Jobs'],
    sectors: {
      'Financial Services': 'eFinancialCareers',
    },
    govPortal: 'EURES — the official EU/EEA public employment portal; a genuine free government source, many roles never appear anywhere else.',
  },
  'Asia Pacific': {
    // Seek's own group now operates JobStreet/JobsDB directly (confirmed,
    // not assumed) rather than them being separate competing boards, named
    // this way so the AI doesn't waste a search treating them as distinct.
    general: ['Seek (Australia/NZ — also operates JobStreet and JobsDB across Southeast Asia)', 'Naukri.com (India)', 'Boss Zhipin, Zhaopin, 51job (China)'],
    sectors: {},
    govPortal: "MyCareersFuture — Singapore's official government-backed job portal, free to search.",
  },
}

// Same composition idea as buildRegionalSourceHint, for job boards instead
// of press. Deliberately only ever surfaces a market the customer actually
// selected and (for the sector-specific line) a sector they actually placed
// into, for the same reason buildRegionalSourceHint does.
export function buildLiveJobBoardHint(locations, sectors) {
  const parts = (locations || []).map(loc => {
    const dir = LIVE_JOB_BOARD_DIRECTORY[loc]
    if (!dir) return null
    const sectorLines = (sectors || [])
      .map(s => (dir.sectors[s] ? `${s} → ${dir.sectors[s]}` : null))
      .filter(Boolean)
    const bits = [`recognised regional job boards (${dir.general.join(', ')})`]
    if (sectorLines.length) bits.push(`sector-specific boards worth checking too: ${sectorLines.join('; ')}`)
    if (dir.govPortal) bits.push(dir.govPortal)
    return `${loc} — ${bits.join('. ')}.`
  }).filter(Boolean)

  if (!parts.length) return ''
  return `\n${parts.join('\n')}\n`
}

// Named firm-tier anchors for the two sectors (25 Aug 2026, Michael) where "check the
// company's own careers page" is worth doing proactively for known major players,
// not only reactively once a firm shows up as a funding/expansion signal — a Big 4
// or Magic Circle firm posting a senior opening is itself a BD-relevant event even
// with no separate news trigger. Deliberately NOT an exhaustive list: anchors are
// the seed data in annie_learned_sources (kind='company', found_via='seed') — the
// starting handful of firms too obvious to risk missing — and discoveryHint points
// Annie at the same authoritative ranking source Michael named (consultancy-me.com)
// or its legal equivalent (Legal 500 / Chambers and Partners) to find the rest,
// spanning big firms down to boutique ones, for whichever markets this customer
// actually selected. getLearnedSources/recordLearnedDiscoveries below are what
// actually grow this list past its seed over time, so it doesn't need to be
// maintained by hand as firms merge, rebrand or open new offices.
export const TARGET_FIRM_DIRECTORY = {
  'Management Consulting': {
    anchors: ['Deloitte', 'PwC', 'EY', 'KPMG', 'Accenture', 'McKinsey & Company', 'Boston Consulting Group (BCG)', 'Bain & Company', 'Oliver Wyman', 'Kearney', 'Strategy&'],
    discoveryHint: "Beyond these firms, use consultancy-me.com's own directory and rankings as the authority on who else is active — it names Tier 2 and boutique consulting firms too, not just the largest ones — for this customer's selected markets (for UAE/GCC specifically), or the equivalent named regional trade press already listed above for other markets, then check those firms' own career pages the same way.",
  },
  Law: {
    anchors: ['Clifford Chance', 'Linklaters', 'Freshfields Bruckhaus Deringer', 'A&O Shearman', 'Slaughter and May', 'Kirkland & Ellis', 'Latham & Watkins', 'Skadden Arps'],
    discoveryHint: 'Beyond these global firms, use Legal 500 and Chambers and Partners\' own regional rankings as the authority on who else is active in this customer\'s selected markets — both rank firms across every tier, global elite down to national and boutique, not just the largest names — then check those firms\' own career pages the same way.',
  },
}

// Composes the proactive firm-tier check-list for the prompt, mirroring
// buildRegionalSourceHint's shape and only-what-they-selected discipline —
// only fires for a customer who actually selected Management Consulting
// and/or Law, so nobody else's prompt grows for a mechanism they don't use.
// `learned` layers in every firm Annie has already discovered beyond the
// seed anchors (see getLearnedSources) so the list actually reflects big
// firms down to boutique ones as it grows, not just the original seed.
export function buildTargetFirmHint(sectors, learned) {
  const parts = (sectors || []).map(sector => {
    const dir = TARGET_FIRM_DIRECTORY[sector]
    const learnedNames = learned?.companies?.[sector] || []
    const names = [...new Set([...(dir?.anchors || []), ...learnedNames])]
    if (!dir || !names.length) return null
    return `${sector} — firms worth checking directly regardless of whether they've come up as a signal yet (${names.length} tracked so far, seed anchors plus everything discovered since): ${names.join(', ')}. ${dir.discoveryHint}`
  }).filter(Boolean)
  if (!parts.length) return ''
  return `\nThis customer targets a sector with well-known major players, so proactively check these specific firms' own career pages too, the same way as the per-company follow-up check above, rather than waiting for them to surface as a signal first:\n${parts.join('\n')}\nThis list should keep growing: if you find a real, verifiable firm active in this customer's markets on the named ranking source above, big or boutique, that isn't already in this list, report it as an "annie_learned" entry (kind "company", see the output format below) so it's added for next time — this is exactly how the list above grew past its original starting set.\n`
}

// Reads Annie's own growing research memory (25 Aug 2026, Michael) — companies
// and sources she's learned are worth checking for a sector/market, seeded
// with a handful of obvious names (see TARGET_FIRM_DIRECTORY) and grown every
// scan via recordLearnedDiscoveries below, the actual mechanism behind "Annie
// should evolve and get better the way a human researcher would" rather than
// staying fixed at whatever was hand-curated on a given day. Deliberately
// global/shared across every account, not per-customer: which law firms or
// which trade site covers a market is an objective fact, not a customer
// opinion, so one account's discovery benefits every other account
// researching the same sector/market — the same reasoning company_contacts
// already uses for verified contacts. Capped per sector so a sector that's
// been scanned for months doesn't grow into an unbounded prompt.
const LEARNED_PER_SECTOR_CAP = 100

export async function getLearnedSources(supabase, sectors, locations) {
  const empty = { companies: {}, sources: {} }
  if (!supabase || !sectors?.length) return empty
  try {
    const locs = [...new Set([...(locations || []), 'Global'])]
    const { data, error } = await supabase
      .from('annie_learned_sources')
      .select('kind, sector, value')
      .in('sector', sectors)
      .in('location', locs)
      .order('first_seen_at', { ascending: true })
      .limit(2000)
    if (error || !data) return empty
    const result = { companies: {}, sources: {} }
    for (const row of data) {
      const bucket = row.kind === 'source' ? result.sources : result.companies
      if (!bucket[row.sector]) bucket[row.sector] = []
      if (bucket[row.sector].length < LEARNED_PER_SECTOR_CAP && !bucket[row.sector].includes(row.value)) {
        bucket[row.sector].push(row.value)
      }
    }
    return result
  } catch (err) {
    console.error('[scanShared] failed to read annie_learned_sources', err.message)
    return empty
  }
}

// Pulls "annie_learned" entries (see buildScanPrompt's third entryType in
// both scan-now-background.js and intelligence-scan.js) out of a raw
// `found` array before it reaches mergeSignals/dropGenericHiringWhereLiveJobsExist
// — those entries have no company/headline pair, so downstream signal
// processing would otherwise just silently drop them instead of them
// getting recorded via recordLearnedDiscoveries below. One shared
// implementation so both scan files agree on exactly what an
// "annie_learned" entry looks like.
export function splitLearnedEntries(found) {
  const learned = []
  const rest = []
  for (const entry of found || []) {
    if (entry?.entryType === 'annie_learned') learned.push(entry)
    else rest.push(entry)
  }
  return { learned, rest }
}

// Writes new companies/sources Annie found this scan back to the shared
// table above so her list keeps growing — this is the actual "evolve and
// get better" half of the mechanism, not just a one-time seed. Silently
// deduplicates via the table's own unique constraint (ignoreDuplicates),
// so re-discovering "Deloitte" for the hundredth time is a cheap no-op
// rather than a growing pile of duplicate rows.
export async function recordLearnedDiscoveries(supabase, entries) {
  if (!supabase || !entries?.length) return
  const rows = entries
    .filter(e => e?.kind && e?.sector && e?.value)
    .map(e => ({
      kind: e.kind,
      sector: e.sector,
      location: e.location || 'Global',
      value: e.value,
      value_key: normalizeCompanyKey(e.value),
      found_via: e.foundVia || 'discovered',
    }))
  if (!rows.length) return
  try {
    const { error } = await supabase
      .from('annie_learned_sources')
      .upsert(rows, { onConflict: 'kind,sector,location,value_key', ignoreDuplicates: true })
    if (error) console.error('[scanShared] failed to record learned discoveries', error.message)
  } catch (err) {
    console.error('[scanShared] failed to record learned discoveries', err.message)
  }
}

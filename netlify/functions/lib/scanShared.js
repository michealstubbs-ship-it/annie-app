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
import { looksLikeStaffingAgencyName, isStaffingAgencyIndustry, looksLikeCommunityOrGroupName } from '../../../src/lib/agencyMatch.js'
import { reportServerError } from './reportError.js'
import { parseIntEnv } from './env.js'

// Re-exported so every existing backend caller (scan-now-background.js,
// intelligence-scan.js) keeps importing these from here unchanged — both
// now live in src/lib because they're genuinely shared with the frontend
// too, not backend-only. See jsonExtract.js, signalTypes.js and
// textSanitize.js for why.
export { extractJson, SIGNAL_TYPES, stripAiArtifacts, looksLikeStaffingAgencyName, isStaffingAgencyIndustry, looksLikeCommunityOrGroupName }

// 2026-08-26, Michael: built while investigating whether raising
// anthropicMaxTokens (see SCAN_TIER_CONFIG in entitlements.js) would
// actually improve data completeness, or just cost more for no real
// benefit. extractJson requires a BALANCED, fully-closed JSON array to
// parse at all (see its own header in src/lib/jsonExtract.js) — if
// Claude's response gets cut off mid-array because it hit max_tokens
// before finishing, extractJson doesn't return a partial result, it
// returns [] and looks IDENTICAL in the logs to "genuinely found
// nothing". This tells the two apart after the fact: a response that
// contains a real, unclosed '[' but never resolves to a parseable array is
// almost certainly a max_tokens truncation, not an empty result. Used only
// for logging/diagnosis — never changes what gets returned to the caller —
// so Michael can see from production logs, going forward, how often this
// is actually happening rather than relying on the schema-based estimate
// this change shipped with.
export function looksTruncatedByTokenLimit(rawText) {
  const text = (rawText || '').trim()
  if (!text || text.startsWith('[') === false) return false
  if (extractJson(text).length > 0) return false // parsed fine, not truncated
  // A genuinely empty result ("nothing good found") is a short, clean
  // `[]` — that's caught by extractJson succeeding above. Anything left at
  // this point has an opening bracket but never resolved to valid JSON;
  // require enough length to rule out a stray '[' inside a short "no
  // results" narration Claude ignored the "JSON only" instruction for.
  return text.length > 200
}

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
//
// 2026-08-31: raised from 60 to 120 after sampling production funding
// signals with a null event_at against their real source URLs. Several were
// genuine, correctly-dated funding rounds (Stitch/a16z, Arib/wamda,
// CargoX/agbi) whose source articles were published 85-115 days before the
// scan found them — the model's eventDate was accurate, but the old 60-day
// cutoff discarded it anyway. Funding/M&A news routinely gets picked up by
// roundups and trend pieces months after the original announcement, so
// "old source article" isn't the same signal as "hallucinated date" — a
// wider, still-bounded window separates those two cases better than the
// original one did — the news being new to the recruiter is still real
// value even when the underlying event isn't from this week.
const MAX_EVENT_AGE_DAYS = 120

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
//
// 2026-09-04: `billable` added. A client-side timeout is NOT evidence that the
// request failed at the other end — fetchWithTimeout aborts locally after
// timeoutMs, but the provider may have already accepted, processed and
// INVOICED the call. Retrying it then buys the same billed work a second and
// third time. That mattered most for TheirStack, where one search returns (and
// charges for) ten job records against a single ten-credit reservation: a
// search that completed server-side in 13s was aborted at 12s, retried twice,
// and could bill thirty records while the refund at the call site was computed
// from only the last response. Apollo's people/match has the same shape at one
// credit a go. Genuine HTTP responses (429/5xx) are still retried on billable
// calls, because those are the provider explicitly telling us it did no work.
export async function fetchWithRetry(url, options = {}, timeoutMs = 12000, retries = 2, { billable = false } = {}) {
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, options, timeoutMs)
      if (resp.ok || (resp.status < 500 && resp.status !== 429)) return resp
      lastErr = new Error(`HTTP ${resp.status}`)
    } catch (err) {
      lastErr = err
      // An abort means "we stopped waiting", not "nothing happened".
      if (billable && (err?.name === 'AbortError' || /abort/i.test(err?.message || ''))) {
        console.error(`[scanShared] billable call to ${url} timed out locally after ${timeoutMs}ms — NOT retrying, the provider may already have completed and billed it`)
        throw err
      }
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
    // Same reasoning while auditing the real rows this fix touches: Indeed's
    // own single-posting convention is "/viewjob?jk=<id>" — "job" glued
    // directly onto "view" with no separator, so it can never pass a
    // word-boundary keyword check no matter how that check is written. A
    // real, well-known, stable URL shape (confirmed against this account's
    // own actual Indeed-sourced rows), trusted by host+path shape the same
    // way Adzuna is trusted by host alone above.
    if (host.includes('indeed.com') && path === '/viewjob') return true
    // 2026-09-04, Michael, follow-up: flagged rather than silently folded in
    // with the fixes above, because this is a different kind of trust
    // decision — the "job-ness" here is in the HOSTNAME (a dedicated ATS
    // candidate-facing domain), not anything in the path at all, so no
    // keyword check of any kind could ever catch these. Michael: "Yes fix
    // that". Confirmed against this account's own real rows, one per
    // platform: Lever (jobs.lever.co/{company}/{postingId}, postingId a
    // real UUID — the Aldar Properties posting), Workable's "view" form
    // (jobs.workable.com/view/{id}/{slug} — the Qiddiya Investment and
    // Janus Digital postings), and Workable's short "apply" form
    // (apply.workable.com/j/{code} — the Driven Properties and Qiddiya
    // Investment postings). Each is checked by host AND a real path shape
    // (a UUID, or the platform's own fixed prefix), not host alone — unlike
    // Adzuna above, these hostnames aren't exclusively job-posting domains
    // in the same load-bearing way, so the path shape is what actually
    // confirms "this is one specific posting" rather than the platform's
    // own company/careers landing page.
    if (host === 'jobs.lever.co' && /^\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path)) return true
    if (host === 'jobs.workable.com' && /^\/view\//.test(path)) return true
    if (host === 'apply.workable.com' && /^\/j\/[0-9a-z]+$/i.test(path)) return true
    // 2026-09-04, Michael, real report: a genuine NaukriGulf posting (real
    // job ID suffix, specific title, specific company) came through as
    // "Hiring activity" instead of "Live roles" — traced to this check
    // requiring "job"/"jobs"/"career"/etc. to sit immediately after a "/",
    // which only matches a path that STARTS with that segment
    // (/jobs/12345, /careers/xyz). NaukriGulf's own real single-posting
    // convention instead puts the job title first and folds "jobs" into
    // the middle of one long SEO slug, e.g.
    // "/investment-director-chief-investment-officer-jobs-in-doha-qatar-in-
    // ih-13-to-20-years-n-cd-368133-jid-310826001109" — a real, specific,
    // single posting (note the trailing "-jid-<id>", a genuine posting's
    // own job-id suffix) that the old anchored regex could never match, no
    // matter how real it was. Switched to a whole-word match anywhere in
    // the path — hyphens and slashes both count as word boundaries in
    // regex, so this still won't match "job" or "jobs" as a substring of
    // an unrelated word (e.g. "jobsite"), it just no longer requires that
    // word to be the very first path segment.
    return /\b(jobs?|careers?|vacanc(?:y|ies))\b/.test(path)
  } catch {
    return false
  }
}

// looksLikeStaffingAgencyName / isStaffingAgencyIndustry: see the header
// comment at the top of this file (imported from src/lib/agencyMatch.js) —
// moved there so sourcedPool.js/relationshipPool.js can apply the identical
// check as a read-time backstop, not just at write time here.

// 2026-09-02, Michael: a live_job entry at a mega-employer (Google, ADNOC,
// Emirates — thousands of employees) isn't a real BD lead even though it's
// real and easy to find: a company that size staffs almost entirely
// through its own in-house TA org and essentially never engages an
// external agency recruiter for a role like this, so surfacing it wastes
// the recruiter's attention on a contact with close to zero real chance of
// leading to a placement. Michael was explicit he can't hand-maintain a
// per-market list of which names to exclude (unlike the staffing-agency
// check above, "who's a giant" has no fixed vocabulary to pattern-match
// on) — so this is a numeric proxy instead: Apollo's own headcount
// estimate, already fetched on the exact same companies/search call
// enrichCompany makes for every entry (see that function's own header),
// just not previously captured. A single global threshold rather than a
// per-sector one, on purpose — matches the "no upkeep" requirement, and
// "runs hiring entirely in-house" is roughly the same headcount
// regardless of which sector the giant is in.
export const MEGA_EMPLOYER_HEADCOUNT_THRESHOLD = 10000

export function isMegaEmployer(employeeCount) {
  return typeof employeeCount === 'number' && employeeCount >= MEGA_EMPLOYER_HEADCOUNT_THRESHOLD
}

// 2026-09-02, Michael, follow-up audit: the mega-employer filter above only
// works if employee_count is actually populated. company_enrichment has no
// expiry — a company matched and cached BEFORE this filter shipped would
// otherwise return employees: null forever, since a cache hit short-
// circuits before ever reaching Apollo again. That's the exact class of
// company this filter exists to catch (a household name someone already
// has on file from an earlier scan), so it can't be left unfixed. See
// enrichCompany's own cache-hit check for how this is used: bounded to one
// forced re-check per company, using the ALREADY-WRITTEN enriched_at
// timestamp as "have we looked at this company since the filter existed" —
// no new column needed. Once a company is re-checked after this cutoff,
// employees: null is trusted as "Apollo genuinely has no headcount data for
// this company" and never forces another re-check.
export const EMPLOYEE_COUNT_BACKFILL_CUTOFF = new Date('2026-09-02T00:00:00Z')

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

// 2026-08-26: a shared daily Apollo/TheirStack credit cap (see
// reserveApolloCredits/reserveTheirStackCredits below) used to fail
// completely silently to everyone but someone actively reading Netlify's
// function logs — a customer whose scan got starved because ANOTHER
// customer's scan spent the whole shared budget earlier that day had no
// way to know that's what happened, and neither did Michael, unless he
// went looking. This alerts once the cap is first hit each day, not on
// every single subsequent call that fails the same already-exhausted cap
// (which could be dozens within one scan run alone) — `alertedCapsToday`
// is per-warm-instance, not persisted, so a cold start can re-alert once;
// that's an acceptable, deliberately simple tradeoff over adding a new DB
// column just to dedupe a Slack message.
const alertedCapsToday = new Set()
function alertCapHitOnce(capName, dailyCap) {
  const key = `${capName}:${new Date().toISOString().slice(0, 10)}`
  if (alertedCapsToday.has(key)) return
  alertedCapsToday.add(key)
  alertIfConfigured(`:warning: ${capName} PLATFORM-WIDE daily credit cap (${dailyCap}) reached for today — every customer's scan is now getting fewer/no contacts or live-job leads from this source until it resets at midnight UTC. Raise the cap (${capName === 'Apollo' ? 'APOLLO_DAILY_CREDIT_CAP' : 'THEIRSTACK_DAILY_CREDIT_CAP'} in Netlify) if this is happening earlier in the day than expected.`)
}

// Daily cap on Apollo.io API credits, spent from ANY call site (LinkedIn
// import enrichment, the onboarding scan, the recurring cron). Enforced
// here rather than trusted to good behaviour at each call site, because a
// bug, a retried request, or a stranger hitting an endpoint directly could
// otherwise run up an unbounded bill on a paid third-party API that has no
// ceiling of its own. See supabase-migrations/2026-08-26-per-customer-
// credit-caps.sql for the tables and the atomic reservation function this
// calls — the reservation happens in a single SQL statement, so concurrent
// calls (parallel sector-group scans, two customers' scans running at
// once) can't both read a stale total and both slip past the cap the way a
// check-then-write done in JS could.
//
// 2026-08-26, Michael: this now checks BOTH a per-customer cap and a
// platform-wide backstop, not just the platform-wide total alone — see
// that migration's header for why a single shared counter let one
// customer's scan starve every other customer's. `caps` is the
// {userDailyCap, platformDailyCap} pair resolveResourceCaps(tier).apollo
// in entitlements.js produces for the calling customer's own tier;
// callers that don't have a resolved tier (or a userId) can omit it and
// this falls back to the env-var-only platform default, same behaviour as
// before this change, just checked against nobody's personal cap. Matches
// entitlements.js's own DEFAULT_PLATFORM_CAPS.apollo exactly — the two
// used to diverge (this was 500, entitlements.js's was 1200) whenever a
// caller reached this function without going through resolveResourceCaps;
// kept in sync now so which code path a caller takes never changes the
// effective platform ceiling.
const DEFAULT_APOLLO_DAILY_CAP = 1200

export async function reserveApolloCredits(supabase, userId, credits = 1, caps = {}) {
  // No supabase client passed (e.g. a unit test calling these functions
  // directly) — fail open rather than block a context that was never meant
  // to be capped in the first place.
  if (!supabase) return true
  const platformDailyCap = caps.platformDailyCap ?? parseIntEnv(process.env.APOLLO_DAILY_CREDIT_CAP, DEFAULT_APOLLO_DAILY_CAP)
  const userDailyCap = caps.userDailyCap ?? null
  try {
    const { data, error } = await supabase.rpc('apollo_reserve_credits', {
      p_credits: credits, p_user_id: userId || null, p_user_daily_cap: userDailyCap, p_platform_daily_cap: platformDailyCap,
    })
    if (error) {
      // A DB hiccup here shouldn't take the whole scan down with it — fail
      // open, same philosophy as every other "degrade gracefully" branch in
      // this file.
      console.error('[scanShared] apollo_reserve_credits RPC failed, allowing the call through:', error.message)
      return true
    }
    if (data === 'user_cap') {
      console.log(`[scanShared] Apollo per-customer daily credit cap (${userDailyCap}) reached for user ${userId} — expected behaviour, does not affect other customers`)
      return false
    }
    if (data === 'platform_cap') {
      console.error(`[scanShared] Apollo daily credit cap (${platformDailyCap}) reached for today, skipping call`)
      alertCapHitOnce('Apollo', platformDailyCap)
      return false
    }
    if (data !== 'ok') console.error('[scanShared] apollo_reserve_credits RPC returned an unexpected value, allowing the call through:', data)
    return true
  } catch (err) {
    console.error('[scanShared] apollo_reserve_credits threw, allowing the call through:', err.message)
    return true
  }
}

// 4th-pass audit fix (2026-08-26): every Apollo call site reserves credits
// via reserveApolloCredits before making its call, but until now nothing
// ever released that reservation when the call itself failed outright — a
// timeout, a 429, a 500, an expired/rotated key, or a malformed response
// all still permanently cost credits against both the per-customer and
// platform-wide daily caps, exactly as if the call had succeeded. During a
// real Apollo outage this made the platform-wide cap exhaust FASTER than
// normal operation, throttling every other customer's genuine usage on top
// of the outage itself. Mirrors releaseTheirStackCredits exactly, except
// every real call site here reserves a flat, fixed credit count per call
// (not a variable "up to N" ceiling the way TheirStack's per-job billing
// is), so there's no partial-success reconciliation — a failed call always
// refunds the full amount it reserved. See supabase-migrations/
// 2026-08-26-apollo-credit-release.sql for the RPC. Best-effort and
// fail-silent-but-logged on purpose, same as every other cap-bookkeeping
// call in this file — a failed refund shouldn't take a scan down with it,
// it just means the cap trips a little earlier than true spend justifies
// until the next call succeeds.
export async function releaseApolloCredits(supabase, userId, credits) {
  if (!supabase || !credits || credits <= 0) return
  try {
    const { error } = await supabase.rpc('apollo_release_credits', { p_credits: credits, p_user_id: userId || null })
    if (error) console.error('[scanShared] apollo_release_credits RPC failed:', error.message)
  } catch (err) {
    console.error('[scanShared] apollo_release_credits threw:', err.message)
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

// 2026-09-01, real incident found live on Michael's own account: the same
// Fasset $68M Series C round got written as TWO separate signals —
// "Dubai fintech raises $68M Series C, hits $1B valuation" (khaleejtimes.com)
// and "Series C $68M raises fintech to unicorn status" (fasset.com) — same
// real event, two different real articles about it. normalizeKey's own
// sourceUrl-based key is exactly right for the DP World incident it was
// built for (same article, re-paraphrased headline) but structurally can't
// catch this one: two different source URLs produce two different keys no
// matter how the dedup logic slices the headline. This got much more likely
// the day the cross-industry-by-function pass shipped (2026-09-01) — two
// genuinely independent AI web searches per customer per run now, each free
// to rediscover the same real news via a different outlet.
//
// Scoped to signalType "funding" only, not every type: this is the one
// category where a real event has an unambiguous, extractable fingerprint
// independent of which article reported it — the funding round letter and
// the dollar amount. A leadership change or expansion doesn't have an
// equally reliable fact to extract from free-form AI prose without a much
// higher risk of false-merging two genuinely different events, so this
// deliberately doesn't try to generalize past the one case actually
// observed. Returns null (never a false match) unless BOTH a round and an
// amount are confidently found in the given text.
export function extractFundingSignature(text) {
  if (!text) return null
  const roundMatch = text.match(/\bseries\s*([a-e])\b/i) || text.match(/\b(seed)\b/i) || text.match(/\b(pre-seed)\b/i)
  const amountMatch = text.match(/\$\s?(\d+(?:\.\d+)?)\s*([mMbB])\b/)
  if (!roundMatch || !amountMatch) return null
  const round = roundMatch[1].toLowerCase()
  const amount = `${amountMatch[1]}${amountMatch[2].toLowerCase()}`
  return `${round}:${amount}`
}

// Fuzzy dedup key for a funding signal, or null when this entry isn't a
// funding signal or doesn't carry a confidently-extractable round+amount
// (see extractFundingSignature's own header). Checked from BOTH the
// headline and why-it-matters text since either one might carry the actual
// figures depending on how the AI phrased the headline.
export function fundingFuzzyKey(company, signalType, headline, whyItMatters) {
  if (signalType !== 'funding') return null
  const sig = extractFundingSignature(headline) || extractFundingSignature(whyItMatters)
  if (!sig) return null
  return `${normalizeCompanyKey(company)}::funding::${sig}`
}

// 2026-09-02, Michael, after seeing the real scale of this (a production
// data pull turned up 30+ duplicate groups across 7+ customer accounts,
// spanning expansion/leadership_change/m_and_a, not just funding — DIFC had
// 5 separate rows for one real AI-native-transformation story): builds the
// lookup buildSemanticDedupCandidates/filterSemanticDuplicates below need —
// every existing headline this customer already has on file for a given
// company+signal_type, grouped so a new candidate can be checked against
// exactly the prior art that could actually make it a duplicate (never
// against a different company, and never against a different signal type —
// a funding round can't be "the same event" as a leadership change).
export function buildExistingByCompanyType(existingRows) {
  const map = new Map()
  for (const r of existingRows || []) {
    if (!r?.company_name || !r?.signal_type || !r?.headline) continue
    const key = `${normalizeCompanyKey(r.company_name)}::${r.signal_type}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(r.headline)
  }
  return map
}

// Pure, free (no AI call) — which of these candidates have any existing
// headline on file for the same company+signal_type, and are therefore
// actually worth spending an AI call to compare. The overwhelming majority
// of candidates on any given run are about a company/type combo with
// nothing on file yet and can't possibly be a duplicate of anything, so
// this is the gate callers use to decide whether filterSemanticDuplicates
// below is worth calling (and worth reserving Anthropic token budget for)
// at all — see both scan files' call sites.
export function findSemanticDedupTargets(candidates, existingByCompanyType) {
  return (candidates || [])
    .map((c, i) => ({ c, i, existing: existingByCompanyType?.get(`${normalizeCompanyKey(c.company)}::${c.signalType}`) }))
    .filter(({ existing }) => existing?.length)
}

// The general-purpose successor to fundingFuzzyKey above, for every signal
// type fundingFuzzyKey can't cover. Funding has a clean, extractable fact
// (round letter + dollar amount) a regex can compare directly; expansion,
// leadership_change, and m_and_a headlines are freeform prose — "DIFC
// appoints new CFO" and "DIFC names replacement finance chief" are the same
// real event, but there's no reliable regex signature for that the way
// there is for a dollar figure. That comparison — "do these two headlines
// describe the same real thing" — is exactly the kind of judgment call an
// LLM is suited for and a hand-written heuristic isn't, so this asks Claude
// directly instead of guessing at keyword overlap.
//
// Deliberately cheap: only ever reaches the network when
// findSemanticDedupTargets found at least one real candidate to check (see
// that function's own header) — the common case (a brand-new company/type
// combo) never spends anything here. One batched call covers every
// candidate that needs checking this run, not one call per candidate. No
// web_search tool (same reasoning as personalizePoolHits above) — this is a
// closed comparison over text already in hand, never a research task.
//
// Deliberately does NOT reserve its own Anthropic token budget — same
// convention as personalizePoolHits above, and for the same reason: this
// module intentionally never imports aiUsage.js (aiUsage.js already imports
// FROM this file — alertIfConfigured — so importing back would be
// circular). Callers must check findSemanticDedupTargets and reserve
// SEMANTIC_DEDUP_MAX_TOKENS themselves before calling this, exactly the
// same shape every existing call to callAnthropic/personalizePoolHits
// already follows.
//
// Fails OPEN on any error (network, malformed response) — returns every
// candidate unfiltered rather than risk silently dropping a genuinely new
// signal because this extra check itself broke. The exact-key and fuzzy
// checks that already ran before this is called remain the hard guarantee;
// this is a best-effort improvement on top, never a required gate.
export const SEMANTIC_DEDUP_MAX_TOKENS = 1500

export async function filterSemanticDuplicates(anthropicKey, candidates, existingByCompanyType) {
  if (!anthropicKey || !candidates?.length) return candidates || []
  const targets = findSemanticDedupTargets(candidates, existingByCompanyType)
  if (!targets.length) return candidates

  const prompt = `You check whether a newly-found news item about a company is describing the SAME real-world event as one already on file for that company — just reported by a different source, in different words — not whether the companies or topics are merely similar.

For each pairing below, compare the NEW headline against the EXISTING headline(s) on file for that same company and signal type. Answer duplicate:true only when you are confident they describe the exact same real event (the same appointment, the same funding round, the same expansion announcement). A later, genuinely different event about the same company — a second funding round, a different hire, a follow-up expansion — is NOT a duplicate: answer false.

${targets.map(({ c, i, existing }) => `Pairing ${i}: NEW headline for "${c.company}" (${c.signalType}): "${c.headline}"\nEXISTING headline(s) already on file for this exact company and signal type: ${existing.map(h => `"${h}"`).join('; ')}`).join('\n\n')}

Return a JSON array, one object per pairing: { "id": <the pairing's number>, "duplicate": true or false }. Only return the JSON array, nothing else.`

  try {
    const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: SEMANTIC_DEDUP_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, 20000, 1)
    if (!resp.ok) {
      console.error('[scanShared] semantic dedup call failed:', resp.status)
      return candidates
    }
    const data = await resp.json()
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
    const parsed = extractJson(text)
    const duplicateIds = new Set((parsed || []).filter(p => p?.duplicate === true).map(p => p.id))
    return candidates.filter((c, i) => !duplicateIds.has(i))
  } catch (err) {
    console.error('[scanShared] semantic dedup call failed:', err.message)
    return candidates
  }
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

// 2026-08-26: used to count EVERY entry the AI merely labelled "live_job"
// here, before buildEnrichedSignalRow's own looksLikeJobPostingUrl check
// (further downstream, run per-entry, one entry at a time) ever got a
// chance to demote an entry whose sourceUrl doesn't actually look like a
// real posting. Net effect: a genuinely good, well-sourced hiring_activity
// entry for a company could get dropped here in favour of a same-company
// "live_job" entry that turns out, one step later, not to be verified at
// all — a real loss, and in the wrong direction (losing the entry that WAS
// good). Checking the URL shape here too, before it's allowed to suppress
// anything, closes that ordering gap.
export function dropGenericHiringWhereLiveJobsExist(entries) {
  const companiesWithLiveJobs = new Set(
    entries
      .filter(e => e.entryType === 'live_job' && looksLikeJobPostingUrl(e.sourceUrl))
      .map(e => normalizeCompanyKey(e.company))
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

// 2026-08-26, real bug found live against Michael's own account: Adzuna and
// TheirStack both used to build ONE combined [...sectorKeywords,
// ...functionKeywords] list and slice it to a flat cap — sectors always
// went in first, so any customer with enough sectors to fill the cap on
// their own (Michael has 6, which alone split into 8 fragments) got a
// search that was 100% sector words and NEVER included a single function
// word — not just their weakest function, every one of them, silently.
// verified: with the old code, none of "Strategy", "Policy", "Finance", or
// "Investment" ever reached the actual Adzuna/TheirStack query for his
// account. Interleaving instead of concatenating guarantees every customer
// gets real representation from both lists regardless of how many sectors
// or functions they picked — this is a general fix, not a Strategy-specific
// patch, since the old bug had nothing to do with which function it was.
export function buildSearchKeywords(sectors, functions, max = 6) {
  const sectorKw = (sectors || []).flatMap(splitToKeywords)
  const functionKw = (functions || []).flatMap(splitToKeywords)
  const merged = []
  for (let i = 0; merged.length < max && (i < sectorKw.length || i < functionKw.length); i++) {
    if (i < sectorKw.length && merged.length < max) merged.push(sectorKw[i])
    if (i < functionKw.length && merged.length < max) merged.push(functionKw[i])
  }
  return merged
}

// 2026-08-31, measured live against both APIs. buildSearchKeywords above is
// correct for what it was written for (an interleaved list of the customer's
// own sector/function LABELS) but it was being handed straight to Adzuna's
// and TheirStack's job-TITLE fields, which is a category error: it asked
// those APIs for job titles containing "Financial Services" or "Real
// Estate". Nobody's job title is "Financial Services".
//
// What that actually cost, verified against the real keys on 2026-08-31:
//   Adzuna     `what` ANDs every word it is given, so a realistic
//              multi-sector customer's query matched NOTHING AT ALL —
//              count: 0, zero results, every scan, silently. The UK live-job
//              source has effectively never returned anything.
//   TheirStack returned results but only ~1 in 10 was a usable executive
//              lead; the rest were Indian recruitment agencies posting
//              remote roles tagged to the UAE, "Confidential" employers and
//              junior technical roles. The scan then correctly discarded
//              them under its own agency-posted rule — which is exactly how
//              a full credit spend produces zero signals.
// Same query with real job titles plus a seniority filter: 5 of 10 usable.
//
// So this maps a customer's FUNCTIONS (the discipline they place into) to
// the job titles a senior opening in that discipline is actually advertised
// under. Keyed on functionTaxonomy.js's own parent labels — deliberately
// duplicated here as literals rather than imported, since these Netlify
// functions stay self-contained and don't reach into src/ (untested bundler
// risk). If a parent label is renamed in the taxonomy, add the new spelling
// here; an unmapped function degrades to the generic leadership titles
// below rather than breaking the scan.
//
// 2026-09-01, follow-up to the same-day functionTaxonomy.js title audit:
// each function's list only ever had 3-4 titles, all essentially the single
// most senior C-suite spelling — a real opening for "Head of Treasury" or
// "Tax Director" was never searched for at all, regardless of how broad the
// underlying job-search API's own results are, because that title string
// was simply never sent. Expanded every function to 6-7 real senior titles
// (Director/Head/VP/Chief level — never below, for the same reason as
// functionTaxonomy.js's manager-level floor: a live_job signal exists to
// surface a real BD mandate, and a junior opening isn't one) spanning that
// function's actual sub-disciplines, sourced from the same researched title
// list as functionTitleCoverage.test.js. buildJobTitleQueries' own `max`
// default moved from 4 to 6 in the same edit, below, so the extra titles
// here are actually used every scan rather than sitting unused past the old
// cap — Michael's own question when this was proposed.
// 2026-09-04, Michael, real report: his own LinkedIn Jobs feed showed several
// genuinely senior UAE postings (Rakbank, Moove, Aldar, Mashreq — VP/Director/
// Head level) that Annie never surfaced. Investigation (real production data,
// this account's own last 15 live_job signals) confirmed a second, compounding
// gap on top of the crowding-out fix above (buildScanPrompt's new
// per-function representation instruction): 11 of these 20 functions had zero
// "VP" title in their list at all, even though "VP" is one of the most
// commonly used senior-but-not-C-suite titles in the UAE/GCC market
// specifically (this account's own selected market) — so a real VP-level
// opening was never even searched for in those functions, regardless of how
// good the underlying job-search API's own coverage is. Added one VP-level
// title to every function where that rung is a genuine, common way a senior
// opening in that discipline gets advertised (skipped Healthcare & Clinical,
// General Management, Administration, and Education & Training, where the
// existing titles already cover the real senior spectrum better than
// force-fitting a "VP" spelling that discipline doesn't actually use).
export const FUNCTION_JOB_TITLES = {
  'Strategy & Corporate Development': ['Chief Strategy Officer', 'Head of Strategy', 'Strategy Director', 'Corporate Development Director', 'Head of M&A', 'Director of Business Transformation', 'VP Strategy'],
  'Policy & Government Affairs': ['Head of Public Affairs', 'Director of Government Relations', 'Head of Policy', 'Regulatory Affairs Director', 'Government Relations Director', 'Director of Public Policy', 'VP Government Affairs'],
  'HSE, Sustainability & Quality': ['Head of HSE', 'HSE Director', 'Head of Sustainability', 'Director of Sustainability', 'Director of ESG', 'Head of Quality', 'VP Sustainability'],
  'Construction & Built Environment': ['Project Director', 'Construction Director', 'Development Director', 'Head of Projects', 'Head of Construction', 'Design Director', 'VP Development'],
  'Healthcare & Clinical': ['Chief Medical Officer', 'Medical Director', 'Director of Nursing', 'Head of Clinical Services', 'Chief Nursing Officer', 'Head of Clinical Operations'],
  'Finance & Accounting': ['Chief Financial Officer', 'Finance Director', 'Head of Finance', 'Financial Controller', 'Head of Treasury', 'Tax Director', 'VP Finance'],
  'HR & People': ['Chief People Officer', 'HR Director', 'Head of Talent', 'Director of Human Resources', 'Head of Talent Acquisition', 'VP of Human Resources'],
  'Legal & Compliance': ['General Counsel', 'Head of Legal', 'Head of Compliance', 'Legal Director', 'Chief Compliance Officer', 'Head of Regulatory Affairs', 'VP Legal'],
  'Sales & Business Development': ['Chief Commercial Officer', 'Sales Director', 'Commercial Director', 'Head of Business Development', 'VP of Sales', 'Head of Partnerships'],
  'Marketing, Communications & Creative': ['Chief Marketing Officer', 'Marketing Director', 'Head of Communications', 'Brand Director', 'VP of Marketing', 'Director of Digital Marketing'],
  'Operations & Supply Chain': ['Chief Operating Officer', 'Operations Director', 'Head of Supply Chain', 'Head of Operations', 'VP of Operations', 'Director of Logistics'],
  'Technology, Data & Engineering': ['Chief Technology Officer', 'Chief Information Officer', 'Head of Engineering', 'Head of Data', 'VP Engineering', 'Cybersecurity Director'],
  'Investment & Asset Management': ['Chief Investment Officer', 'Head of Investments', 'Investment Director', 'Portfolio Director', 'Head of Research', 'Head of Wealth Management', 'VP Investments'],
  'Risk & Audit': ['Chief Risk Officer', 'Head of Risk', 'Head of Internal Audit', 'Audit Director', 'Head of Credit Risk', 'Head of Financial Crime', 'VP Risk'],
  'Manufacturing & Production': ['Manufacturing Director', 'Plant Director', 'Production Director', 'Head of Manufacturing', 'VP of Manufacturing', 'Director of Continuous Improvement'],
  'Real Estate, Facilities & Hospitality': ['Head of Real Estate', 'Facilities Director', 'Asset Management Director', 'General Manager', 'Director of Asset Management', 'Regional Director of Operations', 'VP Real Estate'],
  'General Management / Executive Leadership': ['Chief Executive Officer', 'Managing Director', 'Chief Operating Officer', 'General Manager', 'President', 'Country Manager'],
  'Administration & Office Support': ['Head of Administration', 'Head of Business Support', 'Office Director', 'Director of Administrative Services'],
  'Customer Service & Success': ['Chief Customer Officer', 'Head of Customer Success', 'Customer Experience Director', 'VP of Customer Success', 'Director of Customer Support'],
  'Education & Training': ['Director of Education', 'Head of Learning and Development', 'Academic Director', 'Dean', 'Provost'],
}

// The fallback when a customer's function isn't in the map above (a renamed
// taxonomy label, or a customer who selected no functions at all). Senior
// generalist titles, so the scan still asks a sensible question rather than
// falling back to the sector-label behaviour this whole block exists to fix.
// Expanded to 6 (2026-09-01) in step with the buildJobTitleQueries default
// max moving from 4 to 6, so the no-function-selected case gets the same
// broadened title-query budget every mapped function now gets.
export const GENERIC_LEADERSHIP_TITLES = ['Chief Executive Officer', 'Managing Director', 'Chief Financial Officer', 'Chief Operating Officer', 'General Manager', 'President']

// TheirStack's own enum, confirmed live 2026-08-31 by sending a deliberate
// bad value and reading the validation error back: 'c_level', 'staff',
// 'senior', 'junior', 'mid_level'. Only the top three are BD-relevant for an
// executive search firm — a junior or mid-level opening is not a mandate.
export const THEIRSTACK_SENIORITIES = ['c_level', 'staff', 'senior']

// Onboarding stores a function as either a bare parent label ('Finance &
// Accounting') or 'Parent > Sub' ('Finance & Accounting > Financial
// Control'). Both resolve to the same parent here, because the job titles a
// discipline advertises under don't change with the sub-speciality.
export function functionParentLabel(value) {
  const raw = (value || '').trim()
  if (!raw) return ''
  const gt = raw.indexOf('>')
  return (gt === -1 ? raw : raw.slice(0, gt)).trim()
}

// Turns the customer's selected functions into real job titles to search
// for. Interleaved across functions, not concatenated, for exactly the
// reason buildSearchKeywords interleaves: a customer who picked four
// functions must get their fourth one represented, not have the first one
// fill the cap on its own. Deduplicated, because several disciplines
// legitimately share a title (Chief Operating Officer sits under both
// Operations and General Management).
//
// Default max raised 4 -> 6 (2026-09-01), in the same edit that expanded
// FUNCTION_JOB_TITLES/GENERIC_LEADERSHIP_TITLES to 6-7 titles each — moving
// one without the other would have meant curating broader per-function
// title coverage that never actually got queried, capped out by this
// number before the new titles were ever reached. This is the title-QUERY
// cap only (how many distinct title strings get searched for) — it does
// not change how many results come back per source; that's each caller's
// own separate cap (10 for Adzuna/TheirStack, 8 for Apollo).
export function buildJobTitleQueries(functions, max = 6) {
  const perFunction = []
  const seenFn = new Set()
  for (const value of functions || []) {
    const parent = functionParentLabel(value)
    if (!parent || seenFn.has(parent)) continue
    seenFn.add(parent)
    const titles = FUNCTION_JOB_TITLES[parent]
    if (titles?.length) perFunction.push(titles)
  }
  if (!perFunction.length) perFunction.push(GENERIC_LEADERSHIP_TITLES)

  const out = []
  const seen = new Set()
  for (let i = 0; out.length < max && perFunction.some(list => i < list.length); i++) {
    for (const list of perFunction) {
      if (out.length >= max) break
      const title = list[i]
      if (!title) continue
      const key = title.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(title)
    }
  }
  return out
}

// 2026-09-01, Michael: FUNCTION_JOB_TITLES above only gives 4 senior titles
// per function — enough to query a job-title API, but too thin for the AI
// web-search pass to actually understand a function's real breadth (e.g.
// "Finance & Accounting" covers FP&A, Treasury, and Tax just as much as it
// covers a CFO; "Technology, Data & Engineering" covers Cybersecurity, Data
// & Analytics, and Product just as much as Software Engineering) — a search
// that only ever reasons about the 4 C-suite-level titles misses everything
// under them. Mirrors src/lib/functionTaxonomy.js's own subSectors labels
// for each of the same 20 parent functions — same "duplicated here as
// literals, not imported" reasoning as FUNCTION_JOB_TITLES above (these
// Netlify functions stay self-contained, no reach into src/). If
// functionTaxonomy.js's sub-labels change, update here too.
export const FUNCTION_SUBDISCIPLINES = {
  'Strategy & Corporate Development': ['Corporate Strategy', 'M&A & Corporate Development', 'Chief of Staff', 'Business Planning & Transformation'],
  'Policy & Government Affairs': ['Public Policy', 'Government Relations', 'Regulatory Affairs', 'Public Affairs & Advocacy'],
  'HSE, Sustainability & Quality': ['Health & Safety', 'Environmental Management', 'Sustainability & ESG', 'Quality Assurance & Control'],
  'Construction & Built Environment': ['Civil & Structural Engineering', 'Project & Programme Management', 'Architecture & Design', 'MEP Engineering', 'Site Management & Quantity Surveying'],
  'Healthcare & Clinical': ['Clinical & Medical', 'Nursing', 'Allied Health', 'Healthcare Administration', 'Pharma & Life Sciences'],
  'Finance & Accounting': ['Financial Planning & Analysis (FP&A)', 'Accounting & Controllership', 'Treasury', 'Tax'],
  'HR & People': ['Talent Acquisition', 'HR Business Partnering', 'Compensation & Benefits', 'Learning & Development', 'People Operations'],
  'Legal & Compliance': ['In-house Counsel', 'Compliance', 'Regulatory', 'Contracts'],
  'Sales & Business Development': ['Sales', 'Business Development', 'Account Management', 'Partnerships & Alliances'],
  'Marketing, Communications & Creative': ['Brand & Marketing', 'Digital Marketing', 'PR & Communications', 'Content & Creative'],
  'Operations & Supply Chain': ['Operations Management', 'Supply Chain', 'Logistics', 'Procurement & Sourcing'],
  'Technology, Data & Engineering': ['Software Engineering', 'IT Infrastructure', 'Cybersecurity', 'Product Management', 'Data & Analytics'],
  'Investment & Asset Management': ['Portfolio Management', 'Private Equity & Venture Capital', 'Investment Research & Analysis', 'Wealth Management'],
  'Risk & Audit': ['Risk Management', 'Internal Audit', 'Credit Risk', 'Financial Crime & AML'],
  'Manufacturing & Production': ['Production Management', 'Manufacturing Engineering', 'Plant Management'],
  'Real Estate, Facilities & Hospitality': ['Property & Real Estate Management', 'Facilities Management', 'Hospitality & Hotel Management', 'Events'],
  'General Management / Executive Leadership': ['C-Suite', 'Managing Director / General Manager', 'Board & Non-Executive'],
  'Administration & Office Support': ['Executive & Personal Assistant', 'Office Management'],
  'Customer Service & Success': ['Customer Success', 'Customer Support', 'Client Services'],
  'Education & Training': ['Teaching & Academia', 'Corporate Training', 'Instructional Design'],
}

// Turns the customer's selected functions into a plain-language breadth hint
// for the AI web-search prompt — "X includes: sub, sub, sub" per function —
// so a search for "Finance & Accounting" signals doesn't collapse into only
// CFO-level headlines when Tax, Treasury, and FP&A moves are just as real a
// BD opportunity. General for any customer's own selected functions, not
// hardcoded to any one account's — every function in FUNCTION_SUBDISCIPLINES
// resolves the same way.
export function buildFunctionBreadthHint(functions) {
  const seen = new Set()
  const lines = []
  for (const value of functions || []) {
    const parent = functionParentLabel(value)
    if (!parent || seen.has(parent)) continue
    seen.add(parent)
    const subs = FUNCTION_SUBDISCIPLINES[parent]
    if (subs?.length) lines.push(`${parent} includes (but is not limited to): ${subs.join(', ')}`)
  }
  return lines.join('\n')
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
// 2026-08-26: used to only ever query the customer's first 2 mapped
// countries (`countries.slice(0, 2)`) and then cap the merged, country-
// concatenated result list at 10 — so a customer targeting 3+ Adzuna-
// covered markets silently never got ANY leads from their 3rd+ market, and
// even between the first two, whichever came first in `locations` crowded
// out the second once results were merged. Adzuna is free (no credit cost,
// see the comment above), so there's no cost reason to hold back — this
// now queries every mapped country and interleaves the results round-robin
// so each market gets fair representation up to the cap, with a log line
// when the cap actually discards something (matches the "no silent caps"
// standard the rest of this file already holds itself to).
export async function discoverAdzunaJobs(appId, appKey, { sectors, functions, locations }, lookbackDays = SIGNAL_LOOKBACK_DAYS) {
  if (!appId || !appKey) return []
  const countries = mapLocationsToAdzunaCountries(locations)
  if (!countries.length) return []

  // 2026-08-31, the worst of the two live-job bugs. This used to be
  // `what: buildSearchKeywords(sectors, functions).join(' ')`. Adzuna's
  // `what` ANDs every word it is given, so a realistic multi-sector
  // customer was asking Adzuna for a single job matching every one of their
  // sector AND function words at once. Verified live against Michael's own
  // key: count 0, zero results. The UK live-job source has been returning
  // literally nothing, indistinguishably from "no jobs today".
  //
  // `title_only` is the right field — it matches against the job title
  // rather than the whole ad, which is what "find me a senior opening"
  // actually means — but it ANDs its own words too, so each title has to be
  // its own request rather than one combined query. Adzuna is free and
  // uncapped for this volume, so the extra requests cost nothing.
  const jobTitles = buildJobTitleQueries(functions)
  if (!jobTitles.length) return []

  const perCountry = []
  for (const country of countries) {
    const countryResults = []
    const seenUrls = new Set()
    for (const jobTitle of jobTitles) {
      try {
        const params = new URLSearchParams({
          app_id: appId,
          app_key: appKey,
          results_per_page: '5',
          title_only: jobTitle,
          max_days_old: String(lookbackDays),
          sort_by: 'date',
        })
        const resp = await fetchWithRetry(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params.toString()}`)
        if (resp.ok) {
          const data = await resp.json()
          for (const j of data.results || []) {
            const title = (j.title || '').replace(/<[^>]+>/g, '').trim()
            const company = j.company?.display_name || ''
            const url = j.redirect_url || ''
            if (!title || !company) continue
            // The same posting legitimately matches more than one title
            // query ("Finance Director" and "Head of Finance" both hit a
            // "Finance Director / Head of Finance" ad), so dedupe within the
            // country before it reaches the merge below.
            if (url && seenUrls.has(url)) continue
            if (url) seenUrls.add(url)
            countryResults.push({
              title,
              company,
              location: j.location?.display_name || '',
              url,
              salary: j.salary_min ? `${Math.round(j.salary_min)}${j.salary_max && j.salary_max !== j.salary_min ? `-${Math.round(j.salary_max)}` : ''}` : null,
            })
          }
        } else {
          // 2026-08-29 audit fix: a non-ok response (a suspended app_id/
          // app_key, a bad request, an Adzuna-side outage) fell through this
          // branch with nothing logged at all — identical, in every log and
          // in the product, to "genuinely zero jobs in this country right
          // now." Every other discover*/lookup* function in this file at
          // least logs its non-ok branch (see discoverTheirStackJobs,
          // discoverHotCompanies, verifyContact above); this was the one
          // real gap. Still fails open on purpose (one country's outage
          // shouldn't drop the others this loop already found), just no
          // longer invisibly.
          console.error(`[scanShared] Adzuna non-ok response for ${country} / "${jobTitle}": ${resp.status}`)
        }
      } catch (err) {
        console.error('[scanShared] adzuna discovery failed for', country, `/ "${jobTitle}":`, err.message)
      }
    }
    perCountry.push(countryResults)
  }

  const merged = []
  for (let i = 0; merged.length < 10 && perCountry.some((list) => i < list.length); i++) {
    for (const list of perCountry) {
      if (merged.length >= 10) break
      if (i < list.length) merged.push(list[i])
    }
  }
  const totalFound = perCountry.reduce((n, list) => n + list.length, 0)
  if (totalFound > merged.length) {
    console.log(`[scanShared] Adzuna: found ${totalFound} real jobs across ${countries.length} countries, capped to ${merged.length} (interleaved evenly across markets rather than first-country-biased)`)
  }
  return merged
}

// Same daily-spend-cap pattern as reserveApolloCredits (see that function's
// own comment, and 2026-08-26-per-customer-credit-caps.sql for the tables
// this calls) — TheirStack is a paid third-party API with no ceiling of
// its own, so a bug or a retried request shouldn't be able to run up an
// unbounded bill. `credits` should be the number of jobs actually
// requested (TheirStack's own pricing is per job returned, not per call —
// confirmed against the account's real usage during evaluation, not
// assumed), not a flat 1 per call the way some other APIs bill. Same
// per-customer-plus-platform-backstop design as Apollo above — see that
// function's comment for `caps`'s shape and the fallback behaviour when
// omitted. Matches entitlements.js's own DEFAULT_PLATFORM_CAPS.theirStack
// exactly, same reasoning as DEFAULT_APOLLO_DAILY_CAP above.
// 5th-pass audit fix (2026-08-26): a scale review against the cost-analysis
// doc's own confirmed, real cadence — discoverTheirStackJobs is called
// twice a day, unconditionally, on EVERY tier, at 10 credits/call, i.e. a
// flat 20 credits/customer/day no matter which plan — found this backstop
// was sized for a much smaller customer base than the 50-100 clients
// that doc targets: 500/day is already exceeded past ~25 customers
// (25 × 20 = 500), well short of 50, let alone 100 (2,000/day of genuine,
// legitimate demand). Once past that point, this "secondary, backstop"
// cap would start being the thing actually throttling TheirStack for
// every customer daily — not a bug, a genuine outage, or a runaway
// process, just real usage outgrowing a number set before that usage
// pattern was confirmed. Raised to comfortably clear 100 clients (2,000/
// day) with real headroom, while staying well under what an actual
// runaway/bug would produce.
const DEFAULT_THEIRSTACK_DAILY_CAP = 3000

export async function reserveTheirStackCredits(supabase, userId, credits = 1, caps = {}) {
  if (!supabase) return true
  const platformDailyCap = caps.platformDailyCap ?? parseIntEnv(process.env.THEIRSTACK_DAILY_CREDIT_CAP, DEFAULT_THEIRSTACK_DAILY_CAP)
  const userDailyCap = caps.userDailyCap ?? null
  try {
    const { data, error } = await supabase.rpc('theirstack_reserve_credits', {
      p_credits: credits, p_user_id: userId || null, p_user_daily_cap: userDailyCap, p_platform_daily_cap: platformDailyCap,
    })
    if (error) {
      console.error('[scanShared] theirstack_reserve_credits RPC failed, allowing the call through:', error.message)
      return true
    }
    if (data === 'user_cap') {
      console.log(`[scanShared] TheirStack per-customer daily credit cap (${userDailyCap}) reached for user ${userId} — expected behaviour, does not affect other customers`)
      return false
    }
    if (data === 'platform_cap') {
      console.error(`[scanShared] TheirStack daily credit cap (${platformDailyCap}) reached for today, skipping call`)
      alertCapHitOnce('TheirStack', platformDailyCap)
      return false
    }
    if (data !== 'ok') console.error('[scanShared] theirstack_reserve_credits RPC returned an unexpected value, allowing the call through:', data)
    return true
  } catch (err) {
    console.error('[scanShared] theirstack_reserve_credits threw, allowing the call through:', err.message)
    return true
  }
}

// 2026-08-26 audit fix: discoverTheirStackJobs reserves `limit` credits
// upfront (the most it could possibly be billed for, needed to enforce the
// cap correctly BEFORE spending anything), but a real call usually returns
// fewer jobs than `limit` — sometimes zero, if nothing matched or the call
// failed outright. Without this, every call permanently counted as its
// full worst-case cost against both the per-customer and platform-wide
// daily caps, inflating internal cost tracking relative to what TheirStack
// actually bills (per job returned — see reserveTheirStackCredits's own
// comment) and able to cap a customer out earlier than their real spend
// justifies. Called after the real response is known, to refund the
// difference. Best-effort and fail-silent-but-logged on purpose — a failed
// refund just leaves that day's counters a little conservative, which is
// the safe direction to err in, not a reason to fail the caller's own
// (already-successful) job search.
export async function releaseTheirStackCredits(supabase, userId, credits) {
  if (!supabase || !credits || credits <= 0) return
  try {
    const { error } = await supabase.rpc('theirstack_release_credits', { p_credits: credits, p_user_id: userId || null })
    if (error) console.error('[scanShared] theirstack_release_credits RPC failed:', error.message)
  } catch (err) {
    console.error('[scanShared] theirstack_release_credits threw:', err.message)
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
export async function discoverTheirStackJobs(apiKey, { sectors, functions, locations }, supabase, userId = null, caps = {}, lookbackDays = SIGNAL_LOOKBACK_DAYS) {
  if (!apiKey) return []
  const countries = mapLocationsToTheirStackCountries(locations)
  if (!countries.length) return []

  // 2026-08-31: was buildSearchKeywords(sectors, functions), which handed
  // this API sector/function LABELS as job titles. See FUNCTION_JOB_TITLES
  // above for what that measured out at (1 usable lead per 10 results).
  const jobTitles = buildJobTitleQueries(functions)

  const limit = 10
  if (!(await reserveTheirStackCredits(supabase, userId, limit, caps))) return []

  try {
    const body = {
      limit,
      offset: 0,
      posted_at_max_age_days: lookbackDays,
      job_country_code_or: countries,
      // Without this the feed is dominated by junior and mid-level roles,
      // which are not mandates and which the scan then discards anyway —
      // paying full credits for results that were never going to be used.
      job_seniority_or: THEIRSTACK_SENIORITIES,
    }
    if (jobTitles.length) body.job_title_or = jobTitles

    const resp = await fetchWithRetry('https://api.theirstack.com/v1/jobs/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }, 12000, 2, { billable: true })
    if (!resp.ok) {
      console.error(`[scanShared] TheirStack jobs/search non-ok response: ${resp.status}`)
      // Nothing was actually returned (so nothing actually billed) — refund
      // the whole reservation rather than leaving it counted as spent.
      await releaseTheirStackCredits(supabase, userId, limit)
      return []
    }
    const data = await resp.json()
    const rawResults = data.data || []
    // Refund the gap between what was reserved and what TheirStack actually
    // returned — see releaseTheirStackCredits's own comment.
    if (rawResults.length < limit) {
      await releaseTheirStackCredits(supabase, userId, limit - rawResults.length)
    }
    return rawResults
      .map(j => ({
        title: (j.job_title || '').trim(),
        company: (j.company || '').trim(),
        location: j.location || j.short_location || '',
        url: j.url || j.final_url || j.source_url || '',
        salary: j.salary_string || null,
        // 2026-09-03, Michael: TheirStack's own response already carries
        // employee_count and is_recruiting_agency on company_object — free
        // signal this mapping was throwing away, meaning
        // pickLiveJobEntry(ies)FromLeads below could only judge a lead by
        // title/company/url and had no way to avoid picking a mega-employer
        // or an agency-posted role BEFORE spending one of the guaranteed
        // live_job slots on it — only buildEnrichedSignalRow's later,
        // Apollo-backed check caught it, by which point the pick was
        // already made and nothing replaced it. Adzuna leads have no
        // equivalent field (no company object in its response), so they
        // stay undefined here and fall through to the text-based
        // looksLikeStaffingAgencyName check only, same as always.
        employeeCount: typeof j.company_object?.employee_count === 'number' ? j.company_object.employee_count : null,
        isRecruitingAgency: !!j.company_object?.is_recruiting_agency,
      }))
      .filter(j => j.title && j.company && j.url)
      .slice(0, limit)
  } catch (err) {
    console.error('[scanShared] TheirStack discovery failed:', err.message)
    // The call never completed — nothing was billed, refund the whole
    // reservation.
    await releaseTheirStackCredits(supabase, userId, limit)
    return []
  }
}

// 2026-09-02 audit fix, real report ("why has Annie not found one live
// job — this is always a gap"): both scan files skip fresh discovery
// ENTIRELY — including this exact call and discoverAdzunaJobs above —
// whenever the cross-customer signal pool alone already covers a run's
// whole quota (see the "poolPersonalized.length >= target" branch in
// intelligence-scan-background.js/scan-now-background.js). That's the
// right call for funding/expansion/leadership_change, which stay relevant
// to every similarly-profiled customer for weeks and so accumulate
// genuinely in the pool — but a specific open role is exactly the kind of
// signal the pool structurally can't substitute for: it's too time-
// sensitive and company-specific to still be sitting in another
// customer's contribution days later, and live_job pool matches
// additionally require a function overlap (see fetchSignalPoolMatches),
// narrowing them further. Verified live against Michael's own account via
// theirstack_usage: zero credits spent on either of the two most recent
// days, both days the pool alone filled his quota — two straight days of
// zero live_job attempts, not zero live_job results.
//
// Called only from that pool-satisfied branch, to guarantee at least one
// genuine attempt every run regardless of pool fill. Effectively no added
// cost: Adzuna is free, TheirStack spends from the same daily budget that
// sat completely unused those two days (this doesn't raise any cap). No
// incremental Anthropic call either — a real job lead's own fields
// (title, company, url, salary) are already exactly the grounded facts a
// signal row needs, so this builds the row deterministically; the normal
// buildEnrichedSignalRow staffing-agency/job-posting-shape checks and
// Apollo contact resolution then apply exactly as they would for any
// AI-found or Adzuna-found live_job entry — no special-casing downstream.
// Returns at most one entry (the first genuinely new lead found, checked
// against this customer's own dedup keys) — this guarantees an attempt,
// it doesn't try to replace the richer multi-lead path the "pool doesn't
// cover quota" branch already runs.
// Pure — no fetching, so a caller that already has today's Adzuna/
// TheirStack leads in hand (the ordinary case now that both scan files
// fetch them unconditionally every run, not just when this fallback is
// needed — see the "priority discovery" pass in intelligence-scan-
// background.js/scan-now-background.js) can reuse them here instead of
// spending a second, duplicate API call just to get a pickable entry.
// Still exported and used directly by discoverGuaranteedLiveJobEntry below
// for any caller that doesn't already have leads on hand.
// 2026-09-03, Michael, real report: asked to see exactly what a scan run's
// raw lead lists actually contained (Al-Futtaim, POWERCHINA, ALAS Emirates
// Ready Mix, several more) after this picker had surfaced a single, weak
// "COPADO User Group Hyderabad" entry from that same list — a name that
// reads like a meetup/community group, not a real employer. The picker
// below used to take the FIRST lead that merely had a title/company/url
// and wasn't already on file, with no read at all on whether it was
// actually a good pick — a mega-employer (Al-Futtaim, 26,657 staff) or an
// agency-posted role would only get caught much later, by
// buildEnrichedSignalRow's Apollo-backed check, by which point the one
// guaranteed slot was already spent on it and nothing replaced it. This
// gate runs the same checks that check would eventually make anyway
// (isMegaEmployer, looksLikeStaffingAgencyName), at picking time, using the
// employeeCount/isRecruitingAgency TheirStack already hands back for free
// (see discoverTheirStackJobs's own mapping) — so a bad lead costs nothing
// and the picker moves on to the next one instead of spending its shot.
//
// 2026-09-06 follow-up, Michael, real report: "COPADO User Group Hyderabad"
// and "AWS User Group SE" both surfaced live, as the assumption above that
// looksLikeStaffingAgencyName would double as a catch-all for a name like
// that turned out wrong. "User group" isn't staffing/recruitment
// vocabulary, so it sailed straight through this gate every time. Fixed
// properly now with looksLikeCommunityOrGroupName, a dedicated check for
// exactly this vocabulary (see its own header in agencyMatch.js) instead
// of relying on the staffing check to coincidentally also catch it.
function isDisqualifiedLiveJobLead(lead) {
  if (looksLikeStaffingAgencyName(lead.company)) return true
  if (looksLikeCommunityOrGroupName(lead.company)) return true
  if (lead.isRecruitingAgency) return true
  if (isMegaEmployer(lead.employeeCount)) return true
  return false
}

function buildLiveJobEntryFromLead(lead) {
  let sourceLabel = ''
  try { sourceLabel = new URL(lead.url).hostname.replace(/^www\./, '') } catch { /* keep '' */ }
  return {
    entryType: 'live_job',
    company: lead.company,
    signalType: 'live_job',
    headline: `${lead.title} — live opening at ${lead.company}`,
    whyItMatters: `A genuine, currently open ${lead.title} posting${lead.location ? ` in ${lead.location}` : ''}${lead.salary ? `, salary ${lead.salary}` : ''} — a real, time-sensitive hiring need right now.`,
    sourceUrl: lead.url,
    sourceLabel,
    eventDate: null,
    titleKeywords: [lead.title],
    whoToApproach: '',
    introMessage: '',
    candidateAngle: '',
    benchStrengthAngle: '',
    candidateProfile: null,
    likelyRoles: [],
  }
}

// 2026-09-03: plural successor to pickLiveJobEntryFromLeads below, for the
// priority-discovery pass's own top-up (see LIVE_JOB_PRIORITY_LIMIT in this
// file and runPriorityDiscovery in both scan files) — Michael's own
// question ("surely there's a lot more roles than that") confirmed a single
// scan's raw leads regularly contain several genuinely good, distinct
// candidates (POWERCHINA, ALAS Emirates Ready Mix, both real mid-size
// employers, sitting unused behind the one COPADO pick that run). Same
// source order and dedup-against-existingKeys rule as the singular
// function, plus: skips a disqualified lead instead of returning it (see
// isDisqualifiedLiveJobLead), and dedupes against its OWN already-picked
// entries by URL so the same posting can't fill two of the limit's slots.
export function pickLiveJobEntriesFromLeads(theirStackLeads, adzunaLeads, existingKeys, limit = 1) {
  const picked = []
  const pickedUrls = new Set()
  for (const lead of [...(theirStackLeads || []), ...(adzunaLeads || [])]) {
    if (picked.length >= limit) break
    if (!lead.title || !lead.company || !lead.url) continue
    if (pickedUrls.has(lead.url)) continue
    if (existingKeys?.has(normalizeKey(lead.company, lead.title, lead.url))) continue
    if (isDisqualifiedLiveJobLead(lead)) continue
    pickedUrls.add(lead.url)
    picked.push(buildLiveJobEntryFromLead(lead))
  }
  return picked
}

// Singular convenience wrapper, kept for discoverGuaranteedLiveJobEntry and
// existing callers that only ever wanted one entry — same quality gate as
// the plural picker above now applies here too (previously this had none),
// so a mega-employer or agency-posted lead no longer costs this the one
// slot it has; it just moves on to the next real one, same as it already
// did for an existing-on-file duplicate.
export function pickLiveJobEntryFromLeads(theirStackLeads, adzunaLeads, existingKeys) {
  return pickLiveJobEntriesFromLeads(theirStackLeads, adzunaLeads, existingKeys, 1)[0] || null
}

export async function discoverGuaranteedLiveJobEntry(adzunaAppId, adzunaAppKey, theirStackApiKey, ob, existingKeys, supabase, caps = {}) {
  const [adzunaLeads, theirStackLeads] = await Promise.all([
    discoverAdzunaJobs(adzunaAppId, adzunaAppKey, { sectors: ob.sectors, functions: ob.functions, locations: ob.locations }),
    discoverTheirStackJobs(theirStackApiKey, { sectors: ob.sectors, functions: ob.functions, locations: ob.locations }, supabase, ob.user_id, caps),
  ])
  return pickLiveJobEntryFromLeads(theirStackLeads, adzunaLeads, existingKeys)
}

// Apollo tracks real job postings directly, it isn't guessing from news.
// Querying it BEFORE the AI call gives the AI a head start of real,
// independently-confirmed leads rather than relying purely on whatever
// general news search happens to surface.
export async function discoverHotCompanies(apolloKey, { sectors, functions, locations }, supabase, userId = null, caps = {}, lookbackDays = SIGNAL_LOOKBACK_DAYS) {
  if (!apolloKey) return []
  if (!(await reserveApolloCredits(supabase, userId, 1, caps))) return []
  try {
    const body = { per_page: 8, organization_num_jobs_range: { min: 1 } }
    body.organization_job_posted_at_range = { min: isoDateDaysAgo(lookbackDays) }

    const sectorKeywords = (sectors || []).flatMap(splitToKeywords)
    if (sectorKeywords.length) body.q_organization_keyword_tags = sectorKeywords.slice(0, 20)

    // 2026-09-01 audit fix: this used to be splitToKeywords(functions) too —
    // the exact same category error the 2026-08-31 fix above (buildJobTitleQueries)
    // already found and corrected for Adzuna/TheirStack, just missed here. Apollo's
    // own docs are explicit that q_organization_job_titles wants real job title
    // strings ("sales manager", "research analyst"), not label fragments — feeding
    // it "Real Estate, Facilities" or "Finance" (what splitToKeywords produces from
    // a function label) doesn't match any real posting, silently weakening or
    // zeroing out this call's own filter on every scan. q_organization_keyword_tags
    // just above is the right home for label fragments (Apollo's own docs: keyword
    // tags like "mining" ARE meant to be loose industry/subject words) — that one
    // was always correct. Reuses buildJobTitleQueries, the exact function that
    // already fixed this for the two sibling calls, rather than a second
    // implementation of the same fix.
    const titleKeywords = buildJobTitleQueries(functions)
    if (titleKeywords.length) body.q_organization_job_titles = titleKeywords

    if (locations?.length) body.organization_locations = locations.slice(0, 10)

    const resp = await fetchWithRetry('https://api.apollo.io/v1/mixed_companies/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify(body),
    })
    // 4th-pass audit fix: a failed call still cost 1 reserved credit until
    // now — release it so a real Apollo outage doesn't burn the shared
    // platform-wide daily cap faster than normal operation would.
    // 2026-08-29 audit fix: the credit was already being released
    // correctly, but nothing was ever logged — a non-ok Apollo response
    // here was completely silent, same class of gap as discoverAdzunaJobs
    // above, just found a few lines further down this file.
    if (!resp.ok) {
      console.error(`[scanShared] discoverHotCompanies non-ok response: ${resp.status}`)
      await releaseApolloCredits(supabase, userId, 1)
      return []
    }
    const data = await resp.json()
    const orgs = [...(data.organizations || []), ...(data.accounts || [])]
    return orgs
      .map(o => ({ name: o.name, industry: o.industry || null, employees: o.estimated_num_employees || null }))
      .filter(o => o.name)
      .slice(0, 8)
  } catch (err) {
    console.error('[scanShared] apollo discovery failed:', err.message)
    await releaseApolloCredits(supabase, userId, 1)
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
export async function verifyContact(apolloKey, company, titleKeywords, supabase, apolloOrgId, appointedName, userId = null, caps = {}) {
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
  //
  // 2026-09-04: what may be written as a negative changed — see step 3.
  if (supabase) {
    try {
      // 2026-08-26 audit fix: same gap as the write path below (see its own
      // 2026-08-24 Task 5 comment) — a query-level failure here (RLS denial,
      // a bad filter) resolves normally with `error` set rather than
      // throwing, so it fell through silently as if this were just an
      // ordinary cache miss, with nothing in the logs to explain why a
      // contact that should have been cached got re-looked-up anyway.
      const { data: cached, error } = await supabase
        .from('company_contacts')
        .select('contact_name, contact_title, contact_linkedin_url, contact_email, contact_verified, checked_at')
        .eq('company_name_key', cacheKey)
        .eq('title_key', titleKey)
        .maybeSingle()
      if (error) console.error(`[scanShared] contact cache lookup failed for "${company}" (${titleKey}):`, error.message)
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
  // now does the lack of a resolved org id actually matter. This used to be
  // silent — the only trace of why a signal never got a contact was
  // enrichCompany's own log line about the company match itself, in a
  // different function; nothing here said "and that's also why the contact
  // search never even ran." 2026-08-26: this is now the dominant failure
  // mode this file's own header comment documents, so it gets its own line.
  if (!apolloOrgId && !appointedName) {
    console.log(`[scanShared] verifyContact: skipping "${company}" (${titleKey}) — no Apollo org id resolved for this company, so there's nobody to search under`)
    return null
  }

  // 2026-09-04: no credit is reserved here any more. This function used to
  // reserve one before calling through, on the assumption that the Apollo
  // *search* costs a credit. It does not. Verified directly against the live
  // API on 2026-09-04: mixed_people/api_search ran against a real org and the
  // team's lead_credit consumed figure was identical before and after
  // (1359 -> 1359). Only a people/match that returns a real person is
  // billed. Reserving here therefore charged every customer's daily cap for
  // a call Apollo never invoiced, roughly doubling the metered cost of every
  // contact lookup and throttling scans against a budget that was not being
  // spent. Credits are now reserved at the single point where Apollo
  // actually bills — the reveal — and released whenever that reveal comes
  // back without a match (also free, verified the same way:
  // match_confidence "none" moved the counter 1359 -> 1359).
  const outcome = appointedName
    ? await lookupContactByName(apolloKey, company, appointedName, supabase, userId, caps)
    : await lookupContact(apolloKey, company, titleKeywords, supabase, apolloOrgId, userId, caps)

  const result = outcome?.contact || null

  // 3. Write through ONLY when Apollo actually answered.
  //
  // 2026-09-04: this used to write `contact_verified: !!result` on every
  // path, which meant a null for ANY reason was recorded as the durable,
  // cross-account fact "nobody findable here" for CONTACT_CACHE_TTL_DAYS
  // (60). But null was also what came back when this customer hit their own
  // apolloUserDailyCap, when Apollo returned a 429 or 5xx, and when the
  // request timed out — none of which are evidence about the company. The
  // table is deliberately shared across every account (see its use in
  // enrichCompany), so one customer exhausting their own daily cap, or one
  // transient Apollo error, blanked that company/role for EVERY account for
  // two months. Measured on production 2026-09-04: 299 of 604 cached rows
  // were negative, all written inside the previous 14 days. Spot-checked two
  // by re-running the (free) search by hand: "Starling Bank / country
  // manager|general manager|managing director" was genuinely empty, but
  // "Amana / engineering director|head of engineering|vp engineering"
  // returned three real people, two of them with emails available. That row
  // was suppressing a real lead for everyone.
  //
  // `conclusive` is true only when Apollo returned a well-formed response we
  // can draw a conclusion from. Everything else leaves the cache untouched
  // so the next run retries — which is free, because the search is free.
  if (supabase && outcome?.conclusive) {
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
  } else if (supabase && !outcome?.conclusive) {
    console.log(`[scanShared] verifyContact: not caching a result for "${company}" (${titleKey}) — Apollo never returned a usable answer, so "no contact" would be a guess, not a fact`)
  }

  return result
}

// How many search results to consider before giving up on a title bucket.
// The search itself is free (see verifyContact's note), so asking for more
// candidates costs nothing and buys two things: an alternate to fall through
// to when the first person's reveal comes back unusable, and the has_email
// flag per person, which lets the paid reveal target someone Apollo can
// actually complete. This was `per_page: 1` until 2026-09-04, which committed
// the one paid call to whoever Apollo happened to rank first.
const CONTACT_SEARCH_CANDIDATES = 10

// How many of those candidates are worth paying to reveal before concluding
// nobody at this company/role is reachable. Each attempt is only billed if it
// returns a real person, but each one is still a round trip, and a company
// where the first two well-chosen candidates both fail is a company where the
// data is thin.
const MAX_REVEAL_ATTEMPTS = 3

// Reveals one Apollo person id. Returns the enriched fields, or null.
// Reserves a credit before the call and RELEASES it whenever Apollo did not
// actually bill — verified 2026-09-04 against the live API: a people/match
// that resolves with `match_confidence: "none"` leaves the team's consumed
// credit count unchanged, so treating that as spend was pure phantom cost.
async function revealApolloPerson(apolloKey, personId, supabase, userId, caps, label = '') {
  if (!personId) return null
  if (!(await reserveApolloCredits(supabase, userId, 1, caps))) {
    // Cap-blocked. Not evidence about the person — the caller must not turn
    // this into a cached negative.
    return { capBlocked: true }
  }
  try {
    const matchResp = await fetchWithRetry('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify({ id: personId, reveal_personal_emails: true }),
    }, 12000, 1, { billable: true })
    if (!matchResp.ok) {
      console.error(`[scanShared] reveal non-ok response for ${label || personId}: ${matchResp.status}`)
      await releaseApolloCredits(supabase, userId, 1)
      return { failed: true }
    }
    const matchData = await matchResp.json()
    const person = matchData?.person
    // Apollo answers 200 with a person-shaped object even when it matched
    // nothing; match_confidence "none" is the tell, and that response is not
    // billed. Nothing in this file read that field before 2026-09-04, so the
    // code could not distinguish a paid match from a free miss.
    const matched = person && person.match_confidence !== 'none' && (person.id || person.email || person.linkedin_url)
    if (!matched) {
      await releaseApolloCredits(supabase, userId, 1)
      return null
    }
    const rawEmail = person?.email
    const email = rawEmail && !rawEmail.includes('email_not_unlocked') && !rawEmail.includes('locked') ? rawEmail : null
    return {
      first_name: person?.first_name || null,
      last_name: person?.last_name || null,
      title: person?.title || null,
      linkedin_url: person?.linkedin_url || null,
      email,
    }
  } catch (err) {
    console.error(`[scanShared] reveal failed for ${label || personId}:`, err.message)
    await releaseApolloCredits(supabase, userId, 1)
    return { failed: true }
  }
}

// Returns { contact, conclusive }. See verifyContact step 3 for what
// `conclusive` governs — in short, only a well-formed Apollo answer is
// allowed to write a durable "nobody here" into the shared cache.
async function lookupContact(apolloKey, company, titleKeywords, supabase, apolloOrgId, userId = null, caps = {}) {
  try {
    const resp = await fetchWithRetry('https://api.apollo.io/api/v1/mixed_people/api_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify({ organization_ids: [apolloOrgId], person_titles: titleKeywords?.length ? titleKeywords : undefined, page: 1, per_page: CONTACT_SEARCH_CANDIDATES }),
    })
    if (!resp.ok) {
      // This used to only go to console.error — invisible the same way the
      // intelligence_signals write failures were, just in a different file.
      const bodyPreview = await resp.text().catch(() => '')
      console.error(`[scanShared] verifyContact non-ok response for "${company}": ${resp.status}`)
      await reportServerError('scanShared:verifyContact', new Error(`Apollo mixed_people/api_search returned ${resp.status}`), {
        company, apolloOrgId, titleKeywords, status: resp.status, bodyPreview: bodyPreview.slice(0, 500),
      })
      // No credit to release: the search is free and nothing was reserved
      // for it. Inconclusive, so the caller leaves the cache alone.
      return { contact: null, conclusive: false }
    }
    const data = await resp.json()
    const people = Array.isArray(data.people) ? data.people : []
    if (!people.length) {
      console.log(`[scanShared] verifyContact: no Apollo person matched any of [${(titleKeywords || []).join(', ')}] at "${company}" (org ${apolloOrgId})`)
      // Apollo answered and had nobody. That IS a fact worth caching.
      return { contact: null, conclusive: true }
    }

    // 2026-08-24: mixed_people/api_search masks last names on this account's
    // Apollo plan tier — the raw response carries `last_name_obfuscated`
    // (e.g. "Re***n"), never a usable `last_name`, confirmed directly
    // against the live API, not assumed. Requiring p.last_name straight off
    // this search result — the previous behavior — meant every single
    // result from this endpoint, for every company, every signal type, was
    // silently discarded here. A first name is still enough to know there's
    // a real person worth revealing — the full identity comes from the
    // reveal call, which returns an unmasked name (confirmed live: search
    // gave "Re***n", the reveal for that same person id gave "Rehman").
    //
    // 2026-09-04: order the candidates rather than taking people[0] blind.
    // has_email comes back on every search row and costs nothing to read;
    // preferring the people Apollo can actually complete is the difference
    // between a reveal that yields a usable record and one that yields a
    // first name. Ordering is stable so the same company/role resolves to
    // the same person run to run.
    const candidates = people
      .filter((p) => p && p.id && p.first_name)
      .sort((a, b) => (b.has_email === true ? 1 : 0) - (a.has_email === true ? 1 : 0))
    if (!candidates.length) {
      console.log(`[scanShared] verifyContact: Apollo returned ${people.length} row(s) for "${company}" (org ${apolloOrgId}) but none had both an id and a first name — treating as no usable contact`)
      return { contact: null, conclusive: true }
    }

    let sawIndeterminate = false
    for (const p of candidates.slice(0, MAX_REVEAL_ATTEMPTS)) {
      const revealed = await revealApolloPerson(apolloKey, p.id, supabase, userId, caps, `"${company}"/"${p.first_name}"`)
      if (revealed?.capBlocked || revealed?.failed) {
        // Cap-blocked or a transient error. Stop trying and make sure the
        // caller does not record a negative — we learned nothing.
        sawIndeterminate = true
        break
      }
      if (!revealed) continue // free miss on this person, try the next

      const firstName = revealed.first_name || p.first_name
      const lastName = revealed.last_name
      if (!firstName || !lastName) {
        console.log(`[scanShared] verifyContact: reveal for "${company}"/"${p.first_name}" returned no usable last name — trying the next candidate rather than showing a first-name-only record`)
        continue
      }
      return {
        contact: {
          name: `${firstName} ${lastName}`.trim(),
          title: revealed.title || p.title || '',
          linkedin_url: revealed.linkedin_url || p.linkedin_url || '',
          email: revealed.email,
        },
        conclusive: true,
      }
    }

    // Everyone we tried came back unusable. If any attempt was cap-blocked or
    // errored we cannot conclude anything; otherwise Apollo genuinely has
    // nothing complete for this company/role.
    return { contact: null, conclusive: !sawIndeterminate }
  } catch (err) {
    console.error(`[scanShared] verifyContact failed for "${company}":`, err.message)
    await reportServerError('scanShared:verifyContact', err, { company, titleKeywords })
    return { contact: null, conclusive: false }
  }
}

// Looks up a specific named person at a company, via Apollo's people/match
// endpoint — used only for leadership_change signals, where the AI already
// named the person appointed (appointedName) and the goal is reaching that
// exact individual, not a generic title match. Falls back to null (never to
// a generic title search within this same call) if Apollo can't confirm a
// match on the name, since showing a different, unrelated person under "the
// new leader" would be worse than showing no verified contact at all.
//
// 2026-09-04: this used to call people/match TWICE for the same person —
// once with { name, organization_name } to find them, then again with
// { id, reveal_personal_emails } to get the email. Both are billable
// enrichments, so every leadership_change contact cost two credits instead
// of one. people/match accepts reveal_personal_emails on the same call that
// resolves the name, so the second call was pure duplication.
async function lookupContactByName(apolloKey, company, fullName, supabase, userId = null, caps = {}) {
  if (!(await reserveApolloCredits(supabase, userId, 1, caps))) {
    console.log(`[scanShared] lookupContactByName: cap reached before looking up "${fullName}" at "${company}" — not treating that as "no such person"`)
    return { contact: null, conclusive: false }
  }
  try {
    // people/match (People Enrichment) takes a name plus a company hint, not
    // an organization_id — unlike mixed_people/api_search above, which is a
    // search endpoint that filters by org id. organization_name is passed as
    // the company hint here so Apollo can disambiguate a common name.
    const resp = await fetchWithRetry('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify({ name: fullName, organization_name: company, reveal_personal_emails: true }),
    }, 12000, 1, { billable: true })
    if (!resp.ok) {
      console.error(`[scanShared] lookupContactByName non-ok response for "${fullName}" at "${company}": ${resp.status}`)
      await releaseApolloCredits(supabase, userId, 1)
      return { contact: null, conclusive: false }
    }
    const data = await resp.json()
    const p = data?.person
    const matched = p && p.match_confidence !== 'none' && (p.id || p.email || p.linkedin_url)
    if (!matched) {
      // Apollo answered and could not confirm this person. Free, so release.
      await releaseApolloCredits(supabase, userId, 1)
      return { contact: null, conclusive: true }
    }
    // Same bar as the title-based lookup: a confirmed first AND last name,
    // not a thin partial record. The credit is NOT released here — Apollo
    // matched somebody and billed for it; the record simply is not good
    // enough to show.
    if (!p.first_name || !p.last_name) {
      console.log(`[scanShared] lookupContactByName: Apollo matched "${fullName}" at "${company}" but returned no usable last name`)
      return { contact: null, conclusive: true }
    }
    const rawEmail = p.email
    const email = rawEmail && !rawEmail.includes('email_not_unlocked') && !rawEmail.includes('locked') ? rawEmail : null
    return {
      contact: {
        name: `${p.first_name} ${p.last_name}`.trim(),
        title: p.title || '',
        linkedin_url: p.linkedin_url || '',
        email,
      },
      conclusive: true,
    }
  } catch (err) {
    console.error(`[scanShared] lookupContactByName failed for "${fullName}" at "${company}":`, err.message)
    await releaseApolloCredits(supabase, userId, 1)
    await reportServerError('scanShared:lookupContactByName', err, { company, fullName })
    return { contact: null, conclusive: false }
  }
}

// Funding/expansion signals rarely have one obvious "the" contact the way a
// leadership_change does — the actionable question is closer to "who would
// this company likely be hiring for off the back of this", which is
// naturally several people across different functions, not one. These are
// the buckets Annie searches by default; every one of the four whitelisted
// Today's BD Actions signal types (see BD_ACTION_SIGNAL_TYPES in
// src/lib/todaysActions/eligibility.js) is required to always carry at
// least one usable contact recommendation, so this is the fallback that
// guarantees that when a single verifyContact call comes back empty.
// 2026-08-26: added `leadership`. The funding/expansion signal is
// specifically about young/small/regional companies — exactly the ones
// most likely to not yet have a "Head of Product" or "Commercial Director"
// at all, where the real, only decision-maker is the Founder/CEO/Managing
// Director. Every existing bucket here searched only functional titles and
// none of them included this — a real, structural miss for the smaller
// companies these two signal types are about, at every tier, not just
// Starter (this bucket applies to funding/expansion unconditionally,
// unlike EXTENDED_FUNCTION_TITLE_BUCKETS below which is tier-gated).
const FUNCTION_TITLE_BUCKETS = {
  leadership: ['Founder', 'Co-Founder', 'CEO', 'Managing Director', 'Owner'],
  product: ['Head of Product', 'VP Product', 'Product Director'],
  engineering: ['Head of Engineering', 'VP Engineering', 'Engineering Director'],
  commercial: ['Commercial Director', 'VP Sales', 'Head of Business Development'],
}

// A second, wider net, tried when the standard multi-function fallback
// below still comes back with nobody for a leadership_change/live_job
// signal. Originally gated to tiers with apolloContactRetry enabled
// (Growth/Team, see SCAN_TIER_CONFIG in entitlements.js); as of 2026-09-02
// it also always runs for live_job/leadership_change regardless of tier
// (see resolveContactForSignal's alwaysRetryContactSearch) — these are the
// two types Michael has said must never be shown contact-less, so the
// guarantee can't depend on billing status. Other signal types (e.g. a
// funding/expansion signal at Starter tier that still comes back empty)
// remain tier-gated as before. Kept separate from FUNCTION_TITLE_BUCKETS
// rather than merged into it, since that constant's default export is also
// used unconditionally for every funding/expansion signal regardless of
// tier — folding these in there would have quietly widened (and re-costed)
// that path too. Real GCC production data (25 Aug 2026) showed the standard
// fallback still comes back empty on these two signal types more often
// than search budget alone explains — this is a second real attempt, not a
// bigger Anthropic search budget.
const EXTENDED_FUNCTION_TITLE_BUCKETS = {
  operations: ['COO', 'Head of Operations', 'VP Operations'],
  general_management: ['Managing Director', 'General Manager', 'Country Manager'],
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
export async function verifyContactsAcrossFunctions(apolloKey, company, supabase, apolloOrgId, functions = Object.keys(FUNCTION_TITLE_BUCKETS), bucketMap = FUNCTION_TITLE_BUCKETS, userId = null, caps = {}) {
  const results = await mapWithConcurrency(functions, 2, async (fn) => {
    const contact = await verifyContact(apolloKey, company, bucketMap[fn] || [fn], supabase, apolloOrgId, null, userId, caps)
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
// Exported (2026-08-26 audit fix) so apollo-enrich-companies.js can reuse
// this same guard — see that file's own fix comment for the bug this
// closes: it was taking Apollo's unguarded top search result unconditionally.
export function pickBestOrgMatch(candidates, company, locationHints = []) {
  if (!candidates?.length) return null
  const norm = (v) => (v || '').trim().toLowerCase().replace(/\s+/g, ' ')
  const target = norm(company)
  const exact = candidates.find((c) => norm(c.name) === target)
  if (exact) return exact
  // 2026-08-26: a plain string-exact match rejects "Acme Trading" vs
  // Apollo's own "Acme Trading FZE" as two different companies — a real,
  // structural miss for Annie's UAE/GCC customers specifically, whose
  // Apollo records commonly carry a legal-entity suffix (FZE/DMCC/PJSC/
  // WLL/...) the AI's news-derived company name never includes. This is
  // still an EXACT match, just on the legal-suffix-stripped name — not the
  // fuzzy containment companiesMatch() allows elsewhere — so it stays as
  // safe against the Stitch/Stitch Fix false-positive as the raw-string
  // check above, just blind to a suffix that isn't part of the real brand.
  const targetNormalized = normalizeCompanyName(company)
  if (targetNormalized) {
    const suffixInsensitive = candidates.find((c) => normalizeCompanyName(c.name) === targetNormalized)
    if (suffixInsensitive) return suffixInsensitive
  }
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

export async function enrichCompany(apolloKey, company, supabase, locationHints = [], userId = null, caps = {}) {
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
      // 2026-08-26 audit fix: same gap as verifyContact's contact-cache
      // read above — a query-level failure here (RLS denial, a bad filter)
      // resolves normally with `error` set rather than throwing, so it fell
      // through silently as if this were just an ordinary cache miss, with
      // nothing in the logs to explain why a company that should have been
      // cached got re-enriched (and re-charged an Apollo credit) anyway.
      const { data: cached, error } = await supabase
        .from('company_enrichment')
        .select('domain, industry, city, state, country, logo_url, matched, apollo_org_id, employee_count, enriched_at')
        .eq('company_name_key', cacheKey)
        .maybeSingle()
      if (error) console.error(`[scanShared] company_enrichment cache lookup failed for "${company}":`, error.message)
      // A cache row from before apollo_org_id existed (matched=true but the
      // new column is still null) is treated as a miss, not a hit — falls
      // through to a fresh lookup so it gets backfilled, rather than
      // returning apolloOrgId: null forever and silently breaking
      // verifyContact for every company enriched before today's fix.
      //
      // 2026-09-02 audit fix: same idea, applied to employee_count — a
      // matched row cached before the mega-employer filter existed never
      // captured a headcount, and without this check would return
      // employees: null forever (see EMPLOYEE_COUNT_BACKFILL_CUTOFF's own
      // header for the full reasoning: this is the exact class of company
      // the filter exists to catch). Bounded to one forced re-check per
      // company via enriched_at, so a company Apollo genuinely has no
      // headcount for doesn't get re-spent on every single scan forever.
      const needsEmployeeCountBackfill = cached?.matched && cached?.apollo_org_id &&
        cached?.employee_count == null &&
        (!cached.enriched_at || new Date(cached.enriched_at) < EMPLOYEE_COUNT_BACKFILL_CUTOFF)
      //
      // Always returns an object now, even for an unmatched company — a
      // cached row still carries whatever best-effort logo_url was resolved
      // below the first time this company was looked up, and "no company
      // shown without a logo" has to hold on a cache hit too, not just a
      // fresh lookup.
      if (cached && (!cached.matched || cached.apollo_org_id) && !needsEmployeeCountBackfill) {
        return {
          domain: cached.domain, industry: cached.industry, city: cached.city, state: cached.state,
          country: cached.country, logo_url: cached.logo_url, apolloOrgId: cached.apollo_org_id || null,
          matched: cached.matched,
          employees: cached.employee_count ?? null,
        }
      }
    } catch (err) {
      console.error(`[scanShared] company_enrichment cache lookup failed for "${company}":`, err.message)
    }
  }

  // 2. Cache miss — only now does this spend anything (the Apollo call;
  // the logo fallback below never spends a credit, Clearbit is free).
  let result = null
  if (apolloKey && (await reserveApolloCredits(supabase, userId, 1, caps))) {
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
        // 4th-pass audit fix: release the credit just reserved above — the
        // call failed outright, nothing was returned for it.
        await releaseApolloCredits(supabase, userId, 1)
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
            // 2026-09-02: captured for the mega-employer live_job filter
            // (see MEGA_EMPLOYER_HEADCOUNT_THRESHOLD's own header) — Apollo
            // already returns this on the exact same companies/search call
            // discoverHotCompanies already reads it from elsewhere in this
            // file, so this is data already being fetched, not a new call.
            employees: org.estimated_num_employees ?? null,
          }
        }
      }
    } catch (err) {
      console.error(`[scanShared] enrichCompany failed for "${company}":`, err.message)
      // 4th-pass audit fix: release the credit just reserved above — a
      // thrown error here means the call never produced a usable result.
      await releaseApolloCredits(supabase, userId, 1)
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
        employee_count: result?.employees ?? null,
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
    employees: result?.employees ?? null,
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
    // 2026-08-29 audit fix: still fails open on purpose (see this
    // function's own header — verification only ever upgrades a signal,
    // never blocks one), but a non-ok response used to be completely
    // silent, indistinguishable in the logs from "no matching company" —
    // same class of gap fixed above in discoverAdzunaJobs/
    // discoverHotCompanies, just lower stakes here since nothing downstream
    // depends solely on this succeeding.
    if (!searchResp.ok) {
      console.error(`[scanShared] Companies House search non-ok response for "${companyName}": ${searchResp.status}`)
      return null
    }
    const searchData = await searchResp.json()
    const items = searchData.items || []
    const best = items.find(c => c.company_status === 'active') || items[0]
    if (!best?.company_number) return null

    const officersResp = await fetchWithRetry(`https://api.company-information.service.gov.uk/company/${best.company_number}/officers?items_per_page=50`, {
      headers: { Authorization: authHeader },
    })
    if (!officersResp.ok) {
      console.error(`[scanShared] Companies House officers non-ok response for "${companyName}" (${best.company_number}): ${officersResp.status}`)
      return null
    }
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
// 2026-08-26: pulled out of buildEnrichedSignalRow so the exact same
// three-layer real-Apollo-data cascade can be re-run later, on demand, for
// ONE already-written signal — see resolve-signal-contact.js. Michael's own
// framing of why this exists: "we cannot have a situation where there is
// nothing in today's actions because no contacts were found" for a signal
// the customer explicitly chose from the Feed ("Add to Today's BD Actions"
// bypasses the signal-type whitelist already, per eligibility.js, but never
// bypassed the mandatory-contact requirement — a manual add on a
// contact-less signal used to silently do nothing, which read as a broken
// button, not as "Annie hasn't found anyone yet"). This function is what
// lets that click try harder in real time instead of failing silently:
// resolve-signal-contact.js calls this again, forcing the wider
// EXTENDED_FUNCTION_TITLE_BUCKETS pass regardless of the customer's tier
// (apolloContactRetry=true unconditionally there), since a single deliberate
// user click justifies the extra Apollo credit the way routine per-signal
// scanning at Starter tier doesn't.
//
// Never asks the AI for a contact, and never did — every layer here is a
// real Apollo lookup against real data. If a company genuinely has nobody
// findable across all three layers, this returns nothing found; that's
// still the honest, correct outcome, not a bug to route around.
//
// 2026-09-06, Michael, real report: a "Chief Financial Officer" live_job
// opening resolved "Askar U, Chief Accountant/Deputy CFO" as the verified
// contact, then separately wrote "approach the CEO or Regional Managing
// Director" in the card's own whoToApproach prose. The two fields
// disagreed because they're written by two completely independent steps
// (the AI's free-text whoToApproach vs. Apollo's raw fuzzy match on
// titleKeywords), with nothing anywhere cross-checking that the matched
// person could plausibly be the one hiring for the role. A Deputy CFO
// isn't the person who hires a CFO; they're a peer or subordinate.
//
// roleTitle (the open role's own headline, e.g. "Chief Financial Officer",
// separate from titleKeywords, which describes who to APPROACH, not the
// role being filled) lets this catch that specific mismatch: for a senior
// (C-suite/VP-level) opening, a matched contact whose own title reads as
// deputy/assistant/acting/interim can't be the hiring authority, so it is
// discarded below rather than accepted. That routes straight into the
// existing `!contact` fallback a few lines down, which already searches
// the `leadership` bucket (Founder/CEO/Managing Director/Owner, see
// FUNCTION_TITLE_BUCKETS) instead of inventing a second, parallel check.
const SENIOR_ROLE_TITLE_PATTERN = /\b(chief \w+ officer|ceo|cfo|coo|cto|president|managing director|vice president|\bvp\b)\b/i
const SUBORDINATE_CONTACT_TITLE_PATTERN = /\b(deputy|assistant|associate|acting|interim)\b/i

export function looksLikeSeniorRoleTitle(roleTitle) {
  if (!roleTitle) return false
  return SENIOR_ROLE_TITLE_PATTERN.test(roleTitle)
}

export function looksLikeSubordinateContactTitle(contactTitle) {
  if (!contactTitle) return false
  return SUBORDINATE_CONTACT_TITLE_PATTERN.test(contactTitle)
}

// True when a matched contact plainly can't be the hiring authority for
// this specific open role: a deputy/assistant/acting/interim title can
// never plausibly hire for a senior role above their own. This is a
// deliberately narrow, high-confidence check (a hard, unambiguous
// vocabulary match, same shape as looksLikeStaffingAgencyName), not a
// general seniority-ranking system. It does not catch every possible
// lateral-peer mismatch (e.g. a "Chief Accountant" with no "Deputy" in
// the title, approached for a CFO opening), only the specific, confident
// case a subordinate-flavored title makes obvious.
export function isImplausibleHiringContact(roleTitle, contactTitle) {
  return looksLikeSeniorRoleTitle(roleTitle) && looksLikeSubordinateContactTitle(contactTitle)
}

export async function resolveContactForSignal({ apolloKey, company, signalType, titleKeywords, appointedName, roleTitle, supabase, apolloOrgId, userId, apolloContactRetry = false, apolloCaps = {}, logPrefix = '' }) {
  const isFundingOrExpansion = ['funding', 'expansion'].includes(signalType)
  let contact = null
  let contactCandidates = []
  if (isFundingOrExpansion) {
    if (apolloOrgId) {
      contactCandidates = await verifyContactsAcrossFunctions(apolloKey, company, supabase, apolloOrgId, undefined, undefined, userId, apolloCaps)
    }
  } else {
    contact = await verifyContact(apolloKey, company, titleKeywords, supabase, apolloOrgId, appointedName, userId, apolloCaps)

    // See isImplausibleHiringContact's own header just above. A present
    // but implausible match (e.g. a Deputy CFO for a CFO opening) is
    // discarded here, before the `!contact` fallback below, so it falls
    // through into that same existing leadership-bucket search instead of
    // being accepted just because Apollo returned someone.
    if (contact && isImplausibleHiringContact(roleTitle, contact.title)) {
      console.log(`${logPrefix} discarding "${contact.name}, ${contact.title}" as the contact for a senior "${roleTitle}" opening, reads as subordinate to the role, not a plausible hiring authority over it`)
      contact = null
    }

    if (!contact && apolloOrgId) {
      contactCandidates = await verifyContactsAcrossFunctions(apolloKey, company, supabase, apolloOrgId, undefined, undefined, userId, apolloCaps)
    }
    // Growth/Team only during ordinary scanning for most signal types
    // (2026-08-25, see SCAN_TIER_CONFIG in entitlements.js): one more, wider
    // attempt across a different set of title buckets before accepting "no
    // contact" — see EXTENDED_FUNCTION_TITLE_BUCKETS's own header for why
    // this is normally gated by tier. resolve-signal-contact.js's
    // manual-retry path forces this on for every tier, since that call site
    // is a one-off, explicit user action, not routine per-signal scan cost.
    //
    // 2026-09-02: live_job and leadership_change are the exception — these
    // are the two types Michael has said must never come up contact-less
    // (a live_job with nobody to approach, or a new exec appointment nobody
    // can be pointed at, reads as "Annie found nothing" even though the
    // signal itself is real). Discovered via a real case (CAPIMAX, a
    // live_job signal) that never got this wider pass because the
    // customer's own subscription had lapsed to Starter-tier scan config —
    // gating the "always have a contact" guarantee on billing status for
    // exactly the two types meant to always have one defeats the point, so
    // for these two the wider pass now runs regardless of apolloContactRetry.
    // Funding/expansion don't need this override — they already go straight
    // to verifyContactsAcrossFunctions above, unconditionally, for every
    // tier.
    const alwaysRetryContactSearch = ['live_job', 'leadership_change'].includes(signalType)
    if (!contact && !contactCandidates.length && (apolloContactRetry || alwaysRetryContactSearch) && apolloOrgId) {
      contactCandidates = await verifyContactsAcrossFunctions(
        apolloKey, company, supabase, apolloOrgId,
        Object.keys(EXTENDED_FUNCTION_TITLE_BUCKETS), EXTENDED_FUNCTION_TITLE_BUCKETS, userId, apolloCaps,
      )
    }
  }
  return { contact, contactCandidates }
}

export async function buildEnrichedSignalRow(s, { userId, apolloKey, companiesHouseKey, supabase, logPrefix, locationHints = [], apolloContactRetry = false, apolloCaps = {}, resolveContacts = false }) {
  const isLiveJob = s.entryType === 'live_job'

  // 2026-09-02: cheapest possible check, before spending anything —
  // see looksLikeStaffingAgencyName's own header. A live_job entry posted
  // by another recruitment/staffing firm isn't a hiring lead at all (the
  // "contact" would be a rival recruiter, not a hiring manager), so this
  // is a hard drop, not a demotion — unlike the URL-shape check below,
  // there's no lesser signal type worth keeping it as.
  if (isLiveJob && looksLikeStaffingAgencyName(s.company)) {
    console.log(`${logPrefix} live_job entry for "${s.company}" dropped — company name reads as a staffing/recruitment agency, not the hiring employer`)
    return null
  }

  // 2026-09-06, Michael, real report: "COPADO User Group Hyderabad" and
  // "AWS User Group SE" surfaced as the company on a live_job entry, both
  // meetup/community pages, not hiring employers. Same reasoning and same
  // hard-drop treatment as the staffing-agency check just above (see
  // looksLikeCommunityOrGroupName's own header in agencyMatch.js). A
  // community group's own page is never the real hiring employer regardless
  // of how genuine the underlying job mention was.
  if (isLiveJob && looksLikeCommunityOrGroupName(s.company)) {
    console.log(`${logPrefix} live_job entry for "${s.company}" dropped, company name reads as a meetup/community/user group, not the hiring employer`)
    return null
  }

  // enrichCompany runs first, not in parallel with verifyContact: Apollo's
  // people-search now requires a resolved organization_id (see
  // verifyContact's header), which only enrichCompany's own company lookup
  // can provide — running them in parallel would mean verifyContact never
  // has an id to search with.
  const [companyInfo, chVerification, sourceVerified] = await Promise.all([
    enrichCompany(apolloKey, s.company, supabase, locationHints, userId, apolloCaps),
    s.signalType === 'leadership_change' ? verifyLeadershipChange(companiesHouseKey, s.company) : Promise.resolve(null),
    verifySourceUrl(s.sourceUrl),
  ])

  // 2026-09-02: backstop for an agency whose name gives no hint at all —
  // Apollo's own industry classification, not a guess from text. Checked
  // here (after enrichCompany, before the contact-lookup Apollo spend
  // below) so a company that slips past the name check still doesn't cost
  // an extra credit finding a "contact" who'd just be a rival recruiter.
  if (isLiveJob && isStaffingAgencyIndustry(companyInfo?.industry)) {
    console.log(`${logPrefix} live_job entry for "${s.company}" dropped — Apollo classifies this company's industry as "${companyInfo.industry}" (staffing/recruiting), not a genuine hiring employer`)
    return null
  }

  // 2026-09-02: see MEGA_EMPLOYER_HEADCOUNT_THRESHOLD's own header — a
  // household-name giant runs hiring entirely in-house, so a live opening
  // there has close to zero real chance of turning into a placement for an
  // external recruiter, real and easy-to-find as it is. Checked here (same
  // spot as the staffing-agency industry check just above) so a mega-
  // employer doesn't cost an extra Apollo contact-lookup credit either.
  if (isLiveJob && isMegaEmployer(companyInfo?.employees)) {
    console.log(`${logPrefix} live_job entry for "${s.company}" dropped — Apollo estimates ${companyInfo.employees} employees, at or above the mega-employer threshold (${MEGA_EMPLOYER_HEADCOUNT_THRESHOLD}); an external recruiter has essentially no real shot there`)
    return null
  }

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

  // 2026-08-27: whitelist is back to all four types (see eligibility.js's
  // own header comment — 2026-08-24's narrowing to just
  // ['leadership_change', 'live_job'] silently threw away every funding/
  // expansion signal's contact panel below instead of using it). The
  // constant itself lives in src/lib/todaysActions/eligibility.js, not
  // actionsEngine.js (that file doesn't exist in this codebase). This
  // function still enriches all four types the same way regardless of
  // which are currently whitelisted, on purpose — Today's Actions'
  // whitelist is a display-layer concern, not a reason to enrich some
  // signal types worse than others, and a signal can always reach Today's
  // Actions via the "Add to Today's BD Actions" manual bypass from the
  // Feed even on a day this list changes again.
  // Funding/expansion rarely have one obvious single contact the way a
  // named leadership appointment or a specific job posting does — see
  // verifyContactsAcrossFunctions's own header — so those two go straight
  // to the multi-function search instead of a single generic title-keyword
  // lookup that would usually come back empty anyway. live_job/
  // leadership_change keep their existing single-contact lookup as the
  // primary path, falling back to the same multi-function search only if
  // that comes back with nobody, so the "always a contact" guarantee holds
  // for all four types, not just the two with an obvious single person.
  //
  // 2026-09-04, the single biggest change in the rebuild. Contacts are NO
  // LONGER resolved at scan time by default.
  //
  // Every signal used to be enriched with a contact whether the recruiter
  // ever looked at it or not, because Today's Actions could not display a
  // signal without one. That is how five test tenants burned through a
  // 2,500-credit monthly Apollo plan in under two weeks, and it spent the
  // most on exactly the signals nobody opened.
  //
  // Now the Intelligence Feed shows every lead regardless (see
  // src/lib/stream/), and the contact is fetched when the recruiter clicks —
  // one deliberate act, against a monthly allowance they can see
  // (contactCreditsPerMonth in entitlements.js), through
  // resolve-signal-contact.js. Projected effect at 100 customers: roughly
  // 5,000 Apollo credits a month instead of ~90,000.
  //
  // resolveContacts is left as an explicit opt-in rather than deleted: the
  // manual resolve endpoint calls resolveContactForSignal directly, and a
  // future "pre-enrich my top N" feature would want this path back.
  let contact = null
  let contactCandidates = []
  if (resolveContacts) {
    ;({ contact, contactCandidates } = await resolveContactForSignal({
      apolloKey, company: s.company, signalType, titleKeywords: s.titleKeywords,
      appointedName: signalType === 'leadership_change' ? s.appointedName : null,
      // roleTitle: the open role's own headline (e.g. "Chief Financial
      // Officer"), separate from titleKeywords above which describes who to
      // approach, not the role being filled. See isImplausibleHiringContact's
      // own header for why this is needed.
      roleTitle: s.headline,
      supabase, apolloOrgId: companyInfo?.apolloOrgId, userId, apolloContactRetry, apolloCaps, logPrefix,
    }))
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
export async function buildEnrichedSignalRows(entries, { userId, apolloKey, companiesHouseKey, supabase, logPrefix, concurrency = 4, locationHints = [], apolloContactRetry = false, apolloCaps = {}, resolveContacts = false }) {
  const groups = new Map()
  for (const s of entries) {
    const key = normalizeCompanyKey(s.company)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }

  const groupRows = await mapWithConcurrency([...groups.values()], concurrency, async (group) => {
    const rows = []
    for (const s of group) {
      // 2026-09-02: buildEnrichedSignalRow returns null for a live_job entry
      // it's deliberately dropping (an agency-posted "role" — see its own
      // header) — never pushed, not even as a placeholder, so it simply
      // never reaches Today's BD Actions or the Feed.
      const row = await buildEnrichedSignalRow(s, { userId, apolloKey, companiesHouseKey, supabase, logPrefix, locationHints, apolloContactRetry, apolloCaps, resolveContacts })
      if (row) rows.push(row)
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
    // 2026-09-01 (Michael): added federaljobs.gov.ae, the real public UAE
    // Federal Government jobs board (verified live, not scrape-only, before
    // adding). Deliberately did NOT add Mawaheb, Nafis, or the FAHR
    // "Estiqtab" initiative here — all three are genuine UAE Emiratisation
    // programs, but none of them confirmed as a public, browsable vacancy
    // listing an AI web search could actually find results on (Mawaheb is a
    // placement/training hub, Nafis is primarily an employer subsidy/match
    // system, Estiqtab is an internal FAHR initiative) — add them once that's
    // confirmed rather than naming a source that quietly returns nothing.
    govPortal: 'MOHRE Careers / Dubai Careers / Tamm / federaljobs.gov.ae — official UAE government job portals; many public-sector openings never appear on a general board at all.',
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
  // Added 27 Aug 2026 following the pre-launch QA exercise, which found this
  // sector scanning genuinely thin (0 of its own discoveries in
  // annie_learned_sources, vs. real customer-CRM-sourced entries only) — the
  // exact "harder to find information" gap Michael flagged going in. NOTE:
  // an earlier draft of this entry anchored on public-affairs/lobbying
  // consultancies and federal IT contractors (APCO, FTI, Booz Allen,
  // Leidos, etc.) — Michael correctly caught that those are consulting
  // firms with government CLIENTS, not the government/public-sector
  // employers this sector is actually meant to represent, so the anchors
  // below are genuine government, semi-government and multilateral bodies
  // instead. This sector also doesn't map onto the "funding/expansion"
  // signal types the other two directories lean on the same way — a
  // government department doesn't raise a funding round — so each region's
  // discoveryHint below leans on leadership-appointment and new-mandate
  // coverage specifically, which is the BD-relevant event type that
  // genuinely does happen here (a new agency head, a newly stood-up unit).
  //
  // 2026-09-01 (Michael): restructured from one flat `anchors` array mixing
  // UK, UAE and US bodies together into `byLocation`, mirroring
  // REGIONAL_SOURCE_DIRECTORY/LIVE_JOB_BOARD_DIRECTORY — the flat version was
  // showing every customer all three regions' bodies regardless of which
  // markets they actually selected (a UK-only customer's prompt was being
  // told to check FAHR and Dubai Future Foundation, entirely irrelevant to
  // them). Fixed here as part of adding Private Equity/Financial Services
  // below, which would otherwise have repeated the exact same mistake.
  // discoveryHint per region deliberately does NOT introduce a second set of
  // press sources: REGIONAL_SOURCE_DIRECTORY above already names a real,
  // verified outlet for this exact sector in every region and every scan
  // already receives that via buildRegionalSourceHint — this just points
  // back at it, the same pattern Management Consulting's own hint uses,
  // rather than inventing a parallel list that could drift out of sync.
  'Government & Public Sector': {
    byLocation: {
      'United Kingdom': {
        // Central departments and the regulators/NDPBs most likely to have BD-relevant leadership moves.
        anchors: ['Cabinet Office', 'HM Treasury', 'Home Office', 'Ofcom', 'Competition and Markets Authority (CMA)'],
        discoveryHint: "Beyond these bodies, use this customer's own regional trade press already named above (Civil Service World) as the authority on leadership moves and newly created bodies or units — this sector doesn't have a single global ranking site the way consulting or law do — then check each body's own careers/press pages the same way.",
      },
      'UAE / GCC': {
        // Verified real government and semi-government bodies (not GREs like DEWA/ADNOC, which sit under their own sectors).
        anchors: ['Federal Authority for Government Human Resources (FAHR)', 'Dubai Future Foundation', 'Government Development and The Future Office (UAE)', 'Mohammed Bin Rashid School of Government (MBRSG)'],
        discoveryHint: "Beyond these bodies, use this customer's own regional trade press already named above (WAM) as the authority on leadership moves and newly created bodies or units, then check each body's own careers/press pages the same way.",
      },
      'United States': {
        // Federal bodies plus multilateral organisations that genuinely do use recruiters for policy roles.
        anchors: ['General Services Administration (GSA)', 'World Bank', 'International Monetary Fund (IMF)'],
        discoveryHint: "Beyond these bodies, use this customer's own regional trade press already named above (GovExec and Route Fifty) as the authority on leadership moves and newly created bodies or units, then check each body's own careers/press pages the same way.",
      },
    },
  },
  // 2026-09-01 (Michael): "all registered PE funds", not just a handful of
  // famous names — and the real, authoritative, self-updating source of that
  // is the regulators' own public registers, not a hand-typed list that goes
  // stale the moment a new fund registers. UK and US added same day, same
  // registry-first approach, once each was independently verified — never
  // guess a market's regulator or anchor names, add them once confirmed real
  // (an unverified list is worse than no list — see the Government & Public
  // Sector correction above for exactly why).
  'Private Equity': {
    byLocation: {
      'UAE / GCC': {
        // Verified: the three Abu Dhabi sovereign funds, Dubai's own, plus
        // two long-established independent regional PE firms — small enough
        // a set that missing any would be an obvious gap.
        anchors: ['Mubadala Investment Company', 'Abu Dhabi Investment Authority (ADIA)', 'ADQ', 'Investment Corporation of Dubai (ICD)', 'Gulf Capital', 'Investcorp'],
        discoveryHint: "Beyond these, the DFSA's public register (dfsa.ae/public-register/funds and dfsa.ae/public-register/firms) and ADGM's FSRA public register (adgm.com/public-registers/fsra) are the real authority here — every fund manager actually licensed to operate in DIFC or ADGM, the two free zones almost every UAE-based PE/VC/growth-equity fund registers through, is on one of these, kept current by the regulator itself rather than by us. Check both directly rather than relying on search alone to surface a fund that hasn't made news recently.",
      },
      'United Kingdom': {
        // Verified: the largest London-headquartered buyout firms.
        anchors: ['CVC Capital Partners', 'Permira', 'Cinven', 'Apax Partners', 'Bridgepoint'],
        discoveryHint: "Beyond these, the FCA's Financial Services Register (fca.org.uk/firms/financial-services-register) is the real authority — most UK-based fund managers, including the large majority of private equity and venture firms, are required to register with the FCA to operate, and the register is kept current by the regulator itself rather than by us. Check it directly rather than relying on search alone to surface a fund that hasn't made news recently.",
      },
      'United States': {
        // Verified: the largest US-headquartered PE firms by AUM.
        anchors: ['Blackstone', 'KKR', 'The Carlyle Group', 'Apollo Global Management', 'TPG', 'Warburg Pincus'],
        discoveryHint: "Beyond these, the SEC's Investment Adviser Public Disclosure database (adviserinfo.sec.gov/pubsearch) is the real authority — most US private equity firms above a modest size are required to register with the SEC as investment advisers, and the database is kept current by the regulator itself rather than by us. Check it directly rather than relying on search alone to surface a firm that hasn't made news recently.",
      },
    },
  },
  // 2026-09-01 (Michael): same registry-over-hand-list reasoning as Private
  // Equity above. UAE's authoritative register is the Central Bank's own
  // published "CB Register" (centralbank.ae) — most UAE banks are licensed
  // onshore by the Central Bank, not through the free zones, so DFSA/ADGM
  // are named as the secondary source for free-zone-licensed wealth
  // managers, insurers and fintech/payments firms that also sit under this
  // sector. UK and US added same day, same care as Private Equity above.
  'Financial Services': {
    byLocation: {
      'UAE / GCC': {
        anchors: ['Emirates NBD', 'First Abu Dhabi Bank (FAB)', 'Abu Dhabi Commercial Bank (ADCB)', 'Dubai Islamic Bank (DIB)', 'Mashreq', 'Abu Dhabi Islamic Bank (ADIB)'],
        discoveryHint: "Beyond these, the Central Bank of the UAE's own published register of every licensed bank (centralbank.ae) is the real authority, kept current by the regulator itself. For free-zone-licensed wealth managers, insurers and fintech/payments firms specifically, the DFSA (dfsa.ae/public-register/firms) and ADGM FSRA (adgm.com/public-registers/fsra) public registers cover those. Check the relevant one directly rather than relying on search alone to surface an institution that hasn't made news recently.",
      },
      'United Kingdom': {
        // Verified: the UK's largest retail/commercial banking groups.
        anchors: ['HSBC UK', 'Barclays', 'Lloyds Banking Group', 'NatWest Group', 'Santander UK'],
        discoveryHint: "Beyond these, the FCA's Financial Services Register (fca.org.uk/firms/financial-services-register) is the real authority on every firm regulated to operate in UK financial services — banking, insurance, wealth management, fintech and payments alike — kept current by the regulator itself. Check it directly rather than relying on search alone to surface a firm that hasn't made news recently.",
      },
      'United States': {
        // Verified: the largest US banking groups by assets.
        anchors: ['JPMorgan Chase', 'Bank of America', 'Wells Fargo', 'Citigroup', 'Goldman Sachs', 'Morgan Stanley'],
        discoveryHint: "Beyond these, the SEC's Investment Adviser Public Disclosure database (adviserinfo.sec.gov/pubsearch) is the real authority for registered investment advisers, wealth managers and broker-dealers — kept current by the regulator itself. Check it directly rather than relying on search alone to surface a firm that hasn't made news recently.",
      },
    },
  },
  // 2026-09-01 (Michael): new sector, UAE/GCC only — Dubai Land Department's
  // RERA arm publishes a public register of every licensed developer, the
  // same registry-over-hand-list reasoning as Private Equity/Financial
  // Services above, verified before adding. UK and US deliberately not
  // added: neither has a single national developer-licensing register the
  // way Dubai does (real estate regulation is fragmented/local in both), so
  // this stays UAE/GCC-only rather than guessing at an equivalent that may
  // not exist.
  'Real Estate': {
    byLocation: {
      'UAE / GCC': {
        // Verified: Dubai's and Abu Dhabi's largest, most established master developers.
        anchors: ['Emaar Properties', 'DAMAC Properties', 'Nakheel', 'Aldar Properties', 'Dubai Properties', 'Meraas'],
        discoveryHint: "Beyond these, Dubai Land Department's RERA register of licensed developers (dubailand.gov.ae) is the real authority — every developer legally permitted to sell property in Dubai is on it, kept current by the regulator itself rather than by us. Check it directly rather than relying on search alone to surface a developer that hasn't made news recently.",
      },
    },
  },
  // 2026-09-01 (Michael): new sector, global anchors — unlike Government &
  // Public Sector/Private Equity/Financial Services, the major players in
  // engineering & construction are genuinely the same handful of global
  // names in every market this customer might select, so this uses the flat
  // `anchors` shape like Management Consulting/Law rather than a
  // location split. discoveryHint points at ENR's own Top 250 Global
  // Contractors ranking (enr.com/toplists) — a real, independently
  // published, annually updated authority — rather than a hand-list, same
  // registry/ranking-over-guessing reasoning as everything else added today.
  Industrial: {
    anchors: ['Bechtel', 'Fluor Corporation', 'AECOM', 'Jacobs', 'Vinci', 'Bouygues'],
    discoveryHint: "Beyond these, ENR's (Engineering News-Record) Top 250 Global Contractors ranking (enr.com/toplists) is the real authority on who else is active — it ranks engineering, construction and EPC firms across every tier, not just the largest names, and is independently published and updated annually — for this customer's selected markets, then check those firms' own career pages the same way.",
  },
  // 2026-09-01 (Michael): new sector, United Kingdom only for now. CQC (Care
  // Quality Commission) publishes a genuinely public, searchable register of
  // every registered health and social care provider in England
  // (cqc.org.uk/care-services), including an open dataset
  // (data.gov.uk/dataset — "Care Quality Commission care directory") — a
  // real, government-run register, same reasoning as everywhere else added
  // today. UAE and US deliberately not added: UAE's healthcare regulators
  // (DHA, DOH, MOHAP, SHA) are real but a public, browsable register of
  // every licensed facility the way CQC has was not confirmed before
  // writing this, and the US has no single national equivalent (healthcare
  // facility licensing is state-by-state) — add either once a genuine
  // register is confirmed for it, not guessed at here.
  Healthcare: {
    byLocation: {
      'United Kingdom': {
        // Verified: the UK's largest private hospital/healthcare groups.
        anchors: ['Bupa', 'HCA Healthcare UK', 'Nuffield Health', 'Spire Healthcare', 'Ramsay Health Care UK'],
        discoveryHint: "Beyond these, the CQC's (Care Quality Commission) public register of every regulated care provider in England (cqc.org.uk/care-services) is the real authority, kept current by the regulator itself rather than by us. Check it directly rather than relying on search alone to surface a provider that hasn't made news recently.",
      },
    },
  },
  // 2026-09-01 (Michael): new sector, United Kingdom only for now. Ofgem
  // publishes its own list of every licensed electricity and gas supplier —
  // a real, government-run register, same reasoning as everywhere else
  // added today. UAE and US deliberately not added: UAE's major energy
  // players (DEWA, ADNOC, TAQA) are government-related entities rather than
  // license-registrants in the retail-supplier sense Ofgem covers, and the
  // US has no single national equivalent (energy is regulated state-by-state
  // via each state's Public Utilities Commission, plus FERC federally) — add
  // either once a genuine registry-style mechanism is confirmed for it.
  'Energy & Utilities': {
    byLocation: {
      'United Kingdom': {
        // Verified: the UK's largest household energy suppliers by market share.
        anchors: ['British Gas (Centrica)', 'Octopus Energy', 'EDF Energy', 'E.ON UK', 'SSE'],
        discoveryHint: "Beyond these, Ofgem's own published list of licensed electricity and gas suppliers (ofgem.gov.uk) is the real authority, kept current by the regulator itself rather than by us. Check it directly rather than relying on search alone to surface a supplier that hasn't made news recently.",
      },
    },
  },
  // 2026-09-01 (Michael): new sector, all three markets. No regulator
  // licenses a tech company, so unlike the register-backed sectors above,
  // this leans on real, independently published startup/scaleup tracking
  // sites as the discoveryHint authority — the closest thing this sector
  // has to a register, and each one already does exactly the "ones to
  // watch" job the wrapper instruction above asks for generally, so the
  // per-sector discoveryHint here names it explicitly rather than leaving
  // it to the generic instruction alone.
  //
  // Deliberately did NOT anchor on FAANG-tier names (Apple, Google,
  // Microsoft, Amazon, Meta) even though they're the most obvious tech
  // employers in every one of these markets — the base scan prompt already
  // tells Annie to "bias against obvious, oversaturated, famous names", and
  // every recruiter already targets those relentlessly. The anchors below
  // are instead real, substantial, but less oversaturated companies (UK/US)
  // or the market's genuine unicorn tier (UAE, where the ecosystem is small
  // enough that these ARE the obvious names, and still worth anchoring on
  // directly rather than relying on discovery alone).
  Technology: {
    byLocation: {
      'United Kingdom': {
        // Verified: notable UK fintech/tech scaleups and unicorns, not FAANG-adjacent.
        anchors: ['Revolut', 'Wise', 'Monzo', 'Darktrace', 'Deliveroo'],
        discoveryHint: "Beyond these, Sifted (sifted.eu/rankings) is the real authority on rising UK and European tech companies — a genuine, independently published \"ones to watch\" tracker, not a static list, regularly updated with new scaleups by sector. Check it directly for companies worth a proactive careers-page check.",
      },
      'UAE / GCC': {
        // Verified: the UAE's genuine unicorn/notable-scaleup tier.
        anchors: ['Careem', 'Tabby', 'Kitopi', 'Property Finder'],
        discoveryHint: "Beyond these, MAGNiTT (magnitt.com) is the real authority on MENA startups and funding activity — a genuine, independently published tracker covering the region's rising companies, not just the largest names. Check it directly for companies worth a proactive careers-page check.",
      },
      'United States': {
        // Verified: substantial, current US enterprise software/AI companies, deliberately not FAANG-tier.
        anchors: ['Salesforce', 'ServiceNow', 'Snowflake', 'Palantir Technologies', 'Databricks'],
        discoveryHint: "Beyond these, CB Insights (cbinsights.com) is the real authority on rising US tech companies and unicorns — a genuine, independently published \"ones to watch\" tracker, regularly updated. Check it directly for companies worth a proactive careers-page check.",
      },
    },
  },
  // 2026-09-01 (Michael): new sector, all three markets. Like Technology, no
  // regulator licenses a retailer, so this leans on real published industry
  // rankings as the discoveryHint authority — unlike Technology though,
  // recruiting into major retailers isn't the same kind of oversaturated
  // target FAANG is for tech, so anchors here follow the same
  // biggest-genuine-players pattern as Financial Services/Real Estate
  // rather than deliberately avoiding the obvious names.
  'Consumer & Retail': {
    byLocation: {
      'United Kingdom': {
        // Verified: the UK's largest retailers by sales.
        anchors: ['Tesco', "Sainsbury's", 'John Lewis Partnership', 'Marks & Spencer'],
        discoveryHint: "Beyond these, Retail Week's own rankings (retail-week.com/retail-rankings, including the annual Retail 100 and Top Ecommerce Retailers lists) are the real authority on who else is active, big and rising — a genuine, independently published, regularly updated ranking, not a static list. Check it directly for companies worth a proactive careers-page check.",
      },
      'UAE / GCC': {
        // Verified: the UAE's largest retail/consumer conglomerates.
        anchors: ['Majid Al Futtaim', 'Chalhoub Group', 'Landmark Group'],
        discoveryHint: "Beyond these three conglomerates and the individual retail brands they own, this customer's own regional trade press already named above (Hotelier Middle East, plus Zawya/Arabian Business/Gulf Business generally) is the real authority on rising consumer/retail names — no single dedicated retail ranking site was confirmed for this market the way Retail Week/NRF cover the UK/US, so lean on that press coverage directly, then check each firm's own careers page the same way.",
      },
      'United States': {
        // Verified: the largest US retailers by revenue, per NRF's own ranking.
        anchors: ['Walmart', 'Amazon', 'Costco', 'Target', 'The Home Depot'],
        discoveryHint: "Beyond these, the National Retail Federation's own Top 100 Retailers ranking (nrf.com/research-insights/top-retailers) is the real authority — and NRF separately publishes a \"Hot 25 Retailers\" list specifically for the fastest-growing, most-watched names, exactly the \"ones to watch\" tier worth surfacing here. Check both directly for companies worth a proactive careers-page check.",
      },
    },
  },
}

// Composes the proactive firm-tier check-list for the prompt, mirroring
// buildRegionalSourceHint's shape and only-what-they-selected discipline —
// only fires for a customer who actually selected a sector with an entry
// here, so nobody else's prompt grows for a mechanism they don't use.
// `learned` layers in every firm Annie has already discovered beyond the
// seed anchors (see getLearnedSources) so the list actually reflects big
// firms down to boutique ones as it grows, not just the original seed.
//
// 2026-09-01 (Michael): now takes `locations` too. TARGET_FIRM_DIRECTORY
// entries come in two shapes — { anchors, discoveryHint } for a sector whose
// major players are genuinely global (Management Consulting, Law: a Big 4 or
// Magic Circle firm is worth checking in every market this customer
// selected, no split needed), and { byLocation: { <LOCATIONS value>: {
// anchors, discoveryHint } } } for a sector where "who the major players
// are" is inherently market-specific (Government & Public Sector, Private
// Equity, Financial Services). The location-keyed shape only ever surfaces
// the markets this customer actually picked, and only the ones actually
// researched — a market with no entry yet simply contributes nothing rather
// than guessing, exactly like LIVE_JOB_BOARD_DIRECTORY/
// REGIONAL_SOURCE_DIRECTORY already handle an unresearched market elsewhere
// in this file.
export function buildTargetFirmHint(sectors, learned, locations) {
  const parts = (sectors || []).map(sector => {
    const dir = TARGET_FIRM_DIRECTORY[sector]
    if (!dir) return null
    const learnedNames = learned?.companies?.[sector] || []
    if (dir.anchors) {
      const names = [...new Set([...dir.anchors, ...learnedNames])]
      if (!names.length) return null
      return `${sector} — firms worth checking directly regardless of whether they've come up as a signal yet (${names.length} tracked so far, seed anchors plus everything discovered since): ${names.join(', ')}. ${dir.discoveryHint}`
    }
    const locDirs = (locations || []).map(loc => dir.byLocation?.[loc]).filter(Boolean)
    const seedAnchors = locDirs.flatMap(d => d.anchors)
    const names = [...new Set([...seedAnchors, ...learnedNames])]
    if (!names.length) return null
    const hints = locDirs.map(d => d.discoveryHint).join(' ')
    return `${sector} — firms worth checking directly regardless of whether they've come up as a signal yet (${names.length} tracked so far, seed anchors plus everything discovered since): ${names.join(', ')}.${hints ? ` ${hints}` : ''}`
  }).filter(Boolean)
  if (!parts.length) return ''
  return `\nThis customer targets a sector with well-known major players, so proactively check these specific firms' own career pages too, the same way as the per-company follow-up check above, rather than waiting for them to surface as a signal first:\n${parts.join('\n')}\nCrucially, do not stop at these seed names — this recruiter almost certainly already knows the biggest, most obvious firms in their sector. The real value is in the ones they don't already know about: use the full depth of the named register/ranking source above (a register like the FCA's or DFSA's lists EVERY licensed firm, not just the famous ones; a ranking site like Legal 500/Chambers/consultancy-me.com/ENR covers Tier 2, boutique and challenger firms alongside the household names), and separately search for "ones to watch", "rising stars", "emerging manager", "40 under 40" or "startups/firms to watch" style coverage in this customer's own named regional trade press (already listed above) — smaller, newer, faster-growing firms are exactly the kind of lead a recruiter values most, precisely because their competitors haven't found them yet. For every firm this surfaces, seed name or newly found, do the same direct check: search its own careers/jobs page for a real, specific opening right now, the same way as the per-company follow-up check above — an emerging firm that's actively hiring is a live BD opportunity, not just a name on a list.\nThis list should keep growing: if you find a real, verifiable firm active in this customer's markets this way, big or boutique, well-known or genuinely emerging, that isn't already in this list, report it as an "annie_learned" entry (kind "company", see the output format below) so it's added for next time — this is exactly how the list above grew past its original starting set.\n`
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
// been scanned for years doesn't grow into an unbounded prompt.
//
// 2026-08-27, Michael, after reviewing the original 100-per-sector cap:
// "I think we need to up that cap... are you happy how Annie applies these
// learnings, or do you see any gaps?" Two real things fixed here together,
// not just the number:
//
// 1) Raised 100 -> 300, giving real multi-year headroom before any sector
//    gets anywhere near it, while still bounding the worst case (only
//    buildTargetFirmHint, for Law/Management Consulting, puts the entire
//    per-sector list straight into the prompt with no further slicing —
//    every other sector's hint already caps at 30 regardless of this
//    number, see buildRegionalSourceHint above). Deliberately NOT
//    uncapped — an unbounded list here is an unbounded, permanently
//    compounding Anthropic input-token cost for whichever sector grows
//    the most, with real diminishing returns past a few hundred names
//    (Annie's own per-call search budget can't meaningfully act on
//    hundreds of named targets in one pass anyway).
// 2) FIXED A REAL BUG: this used to order by first_seen_at ASCENDING, so
//    once a sector's list filled up, the OLDEST-ever-discovered entries
//    permanently occupied every slot — brand new discoveries (exactly the
//    "Annie getting smarter over time" this whole mechanism exists for)
//    would never surface in a prompt again once that ceiling was hit, even
//    though they were the freshest, most-likely-still-relevant ones. Now
//    orders by last_confirmed_at DESCENDING instead — the most recently
//    (re)confirmed-active entries win the available slots, so genuinely
//    stale, no-longer-relevant old entries are what age out first, not
//    whatever happened to be discovered first. See recordLearnedDiscoveries
//    below for the matching fix that makes last_confirmed_at actually mean
//    something for Annie's own rediscoveries, not just customer CRM adds.
const LEARNED_PER_SECTOR_CAP = 300

// Raised alongside the per-sector cap above, with headroom for the realistic
// worst case: 11 top-level sectors (see sectorTaxonomy.js) x 2 kinds
// (company + source) x 300 = 6,600 rows needed to fully populate every
// bucket if a customer selected every sector on the signup form. 8,000
// leaves comfortable margin above that without being open-ended.
const LEARNED_SOURCES_QUERY_LIMIT = 8000

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
      .order('last_confirmed_at', { ascending: false })
      .limit(LEARNED_SOURCES_QUERY_LIMIT)
    // 2026-08-26 audit fix: `error` was already checked (so a query-level
    // failure correctly falls back to `empty` instead of being mistaken for
    // "no learned sources yet"), but it was never logged — silently
    // indistinguishable from the genuinely-empty case in Netlify's own logs.
    if (error) console.error('[scanShared] failed to read annie_learned_sources', error.message)
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

// Same junk-value denylist as learn_company_for_sectors's v_junk_values in
// 2026-08-27-learned-sources-quality-guard.sql, kept in sync deliberately —
// see the asymmetry note on recordLearnedDiscoveries below for why this
// exists on the JS write path too, not just the SQL one.
const LEARNED_SOURCE_JUNK_VALUES = new Set([
  'na', 'n a', 'none', 'unknown', 'test', 'testing', 'tbc', 'tbd', 'tba',
  'xxx', 'asdf', 'nil', 'temp', 'temporary', 'sample', 'example', 'dummy',
  'placeholder', 'company', 'client', 'prospect', 'various', 'n', 'x',
])

// Same two guards as learn_company_for_sectors's SQL-side check: a minimum
// length of 2 on the normalized key (catches a stray single character while
// still letting real short/initialism names like "EY", "BP", "3M" through —
// they normalize to 2+ characters), and the shared denylist above. Exported
// so its tests can exercise it directly alongside recordLearnedDiscoveries.
export function isJunkLearnedSourceValue(normalizedKey) {
  if (!normalizedKey || normalizedKey.length < 2) return true
  return LEARNED_SOURCE_JUNK_VALUES.has(normalizedKey)
}

// Writes new companies/sources Annie found this scan back to the shared
// table above so her list keeps growing — this is the actual "evolve and
// get better" half of the mechanism, not just a one-time seed.
//
// 2026-08-27 bug fix (found while addressing Michael's "are you happy how
// Annie applies these learnings" question): this used to upsert with
// ignoreDuplicates: true (ON CONFLICT DO NOTHING) — so re-discovering
// "Deloitte" for the hundredth time correctly avoided a duplicate ROW, but
// also silently skipped ever refreshing last_confirmed_at, meaning it stayed
// frozen at whatever the very first insert set it to, forever, for
// EVERYTHING Annie discovered through her own research. Only the separate
// customer-CRM-add trigger (learn_company_for_sectors, see
// 2026-08-27-learn-from-customer-crm.sql) was ever correctly bumping that
// timestamp on a repeat. Since getLearnedSources above now orders by
// last_confirmed_at to decide which entries stay visible once a sector
// nears its cap, that timestamp needs to actually mean "still genuinely
// active" for the bulk of what's in this table — Annie's own rediscoveries,
// not just customer CRM adds. Now a real upsert (ON CONFLICT DO UPDATE,
// Supabase's default merge behavior once ignoreDuplicates is dropped) that
// explicitly stamps last_confirmed_at fresh on every write, matching the SQL
// trigger's own behavior exactly. first_seen_at is deliberately left out of
// the upserted columns, so a repeat write still never overwrites the
// original discovery date — only "still active" freshness updates.
//
// 2026-08-27 follow-up asymmetry fix: the SQL write path
// (learn_company_for_sectors, customer CRM adds) got a junk-value/min-length
// guard the same day this function's own bug above was fixed, but this path
// — Annie's own AI-discovered companies/sources — didn't get the matching
// guard at the time. Same table, same risk: a malformed or placeholder-ish
// value from a scan (a mis-parsed fragment, a generic "Company" the model
// echoed back) would otherwise permanently seed itself into every future
// scan prompt for that sector, exactly like the customer-CRM gap did. Now
// filtered through the same isJunkLearnedSourceValue check, keyed off the
// same normalized value_key already computed for the dedup constraint, so a
// value is judged consistently regardless of which path wrote it.
//
// 2026-09-01 bug fix (Michael): every row ever written by this function
// landed as location='Global', seeds and AI discoveries alike, because
// buildScanPrompt's "annie_learned" entry schema never actually asked the
// AI for a location, so `e.location` was always undefined and this
// fallback fired every single time. getLearnedSources's own read side was
// already correct (it filters on the customer's own locations plus
// 'Global') — the whole per-market half of "Annie learns by sector AND
// market" was silently inert, a GCC recruiter and a UK recruiter drawing
// on an identical learned set. Fixed on the prompt side (both scan files'
// annie_learned schema now requires a location, using this customer's own
// onboarding.locations strings so it round-trips exactly). This
// normalizeLearnedLocation guard is the write-side backstop: an AI
// response is free text, and a near-miss (wrong case, stray whitespace, a
// region synonym the model used instead of the canonical spelling) would
// otherwise write a real, non-junk row that getLearnedSources's exact
// `.in('location', ...)` match can never find again — invisible, not
// wrong, which is worse. Snapping anything that isn't a recognized region
// back to 'Global' keeps every row at least findable (Global is always
// read) rather than silently orphaned.
const KNOWN_LEARNED_LOCATIONS = new Map(
  Object.keys(REGIONAL_SOURCE_DIRECTORY).map(loc => [loc.trim().toLowerCase(), loc])
)
export function normalizeLearnedLocation(location) {
  if (!location) return 'Global'
  const trimmed = String(location).trim()
  if (trimmed.toLowerCase() === 'global') return 'Global'
  return KNOWN_LEARNED_LOCATIONS.get(trimmed.toLowerCase()) || 'Global'
}

export async function recordLearnedDiscoveries(supabase, entries) {
  if (!supabase || !entries?.length) return
  const nowIso = new Date().toISOString()
  const rows = entries
    .filter(e => e?.kind && e?.sector && e?.value)
    .map(e => ({
      kind: e.kind,
      sector: e.sector,
      location: normalizeLearnedLocation(e.location),
      value: e.value,
      value_key: normalizeCompanyKey(e.value),
      found_via: e.foundVia || 'discovered',
      last_confirmed_at: nowIso,
    }))
    .filter(row => !isJunkLearnedSourceValue(row.value_key))
  if (!rows.length) return
  try {
    const { error } = await supabase
      .from('annie_learned_sources')
      .upsert(rows, { onConflict: 'kind,sector,location,value_key' })
    if (error) console.error('[scanShared] failed to record learned discoveries', error.message)
  } catch (err) {
    console.error('[scanShared] failed to record learned discoveries', err.message)
  }
}

// 2026-08-27, Michael: "how do we get into a situation where if one
// customer has the same market choices as another, our brain/back ops is
// able to realise that, and share the same data between multiple
// consultants... maybe this could also save credits?" — this is the same
// principle company_enrichment/company_contacts/annie_learned_sources
// already use (an objective fact, once discovered, benefits every other
// account researching the same market — see getLearnedSources's own header
// above for that exact reasoning), extended up one more level: from "which
// companies/sources are worth checking" to the actual signal EVENT itself
// (the funding round, the leadership appointment, the live job posting).
//
// What gets pooled is deliberately narrow: the discovered FACT and Annie's
// own factual/analytical reasoning about it (whyItMatters, candidateAngle,
// benchStrengthAngle, whoToApproach, candidateProfile, likelyRoles) — never
// introMessage, which is written to explicitly name one specific
// recruiter's own firm ("their firm is called X") and can never be reused
// for a different one. See personalizePoolHits below, which regenerates
// introMessage (and re-voices the rest in this recruiter's own tone) fresh
// for every consumer — the discovery is shared, the interpretation isn't.
//
// A signal is only ever pooled once genuinely new to the customer whose
// scan found it (never a pool-hit consuming its own source), and matching
// a pool entry back to a DIFFERENT customer later is based on whether that
// customer's own profile overlaps the ORIGINAL discoverer's sectors/
// locations (and, for a live_job entry specifically, functions too) — see
// fetchSignalPoolMatches below.
export const SIGNAL_POOL_SCAN_LIMIT = 300

export async function writeToSignalPool(supabase, entries, ob) {
  if (!supabase || !entries?.length) return
  const sectorsHint = ob?.sectors || []
  const locationsHint = ob?.locations || []
  const functionsHint = ob?.functions || []
  const rows = entries
    .filter(e => e?.company && e?.headline)
    .map(e => ({
      dedup_key: normalizeKey(e.company, e.headline, e.sourceUrl),
      entry_type: e.entryType === 'live_job' ? 'live_job' : 'signal',
      signal_type: e.signalType || null,
      company: e.company,
      headline: stripAiArtifacts(e.headline),
      why_it_matters: stripAiArtifacts(e.whyItMatters) || null,
      source_url: e.sourceUrl || null,
      source_label: e.sourceLabel || null,
      event_at: toEventIso(e.eventDate),
      who_to_approach: stripAiArtifacts(e.whoToApproach) || null,
      appointed_name: e.appointedName || null,
      title_keywords: Array.isArray(e.titleKeywords) ? e.titleKeywords.slice(0, 6) : [],
      candidate_angle: stripAiArtifacts(e.candidateAngle) || null,
      bench_strength_angle: stripAiArtifacts(e.benchStrengthAngle) || null,
      candidate_profile: sanitizeCandidateProfile(e.candidateProfile),
      likely_roles: sanitizeStringList(e.likelyRoles, 5),
      sectors_hint: sectorsHint,
      locations_hint: locationsHint,
      functions_hint: functionsHint,
      found_at: new Date().toISOString(),
    }))
  if (!rows.length) return
  try {
    // First discoverer wins on a dedup_key collision — the fact itself
    // doesn't change based on who found it second, so there's nothing to
    // update, only a no-op to skip.
    const { error } = await supabase.from('signal_pool').upsert(rows, { onConflict: 'dedup_key', ignoreDuplicates: true })
    if (error) console.error('[scanShared] signal_pool write-through failed:', error.message)
  } catch (err) {
    console.error('[scanShared] signal_pool write-through failed:', err.message)
  }
}

// A pooled signal several independent customers have already dismissed,
// with not one of them ever acting on it (added it to Today's BD Actions,
// or it led to a placement — see the real stage values in
// signalOutcomes.js/IntelligenceFeed.jsx/Candidates.jsx), is a real,
// learnable fact about that signal's quality — see
// 2026-08-27-signal-pool-quality-feedback.sql for how dismiss_count/
// positive_count actually get populated (a DB trigger off signal_outcomes,
// not application code, so every existing outcome call site already
// contributes with no frontend change). Deliberately a small, defensible
// bar rather than a single dismissal counting against it: one recruiter
// dismissing something is just as likely to be "not relevant to me right
// now" as "this is a bad signal", three independent dismissals with zero
// positive outcomes across that many different accounts is a much stronger
// signal it's genuinely not landing with anyone. This never deletes the
// row or stops it being written — it only stops it being RECOMMENDED to a
// new pool consumer going forward.
const POOL_QUALITY_DISMISS_THRESHOLD = 3

// Reads recent global pool entries and filters, in JS, to ones this
// specific customer's own profile could plausibly have found themselves —
// at least one sector AND one location in common with whoever discovered
// it (a live_job entry additionally needs a function in common, since a
// specific open role's relevance is tied to a function in a way a
// company-wide funding/leadership signal isn't). Filtering here rather
// than via a jsonb containment query keeps this simple to read and test;
// SIGNAL_POOL_SCAN_LIMIT keeps the read itself bounded regardless of how
// large the pool grows, the same discipline LEARNED_PER_SECTOR_CAP applies
// to annie_learned_sources above. existingKeys excludes anything this
// customer already has on file (including a pool hit they already
// consumed on an earlier round of the same chain), same set already
// computed for the ordinary dedup check every scan does.
export async function fetchSignalPoolMatches(supabase, ob, existingKeys, limit) {
  if (!supabase || !limit) return []
  const cutoff = new Date(Date.now() - SIGNAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  try {
    const { data, error } = await supabase
      .from('signal_pool')
      .select('*')
      .gte('found_at', cutoff)
      .order('found_at', { ascending: false })
      .limit(SIGNAL_POOL_SCAN_LIMIT)
    if (error) {
      console.error('[scanShared] signal_pool read failed:', error.message)
      return []
    }
    const sectors = new Set(ob?.sectors || [])
    const locations = new Set(ob?.locations || [])
    const functions = new Set(ob?.functions || [])
    const overlaps = (arr, set) => Array.isArray(arr) && arr.some(v => set.has(v))
    const matches = (data || []).filter(row => {
      if (existingKeys?.has(row.dedup_key)) return false
      if (!overlaps(row.sectors_hint, sectors)) return false
      if (!overlaps(row.locations_hint, locations)) return false
      if (row.entry_type === 'live_job' && functions.size && !overlaps(row.functions_hint, functions)) return false
      if ((row.dismiss_count || 0) >= POOL_QUALITY_DISMISS_THRESHOLD && !(row.positive_count > 0)) return false
      return true
    })
    return matches.slice(0, limit)
  } catch (err) {
    console.error('[scanShared] signal_pool read failed:', err.message)
    return []
  }
}

// Deliberately a MUCH cheaper call than the discovery call it's replacing
// for these entries: no web_search tool (no search round-trips), a small
// fixed token budget, one batched call covering every pool hit this run
// instead of one call per signal. The expensive part — finding the fact in
// the first place — already happened once, globally, when the first
// customer's own scan discovered it; this only ever writes new prose
// around an already-known, already-verified fact for whichever new
// recruiter is seeing it for the first time. Returns entries shaped
// exactly like a fresh AI discovery's raw output, so callers can merge
// pool hits and freshly-discovered signals through the exact same
// downstream path (buildEnrichedSignalRows) without a special case.
//
// Deliberately does NOT reserve its own Anthropic token budget here — both
// callers (scan-now-background.js, intelligence-scan.js) already import
// reserveAnthropicTokens directly for their own callAnthropic, and this
// module intentionally never imports aiUsage.js itself (aiUsage.js already
// imports FROM this file — alertIfConfigured — so importing back would be
// a circular dependency between the two). Callers must reserve
// POOL_PERSONALIZE_MAX_TOKENS themselves before calling this, exactly the
// same shape as every existing call to callAnthropic already does.
export const POOL_PERSONALIZE_MAX_TOKENS = 3000

// onUsage, when given, is called exactly once with the number of tokens
// Anthropic actually billed — 0 when the call failed and billed nothing.
// 2026-09-04: callers reserve POOL_PERSONALIZE_MAX_TOKENS (3000) up front and,
// until now, nothing ever gave any of it back. Both failure paths below
// returned [] with the full 3000 still counted against that customer's daily
// cap, and even a successful call left the worst case on the books rather than
// the ~few hundred tokens it really cost. This module cannot import aiUsage.js
// to reconcile directly (aiUsage.js imports alertIfConfigured FROM here, so it
// would be circular), hence the callback.
export async function personalizePoolHits(anthropicKey, poolHits, ob, onUsage = null) {
  const reportUsage = (tokens) => {
    if (typeof onUsage !== 'function') return
    try { onUsage(tokens) } catch { /* accounting must never break a scan */ }
  }
  if (!anthropicKey || !poolHits?.length) {
    reportUsage(0)
    return []
  }
  const firmClause = ob?.firm_name ? ` by name (their firm is called "${ob.firm_name}")` : ' generically (no firm name is on file — do not invent one)'
  const prompt = `You are Annie, an expert BD researcher for a recruitment firm.
This recruiter's firm: introduce it${firmClause}.
Communication tone: ${ob?.tone || 'professional'}.
${ob?.writing_style ? `The recruiter's real writing style, follow this closely:\n${ob.writing_style}\n` : ''}
Below are BD signals Annie already discovered and verified for other recruiters researching overlapping markets — the facts are already confirmed real, do not re-research, question, or change them. Your only job is to write THIS recruiter's own version of the outreach text for each one.

${poolHits.map((h, i) => `Signal ${i}: company="${h.company}", headline="${h.headline}", signalType="${h.signal_type || 'n/a'}", factsSoFar="${h.why_it_matters || ''}", candidateAngleSoFar="${h.candidate_angle || ''}"`).join('\n')}

For each signal (by its index), write:
- whyItMatters: 1-2 sentences, plain natural prose, explaining what this news means for THIS recruiter's business right now — you may draw on factsSoFar's reasoning but write your own version in this recruiter's own tone. No citation markup or bracketed references.
- introMessage: the BODY of a ready-to-send outreach message, 3 short paragraphs separated by a blank line, no greeting or sign-off at the start/end (the app adds those automatically using the real contact and recruiter names). Paragraph 1: a brief warm opening line (for signalType "leadership_change", instead congratulate them on the new role). Paragraph 2: introduces the recruiter's firm as above, states what this recruiter specialises in recruiting for tailored to this exact signal, explains the insight in plain language, names relevant regional experience, and closes on being a value-adding partner through the recruiter's candidate network. Paragraph 3: a short close simply asking for a call. Natural prose, no em dashes/en dashes as connectors, no template brackets, finished sendable text only.
- candidateAngle: same intent as candidateAngleSoFar, rewritten in this recruiter's own voice, phrased as an opening gambit not a guarantee; leave blank if it doesn't call for one.
- benchStrengthAngle: a positioning pitch naming 1-2 real, specific peer companies to ${'`company`'}, in this recruiter's own voice; leave blank if you cannot confidently name genuine ones.
- whoToApproach: the specific person or role to approach and why.

Return a single JSON array, one object per signal, each with exactly: { "index": <number>, "whyItMatters": "...", "introMessage": "...", "candidateAngle": "...", "benchStrengthAngle": "...", "whoToApproach": "..." }. Only return the JSON array, nothing else.`

  try {
    const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: POOL_PERSONALIZE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, 30000, 1)
    if (!resp.ok) {
      console.error('[scanShared] pool personalization call failed:', resp.status)
      reportUsage(0)
      return []
    }
    const data = await resp.json()
    // Anthropic reports what it billed; hand the difference back.
    const u = data?.usage
    if (u) {
      const billed = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
        + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
      if (billed > 0) reportUsage(billed)
    }
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
    const parsed = extractJson(text)
    return poolHits.map((h, i) => {
      const p = parsed.find(x => x?.index === i) || {}
      return {
        entryType: h.entry_type,
        company: h.company,
        signalType: h.signal_type,
        headline: h.headline,
        whyItMatters: p.whyItMatters || h.why_it_matters || '',
        sourceUrl: h.source_url,
        sourceLabel: h.source_label,
        eventDate: h.event_at ? h.event_at.slice(0, 10) : null,
        whoToApproach: p.whoToApproach || h.who_to_approach || '',
        appointedName: h.appointed_name || null,
        titleKeywords: h.title_keywords || [],
        introMessage: p.introMessage || '',
        candidateAngle: p.candidateAngle || h.candidate_angle || '',
        benchStrengthAngle: p.benchStrengthAngle || h.bench_strength_angle || '',
        candidateProfile: h.candidate_profile || {},
        likelyRoles: h.likely_roles || [],
      }
    })
  } catch (err) {
    console.error('[scanShared] pool personalization call failed:', err.message)
    reportUsage(0)
    return []
  }
}

// "Annie always learning" extension #2 (2026-08-27): the 19-scenario
// staged audit earlier this session was a one-time manual snapshot of
// which sector/location combinations produce thin results. This is what
// makes that an ongoing, self-updating fact instead — one row logged per
// scan attempt, whether or not it found anything, so a market that's
// genuinely thin (many attempts, consistently nothing) is distinguishable
// from one that just hasn't come up yet (few or no attempts). See
// 2026-08-27-market-coverage-log.sql for the table this writes/reads.
export async function logMarketCoverage(supabase, ob, foundCount) {
  if (!supabase) return
  try {
    const { error } = await supabase.from('market_coverage_log').insert({
      user_id: ob?.user_id || null,
      sectors: ob?.sectors || [],
      locations: ob?.locations || [],
      functions: ob?.functions || [],
      found_count: foundCount || 0,
    })
    if (error) console.error('[scanShared] market_coverage_log write failed:', error.message)
  } catch (err) {
    console.error('[scanShared] market_coverage_log write failed:', err.message)
  }
}

const MARKET_COVERAGE_SCAN_LIMIT = 5000

// Aggregates raw scan-attempt rows into one line per (sector, location)
// pair actually targeted by real customers — attributing one log row to
// every pair it covers (a customer with 3 sectors and 2 locations
// contributes to all 6 pairs their profile spans), same "attribute a fact
// to every combination it's relevant to" approach signal_pool's own
// sectors_hint/locations_hint matching already uses. `thin` marks a pair
// with real, repeated evidence (enough distinct customers, enough scan
// attempts) and zero signals found across all of it — the actual,
// evolving answer to "is this combination worth offering on the signup
// form", computed from Annie's own history rather than a one-off audit.
// 2026-08-27, Michael: "anything else worth checking in terms of annie's
// learning and application?" — a "thin" pair above (real, repeated scan
// attempts, consistently nothing found) is ambiguous on its own: it reads
// the same whether the market genuinely has nothing going on, or Annie
// simply doesn't yet know which companies/sources to check there (a sector
// she has few or no annie_learned_sources rows for). Below this many
// combined companies+sources known for a sector, "thin" is more likely
// "Annie's under-informed here" than "genuinely quiet" — worth a look at
// what she's actually searching for before concluding the market itself is
// the problem. This is a coarse, sector-level signal (annie_learned_sources
// rows are overwhelmingly logged with location 'Global' — see
// learn_company_for_sectors and recordLearnedDiscoveries's own defaults —
// so a genuinely location-specific "known companies" count isn't something
// the data actually supports yet; sector-level is the honest granularity
// available today).
const MARKET_COVERAGE_UNINFORMED_THRESHOLD = 5

export async function getMarketCoverageReport(supabase, { sinceDays = 30, minScans = 5, minCustomers = 3 } = {}) {
  if (!supabase) return []
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
  try {
    const { data, error } = await supabase
      .from('market_coverage_log')
      .select('user_id, sectors, locations, found_count')
      .gte('ran_at', cutoff)
      .limit(MARKET_COVERAGE_SCAN_LIMIT)
    if (error) {
      console.error('[scanShared] market_coverage_log read failed:', error.message)
      return []
    }
    const pairs = new Map()
    for (const row of data || []) {
      const sectors = Array.isArray(row.sectors) ? row.sectors : []
      const locations = Array.isArray(row.locations) ? row.locations : []
      for (const sector of sectors) {
        for (const location of locations) {
          const key = `${sector}|||${location}`
          if (!pairs.has(key)) pairs.set(key, { sector, location, scans: 0, totalFound: 0, customers: new Set() })
          const p = pairs.get(key)
          p.scans += 1
          p.totalFound += row.found_count || 0
          if (row.user_id) p.customers.add(row.user_id)
        }
      }
    }

    // How many companies/sources Annie already knows for each sector
    // involved above — read once for every distinct sector in the report,
    // not per-pair, since the table itself doesn't carry a meaningful
    // location dimension (see the constant's comment above).
    const knownBySector = {}
    const sectorList = [...new Set([...pairs.values()].map(p => p.sector))]
    if (sectorList.length) {
      const { data: learnedRows, error: learnedError } = await supabase
        .from('annie_learned_sources')
        .select('sector, kind')
        .in('sector', sectorList)
        .limit(LEARNED_SOURCES_QUERY_LIMIT)
      if (learnedError) {
        console.error('[scanShared] annie_learned_sources read (for coverage report) failed:', learnedError.message)
      } else {
        for (const row of learnedRows || []) {
          if (!knownBySector[row.sector]) knownBySector[row.sector] = { companies: 0, sources: 0 }
          if (row.kind === 'source') knownBySector[row.sector].sources += 1
          else knownBySector[row.sector].companies += 1
        }
      }
    }

    return [...pairs.values()]
      .map(p => {
        const known = knownBySector[p.sector] || { companies: 0, sources: 0 }
        const knownTotal = known.companies + known.sources
        const thin = p.customers.size >= minCustomers && p.scans >= minScans && p.totalFound === 0
        return {
          sector: p.sector,
          location: p.location,
          scans: p.scans,
          distinctCustomers: p.customers.size,
          totalFound: p.totalFound,
          thin,
          knownCompanies: known.companies,
          knownSources: known.sources,
          // Only meaningful once a pair is actually thin — an actively
          // productive market has no "likely cause" to explain.
          likelyCause: !thin ? null : (knownTotal < MARKET_COVERAGE_UNINFORMED_THRESHOLD ? 'annie_under_informed' : 'genuinely_quiet'),
        }
      })
      .sort((a, b) => (b.thin - a.thin) || (b.scans - a.scans))
  } catch (err) {
    console.error('[scanShared] market_coverage_log read failed:', err.message)
    return []
  }
}

// "Annie always learning" extension #4 (2026-08-27), Michael: "along with
// the current prompt, annie starts to analyze the companies either they
// are adding, or that have come from their CSV, start monitoring those
// companies and their competitors... this adds to her prompt currently to
// learn and adapt, it doesn't replace it."
//
// This is deliberately separate from annie_learned_sources (the CRM-add
// triggers in 2026-08-27-learn-from-customer-crm.sql) — that mechanism is
// SHARED/global (an objective "this company exists in this sector" fact
// every account researching that sector benefits from). This one is
// PERSONAL: the exact companies THIS customer has personally added — as a
// client/prospect via CompanySelect.jsx, or in bulk via a CSV/LinkedIn
// import, or as a candidate's current employer — are the strongest
// possible signal of who they actually care about, stronger than a sector
// match alone. Every genuine BD signal type this whole file already looks
// for (funding, expansion, leadership change, live hiring, M&A) is worth
// checking specifically for these named companies AND their real
// competitors, not just waiting for them to surface from a generic
// sector-wide search.
//
// Read directly from companies/candidates (the CRM's own tables, both
// team-scoped — see companies.js's own header) rather than a new cache
// table: this always reflects the account's current CRM contents exactly,
// with nothing to keep in sync. Capped at WATCHLIST_COMPANY_LIMIT so an
// account with a large CRM doesn't balloon the scan prompt's token cost —
// most recently added companies first, since those are the freshest signal
// of current interest.
const WATCHLIST_COMPANY_LIMIT = 20

export async function getCustomerWatchlistCompanies(supabase, ob, limit = WATCHLIST_COMPANY_LIMIT) {
  if (!supabase || !ob?.user_id) return []
  try {
    // Team accounts share a CRM across teammates (companies/candidates are
    // team-scoped, see companies.js) — resolve this user's own team_id (if
    // any) so a company or candidate added by a teammate is picked up too,
    // not only rows this exact user_id added themselves.
    const { data: teamRow } = await supabase
      .from('team_members')
      .select('team_id')
      .eq('user_id', ob.user_id)
      .limit(1)
      .single()
    const teamId = teamRow?.team_id || null

    const queries = [
      supabase.from('companies').select('name').eq('user_id', ob.user_id).order('created_at', { ascending: false }).limit(limit),
      supabase.from('candidates').select('company').eq('user_id', ob.user_id).order('created_at', { ascending: false }).limit(limit),
    ]
    if (teamId) {
      queries.push(supabase.from('companies').select('name').eq('team_id', teamId).order('created_at', { ascending: false }).limit(limit))
      queries.push(supabase.from('candidates').select('company').eq('team_id', teamId).order('created_at', { ascending: false }).limit(limit))
    }
    const results = await Promise.all(queries)
    const names = new Set()
    for (const { data, error } of results) {
      if (error) {
        console.error('[scanShared] failed to read customer watchlist companies:', error.message)
        continue
      }
      for (const row of data || []) {
        const val = (row.name || row.company || '').trim()
        if (val) names.add(val)
      }
    }
    return [...names].slice(0, limit)
  } catch (err) {
    console.error('[scanShared] failed to read customer watchlist companies:', err.message)
    return []
  }
}

// Composes the prompt paragraph for the watchlist above, same
// only-if-there's-something-real-to-say discipline as buildRegionalSourceHint/
// buildTargetFirmHint. Deliberately ADDITIVE — sits alongside the existing
// sector/location/function-driven search the rest of buildScanPrompt
// already runs, never replacing it, per Michael's explicit "doesn't
// replace it" instruction. Asks the AI to find real, genuine competitors
// itself (using the same web-search tool already available for this call)
// rather than this needing a second AI call or a hand-maintained
// competitor map — the same "no duplicate logic" reasoning the rest of
// this file follows.
export function buildCustomerWatchlistHint(companies) {
  if (!companies?.length) return ''
  return `\nThis recruiter has personally added the following companies to their own CRM — as a client, a prospect, or as a candidate's current employer, either one at a time or via a bulk CSV/LinkedIn import: ${companies.join(', ')}. In addition to the sector/location/function-driven search above, specifically check each of these companies, AND any genuine, real direct competitors of theirs that you know to be active in the same space, for the same kind of BD signal (funding, expansion, leadership change, live hiring, M&A) — even one that might not otherwise have surfaced from a general search. Only name a competitor you're confident is real and genuinely comparable, never a guess.\n`
}

// Deliberately smaller than POOL_PERSONALIZE_MAX_TOKENS/the main scan's own
// budget above — this prompt asks for at most 5 entries total (up to 3
// live_job, 1 leadership_change, plus any incidental annie_learned finds —
// see LIVE_JOB_PRIORITY_LIMIT below) against a narrow, single-purpose
// brief, not the main scan's "up to 5-8, mixed types" sweep. maxUses
// (web-search round-trips) similarly scaled down: a handful of targeted
// lookups per type, not the wider budget a general sweep needs to cover
// funding/expansion/M&A/regulatory/live_job/leadership all in one call.
//
// 2026-09-03: MAX_TOKENS raised 2000 -> 3200 in the same edit that raised
// the live_job count below from 1 to LIVE_JOB_PRIORITY_LIMIT — each
// live_job entry carries several free-text fields (whyItMatters,
// introMessage, candidateAngle, benchStrengthAngle, candidateProfile), so
// asking for up to 3 of them instead of 1 needs real extra output room,
// not just a bigger count in the prompt text. maxUses left unchanged: the
// same round of searches that used to surface one candidate already turns
// up several, per Michael's own count against a live run (10 raw leads,
// one used) — the gap was in how many good ones got kept, not in how much
// searching happened.
export const PRIORITY_DISCOVERY_MAX_TOKENS = 3200
export const PRIORITY_DISCOVERY_MAX_USES = 6

// 2026-09-03, Michael: "surely there's a lot more roles ... did she stop
// as soon as she found these finance roles?" — she didn't stop searching
// (buildJobTitleQueries already queries every one of this recruiter's
// selected functions in one interleaved pass, not sequentially-until-one-
// hits), but this prompt's own "up to ONE live_job entry" instruction and
// pickLiveJobEntryFromLeads' own single-pick shape meant only one of
// whatever the search turned up ever made it through, regardless of how
// many other genuinely good, distinct ones existed in the same result set.
// Raised to 3 — still a cap, not "return everything": a real BD action
// list needs a handful of live, specific, well-checked leads to work,
// not a wall of raw postings.
export const LIVE_JOB_PRIORITY_LIMIT = 3

// 2026-09-02, Michael: real report — "why has Annie not found one live
// job" and, separately, "why is leadership so thin". Root cause for both,
// confirmed live: buildScanPrompt's one combined call treats funding,
// expansion, leadership_change and live_job as equal peers in a single
// "return up to 5, mixed" sweep, and (for live_job specifically) only ever
// runs at all when the cross-customer signal pool doesn't already cover
// the day's quota — see the "priority discovery" call in intelligence-
// scan-background.js/scan-now-background.js for the fix. Funding and
// expansion are, in Michael's own words, "the easiest to find" — genuinely
// abundant, well-covered by ordinary news search and the shared pool — so
// they don't need a dedicated pass. Live_job and leadership_change are the
// two he singled out as the actual priority: a live job needs no
// speculation (a specific person, at a specific company, hiring right
// now) and a leadership change is one of the highest-intent moments to
// reach out (someone new is about to evaluate their team) — but neither
// gets any proactive per-company check today, only whatever a company
// happens to already have on file from the general sweep's target-firm
// anchors (funding/expansion's own mechanism, not built for these two).
//
// This prompt is deliberately narrow: it asks for AT MOST
// LIVE_JOB_PRIORITY_LIMIT live_job entries and AT MOST ONE
// leadership_change entry per call, never padded to hit a count — called
// on both of this account's two daily scan fires (see MAX_SIGNALS_PER_RUN's
// own 12-hourly cadence). 2026-09-03, Michael, real report: "surely there's
// a lot more roles than that — did she stop as soon as she found these
// finance roles?" — a single run's raw leads regularly contain several
// genuinely good, distinct candidates (confirmed live: 10 raw TheirStack
// leads, only 1 ever kept), so capping this at one both understated what
// was actually found and meant the ONE pick that did survive was whichever
// happened to be first, not the best. Raised from 1 to
// LIVE_JOB_PRIORITY_LIMIT (still a cap, never "return everything") — see
// that constant's own header just above. leadership_change stays at one:
// Michael hasn't asked for more of those, and a genuine, well-sourced named
// appointment is inherently rarer per cycle than an open job posting. Runs
// unconditionally, every single call, regardless of whether the shared
// signal pool already covers the rest of that run's quota — see this
// pass's own caller for why these two are additional to, not competing
// against, the ordinary per-run cap the rest of buildScanPrompt's output
// is still subject to.
export function buildPriorityDiscoveryPrompt(onboarding, recentCompanies, opts = {}) {
  const functions = onboarding?.functions?.length ? onboarding.functions.join(', ') : null
  return `You are Annie, an expert BD researcher for a recruitment firm.
Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Functions this recruiter places candidates into: ${functions || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `The recruiter's real writing style, follow this closely when writing introMessage/candidateAngle/benchStrengthAngle:\n${onboarding.writing_style}\n` : ''}
This is a dedicated, focused pass for exactly the two things this recruiter has said matter most: a genuine, currently open, specific job, and a genuine, named leadership appointment. Do NOT report funding, expansion, M&A, regulatory news, or general commentary here — those are covered by a separate pass. Only ever return a live_job entry or a leadership_change entry, and only when it's real and well-sourced.

Bias hard against household-name, mega-employer companies (thousands of employees) — a company that size runs hiring almost entirely in-house and essentially never engages an external agency recruiter, so a live opening or a new appointment there isn't a real lead for this recruiter even though it's the easiest one to find. The real value is in genuine mid-market and emerging companies actively hiring or promoting right now, even if they're less famous.

${opts.adzunaLeads?.length ? `Adzuna's live jobs board shows these real, recent postings that may match: ${opts.adzunaLeads.map(l => `"${l.title}" at ${l.company}${l.location ? ` (${l.location})` : ''}${l.salary ? `, salary ~${l.salary}` : ''} — ${l.url}`).join(' | ')}. Any of these that reads as posted directly by the company itself (no agency name, no "on behalf of our client" language) is a candidate for one of your live_job entries below — several different ones from this list can each become their own entry, up to the limit below, they don't have to compete for a single slot.\n` : ''}${opts.theirStackLeads?.length ? `TheirStack (covers UAE/GCC, where Adzuna has no coverage) shows these real, recent postings: ${opts.theirStackLeads.map(l => `"${l.title}" at ${l.company}${l.location ? ` (${l.location})` : ''}${l.salary ? `, salary ~${l.salary}` : ''} — ${l.url}`).join(' | ')}. Same rule as the Adzuna leads above.\n` : ''}
For the live job: beyond the leads above, actively search this recruiter's own named regional job boards and LinkedIn Jobs posts, and check each target firm below's own careers page directly, for a real, specific, currently open vacancy in this recruiter's target functions — never a "company X is hiring" narrative with no actual posting to cite.
${buildLiveJobBoardHint(onboarding?.locations, onboarding?.sectors)}
For the leadership appointment: actively search this recruiter's own named regional press below and LinkedIn for someone who has genuinely, recently (within the last ${SIGNAL_LOOKBACK_DAYS} days) joined, been appointed, or been promoted into a senior role — ideally at one of the target firms below, or at a company already on this recruiter's radar (listed below), though a genuine appointment anywhere in this recruiter's sectors/markets counts. Naming the actual person is strongly preferred but not required if your source doesn't name them.
${buildRegionalSourceHint(onboarding?.locations, onboarding?.sectors, opts.learned)}
${buildTargetFirmHint(onboarding?.sectors, opts.learned, onboarding?.locations)}
${buildCustomerWatchlistHint(opts.watchlist)}
Companies already surfaced recently — still worth checking for a fresh live opening or a fresh appointment even though they've come up before: ${recentCompanies.join(', ') || 'None yet'}.

Return up to ${LIVE_JOB_PRIORITY_LIMIT} genuinely good live_job entries — each a different real, specific, currently open role, never near-duplicates of the same posting — AND up to ONE genuinely good leadership_change entry. Fewer than the limit, or zero for one or both, is a completely normal, honest outcome if that's genuinely all that clears the bar right now — never pad any of them out just to return something.

For each live job you found, use this exact shape:
- entryType: "live_job"
- company: the name of the actual hiring employer named in the posting's own text, never the name of the LinkedIn Page, Group, meetup, or community account that posted or shared it, if those differ from the real employer
- headline: the exact, specific role title (e.g. "Senior Finance Manager", not "Hiring across Finance")
- whyItMatters: 1 sentence, plain natural prose, on why this specific open role is a genuine BD opportunity right now. No citation markup or bracketed references.
- sourceUrl: the real posting URL — never a news article that merely mentions the company is hiring
- sourceLabel: short label, e.g. adzuna.com, bayt.com, or the company's own domain
- eventDate: the posting date if you can tell, else your best estimate, as YYYY-MM-DD
- whoToApproach: the specific person or role to approach about this exact opening
- titleKeywords: 2-4 likely job title strings for the right decision-maker, used afterwards to look up a real verified contact. These titles must describe the same person or level of seniority as whoToApproach above, and must be senior to (or the genuine hiring authority over) the role being filled: for a C-suite or VP-level opening, this is the CEO, Managing Director, Board, or an equivalent senior leader, never a peer or subordinate title in the same function (a Deputy CFO or Chief Accountant cannot hire a CFO, for example).
- introMessage: ${opts.introMessageField || 'the ready-to-send outreach message body, in this recruiter\'s tone, tailored to this exact role'}
- candidateAngle: a specific, credible candidate pitch to lead with. Leave blank if it doesn't call for one.
- benchStrengthAngle: a positioning pitch naming 1-2 real, specific peer companies, never vague. Leave blank if you cannot confidently name genuine peers.
- candidateProfile: an object with exactly these keys: { "yearsMin": <number>, "yearsMax": <number>, "functionalExperience": "<specific phrase>", "directCompetitors": [<0-3 real company names>], "similarIndustry": [<0-3 real company names>], "widerScope": [<0-2 real company names>] }. Leave arrays empty and functionalExperience blank rather than inventing anything.

For the leadership appointment, if you found one, use this exact shape:
- entryType: "signal"
- signalType: "leadership_change"
- company: the company name
- headline: max 10 words
- whyItMatters: 1-2 sentences, plain prose, on what this appointment likely means for this recruiter's business right now (a new leader typically reassesses their team). No citation markup or bracketed references.
- sourceUrl: the real URL you found this from
- sourceLabel: short label, e.g. techcrunch.com
- eventDate: your best estimate of when this happened, as YYYY-MM-DD
- whoToApproach: the specific person or role to approach
- appointedName: the full name of the person actually appointed/promoted, exactly as reported by your source. Leave blank only if no source actually names them.
- titleKeywords: 2-4 likely job title strings for the right decision-maker
- introMessage: ${opts.introMessageField || 'the ready-to-send outreach message body, in this recruiter\'s tone, congratulating them on the new role'}
- candidateAngle: leave blank unless there's an obvious opening this appointment creates.
- benchStrengthAngle: a positioning pitch naming 1-2 real, specific peer companies, never vague. Leave blank if you cannot confidently name genuine peers.
- candidateProfile: same structure and rules as the live_job field above.

For each genuinely new company or source you noticed while checking the named sources above that isn't already listed there, you may also return a third kind of entry:
- entryType: "annie_learned"
- kind: "company" or "source"
- sector: the exact sector label this belongs to, from this recruiter's own list above
- value: the company name, or the source's name/domain
- foundVia: the specific named source you found it on, never blank
- location: which market this belongs to — one of exactly [${onboarding?.locations?.join(', ') || 'this recruiter\'s selected markets'}], or "Global" only for a genuinely global resource with no single home market
Only include this when you actually found something real this way — never invent one to pad the response.

Return a single JSON array mixing entryTypes as they apply (0-${LIVE_JOB_PRIORITY_LIMIT + 1} entries: up to ${LIVE_JOB_PRIORITY_LIMIT} live_job, at most one leadership_change signal, plus any annie_learned entries). Only return the JSON array, nothing else. If nothing genuinely good was found for either, return an empty array.`
}

// Resolves LinkedIn company names to real industry + HQ location via Apollo, so
// import filters (sector, market) can rely on real data instead of guessing from
// company name text. Results are cached in Supabase, shared across every customer,
// so the same company is never enriched twice, only cache misses spend a credit.
import { createClient } from '@supabase/supabase-js'
import { reserveApolloCredits, releaseApolloCredits, fetchWithTimeout, createTimeoutFetch, pickBestOrgMatch } from './lib/scanShared.js'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { jsonError } from './lib/httpError.js'
import { getEntitlements, resolveResourceCaps } from './lib/entitlements.js'

function normalize(name) {
  return (name || '').trim().toLowerCase()
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed')
  }

  const apiKey = process.env.APOLLO_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!apiKey || !supabaseUrl || !anonKey || !serviceKey) {
    // Not configured yet, degrade gracefully, the import flow falls back to the
    // company-name keyword heuristic rather than breaking.
    return new Response(JSON.stringify({ results: [], configured: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Same pattern as chat.js and scan-now-background.js: this endpoint spends
  // real Apollo credit per call, so it must only ever run for a genuine,
  // signed-in customer, verified from their own session token, never trust
  // a caller with no token at all. Previously this had no auth check
  // whatsoever, an unauthenticated request from anywhere on the internet
  // could run up Apollo spend indefinitely.
  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) {
    return new Response(JSON.stringify({ results: [], error: authError === 'missing_token' ? 'Missing session token' : 'Invalid session' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 2026-08-24 Task 3: createTimeoutFetch applied — see its own header in
  // scanShared.js.
  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  // 2026-08-26: this endpoint's Apollo spend now counts against the calling
  // customer's own per-tier cap, not just one platform-wide shared total —
  // same fix as the scan pipeline's reserveApolloCredits call sites, see
  // resolveResourceCaps's own header in entitlements.js.
  const { tier } = await getEntitlements(supabase, user.id)
  const apolloCaps = resolveResourceCaps(tier).apollo

  try {
    const { companies } = await req.json()
    const names = Array.isArray(companies) ? [...new Set(companies.map(c => (c || '').trim()).filter(Boolean))] : []
    if (!names.length) {
      return new Response(JSON.stringify({ results: [], configured: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // Matches LinkedInImport.jsx's own cap on a single CSV import
    // (toImport.slice(0, 1000)) — this endpoint should never legitimately
    // see more unique companies than that in one request. The cap isn't
    // about being user-hostile, it's so a request from somewhere OTHER than
    // that one bounded flow can't single-handedly build an unbounded
    // IN(...) query against company_enrichment or monopolize the whole
    // day's Apollo credit cap by itself (reserveApolloCredits stops the
    // Apollo spend, but not the DB query size or function runtime before
    // that point).
    const MAX_COMPANIES_PER_REQUEST = 1000
    if (names.length > MAX_COMPANIES_PER_REQUEST) {
      return new Response(JSON.stringify({ error: `Too many companies in one request (max ${MAX_COMPANIES_PER_REQUEST}, got ${names.length}) — split into smaller batches.` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 1. Check the shared cache first, this is what keeps Apollo cost sustainable
    // as more customers import contacts over time.
    const keys = names.map(normalize)
    const { data: cached } = await supabase
      .from('company_enrichment')
      .select('company_name_key, company_name, industry, city, state, country, domain, logo_url, matched')
      .in('company_name_key', keys)

    const cacheMap = new Map((cached || []).map(row => [row.company_name_key, row]))
    const missing = names.filter(n => !cacheMap.has(normalize(n)))

    // 2. Only hit Apollo for companies nobody has enriched before, a handful at a time.
    const freshResults = []
    const CONCURRENCY = 5
    for (let i = 0; i < missing.length; i += CONCURRENCY) {
      const batch = missing.slice(i, i + CONCURRENCY)
      const batchResults = await Promise.all(batch.map(async (name) => {
        // Same global daily credit cap the scan pipeline reserves against
        // (see supabase-migrations/2026-08-21-apollo-credit-cap.sql) — this
        // is a different call site spending the same shared Apollo budget,
        // it has to respect the same ceiling.
        // skipCache marks this specific result as "not actually checked",
        // not "checked and no match" — step 3 below must never write this
        // into the permanent cache, or a company skipped once for a cap hit
        // would incorrectly read as permanently unmatched forever after.
        if (!(await reserveApolloCredits(supabase, user.id, 1, apolloCaps))) {
          return { company_name: name, company_name_key: normalize(name), matched: false, skipCache: true }
        }
        try {
          // 4th-pass audit fix: this was previously a bare fetch() — the one
          // Apollo call site in the codebase with no AbortController-backed
          // timeout at all, unlike every other Apollo call in scanShared.js.
          // 5th-pass audit fix: the 4th-pass fix first reached for
          // fetchWithRetry — the same helper every OTHER Apollo call site
          // uses — but this call site isn't like those others: it runs up
          // to MAX_COMPANIES_PER_REQUEST (1000) times, 5-at-a-time,
          // sequentially, inside ONE synchronous request/response function
          // with no background-function time budget to spend. fetchWithRetry
          // retries a 429/5xx twice with real backoff before giving up,
          // stretching a single failing company from "fails near-instantly"
          // (the bare-fetch behaviour before ANY of this) to up to ~38s
          // (three attempts at the default 12s timeout, plus backoff) — so a
          // real Apollo outage, exactly the scenario the credit-release fix
          // above exists to handle gracefully, now risks this function
          // running for potentially hours across a large batch and getting
          // hard-killed by Netlify's own execution ceiling mid-loop, which
          // leaks the credit reserved for whatever company was in flight at
          // that instant (nothing ever reaches the catch/release below it —
          // reproducing the exact bug this whole fix set out to close, just
          // via a different mechanism). fetchWithTimeout alone — no
          // retries, and a short 8s ceiling rather than the background-
          // function-oriented 12s default — keeps the original fix's actual
          // goal (bound a hang, don't let it sit forever) without
          // reintroducing a multi-outage-scale slowdown a synchronous,
          // batch-processing endpoint can't afford.
          // 2026-08-26 audit fix: per_page was 1 and the org variable below
          // took that single result unconditionally — the one Apollo call
          // site in the codebase with no name-match guard, unlike
          // enrichCompany() in scanShared.js (which exists specifically
          // because a short/generic company name's top Apollo search hit
          // isn't reliably the right company — the "Stitch vs Stitch Fix"
          // case documented on pickBestOrgMatch). This screen renders its
          // result as "Verified via real company data", the same visual
          // weight as a confirmed match, so a wrong guess here was
          // presented to the user exactly as confidently as a right one.
          // per_page: 5 (matching scanShared's own fix) so pickBestOrgMatch
          // has real candidates to choose between instead of only Apollo's
          // single top-ranked guess.
          const resp = await fetchWithTimeout('https://api.apollo.io/v1/mixed_companies/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apiKey },
            body: JSON.stringify({ q_organization_name: name, page: 1, per_page: 5 }),
          }, 8000)
          if (!resp.ok) {
            // 4th-pass audit fix: release the credit reserved above — the
            // call failed outright, nothing was returned for it.
            // 2026-08-27 audit fix: skipCache: true too — an Apollo outage
            // or an expired key mid-batch must not get cached as a genuine
            // "checked, no match" the way a real miss does (see the cache
            // note at step 3 below). Without this, one bad Apollo response
            // during a large import permanently marks every company hit
            // during the outage unmatched for every customer, forever,
            // since company_enrichment is a shared cross-customer cache
            // with no re-check path.
            await releaseApolloCredits(supabase, user.id, 1)
            return { company_name: name, company_name_key: normalize(name), matched: false, skipCache: true }
          }
          const data = await resp.json()
          const candidates = [...(data.organizations || []), ...(data.accounts || [])]
          const org = pickBestOrgMatch(candidates, name)
          if (!org) return { company_name: name, company_name_key: normalize(name), matched: false }
          return {
            company_name: name,
            company_name_key: normalize(name),
            domain: org.primary_domain || org.domain || null,
            industry: org.industry || null,
            city: org.city || null,
            state: org.state || null,
            country: org.country || null,
            logo_url: org.logo_url || null,
            matched: true,
          }
        } catch {
          // 4th-pass audit fix: same as the non-ok branch above — a thrown
          // error means the reserved credit was never actually spent on a
          // usable result. 2026-08-27 audit fix: skipCache: true, same
          // reasoning as the non-ok branch above.
          await releaseApolloCredits(supabase, user.id, 1)
          return { company_name: name, company_name_key: normalize(name), matched: false, skipCache: true }
        }
      }))
      freshResults.push(...batchResults)
    }

    // 3. Cache every result that was actually looked up, matched or not, so
    // an unmatched company also never costs a repeat credit. Cap-skipped
    // results are excluded — they were never actually checked against
    // Apollo, so caching them would wrongly mark a company unmatched
    // forever just because it happened to be requested on a day the cap
    // was already hit.
    const cacheable = freshResults.filter(r => !r.skipCache)
    if (cacheable.length) {
      // 2026-08-24 Task 5: result wasn't captured at all — a thrown
      // exception here would reach the outer catch, but a query-level
      // `{ error }` (RLS denial, constraint violation) resolved silently.
      // Same cache-write bug class fixed in scanShared.js in this same
      // pass; logged rather than thrown since a cache-write failure
      // shouldn't turn an otherwise-successful enrichment response into an
      // error for the caller.
      const { error: cacheError } = await supabase.from('company_enrichment').upsert(
        cacheable.map(({ skipCache, ...r }) => ({ ...r, enriched_at: new Date().toISOString() })),
        { onConflict: 'company_name_key' }
      )
      if (cacheError) console.error('[apollo-enrich-companies] cache write failed:', cacheError.message)
    }

    const results = names.map(n => {
      const key = normalize(n)
      return cacheMap.get(key) || freshResults.find(r => r.company_name_key === key) || { company_name: n, company_name_key: key, matched: false }
    })

    return new Response(JSON.stringify({ results, configured: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    await reportServerError('apollo-enrich-companies', err)
    return new Response(JSON.stringify({ results: [], error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export const config = { path: '/api/apollo-enrich-companies' }

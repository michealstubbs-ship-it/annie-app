// Resolves LinkedIn company names to real industry + HQ location via Apollo, so
// import filters (sector, market) can rely on real data instead of guessing from
// company name text. Results are cached in Supabase, shared across every customer,
// so the same company is never enriched twice, only cache misses spend a credit.
import { createClient } from '@supabase/supabase-js'
import { reserveApolloCredits } from './lib/scanShared.js'

function normalize(name) {
  return (name || '').trim().toLowerCase()
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
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
  const authHeader = req.headers.get('authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    return new Response(JSON.stringify({ results: [], error: 'Missing session token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await authClient.auth.getUser(token)
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ results: [], error: 'Invalid session' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  try {
    const { companies } = await req.json()
    const names = Array.isArray(companies) ? [...new Set(companies.map(c => (c || '').trim()).filter(Boolean))] : []
    if (!names.length) {
      return new Response(JSON.stringify({ results: [], configured: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
        if (!(await reserveApolloCredits(supabase))) {
          return { company_name: name, company_name_key: normalize(name), matched: false, skipCache: true }
        }
        try {
          const resp = await fetch('https://api.apollo.io/v1/mixed_companies/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apiKey },
            body: JSON.stringify({ q_organization_name: name, page: 1, per_page: 1 }),
          })
          if (!resp.ok) return { company_name: name, company_name_key: normalize(name), matched: false }
          const data = await resp.json()
          const org = (data.organizations && data.organizations[0]) || (data.accounts && data.accounts[0])
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
          return { company_name: name, company_name_key: normalize(name), matched: false }
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
      await supabase.from('company_enrichment').upsert(
        cacheable.map(({ skipCache, ...r }) => ({ ...r, enriched_at: new Date().toISOString() })),
        { onConflict: 'company_name_key' }
      )
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
    return new Response(JSON.stringify({ results: [], error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export const config = { path: '/api/apollo-enrich-companies' }

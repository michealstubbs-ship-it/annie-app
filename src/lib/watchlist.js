import { supabase } from './supabase'

// "Annie always learning" extension #4 (2026-08-27), Michael: "along with
// the current prompt, annie starts to analyze the companies either they are
// adding, or that have come from their CSV, start monitoring those
// companies and their competitors" — followed by "see where it makes sense
// to apply the same logic on the app as well".
//
// This is the client-side twin of getCustomerWatchlistCompanies in
// netlify/functions/lib/scanShared.js (used server-side to feed the scan
// prompts) — same idea (this recruiter's own CRM-added companies and
// candidates' current employers are the strongest personal signal of who
// they actually care about), reused wherever else in the app Annie talks to
// this customer and could benefit from knowing it, starting with Ask Annie
// (Chat.jsx). Deliberately simpler than the server version: companies/
// candidates are already team-scoped via RLS (see companies.js/
// candidates.js's own headers), so there's no separate team_id resolution
// needed here the way the service-role server version requires — the
// caller's own session already only ever sees their team's rows.
//
// Capped the same way as the server version, for the same reason: this
// feeds straight into an AI prompt, so an account with a large CRM
// shouldn't balloon token cost — most recently added companies first, since
// those are the freshest signal of current interest.
const WATCHLIST_COMPANY_LIMIT = 15

export async function getWatchlistCompanyNames(limit = WATCHLIST_COMPANY_LIMIT) {
  try {
    const [{ data: companies, error: companiesError }, { data: candidates, error: candidatesError }] = await Promise.all([
      supabase.from('companies').select('name').order('created_at', { ascending: false }).limit(limit),
      supabase.from('candidates').select('company').order('created_at', { ascending: false }).limit(limit),
    ])
    if (companiesError) console.error('[watchlist] failed to read companies:', companiesError.message)
    if (candidatesError) console.error('[watchlist] failed to read candidates:', candidatesError.message)
    const names = new Set()
    for (const row of companies || []) { if (row.name) names.add(row.name.trim()) }
    for (const row of candidates || []) { if (row.company) names.add(row.company.trim()) }
    return [...names].slice(0, limit)
  } catch (err) {
    console.error('[watchlist] failed to read watchlist companies:', err.message)
    return []
  }
}

// Same composition idea as buildCustomerWatchlistHint in scanShared.js —
// kept intentionally shorter here since Ask Annie's system prompt is a
// single short block, not the long, structured research prompt the scan
// pipeline builds. Additive only: this is one more paragraph alongside the
// sectors/functions/markets Chat.jsx already tells Annie about, never a
// replacement for it.
export function buildWatchlistChatHint(companies) {
  if (!companies?.length) return ''
  return `\nThis recruiter tracks these companies in their own CRM — added directly, via a CSV/LinkedIn import, or as a candidate's current employer: ${companies.join(', ')}. Keep these in mind when relevant to what's being asked, and feel free to reference their known, genuine direct competitors too when that strengthens an answer.\n`
}

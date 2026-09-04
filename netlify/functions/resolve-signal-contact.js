// 2026-08-26: closes a real flaw Michael flagged — "Add to Today's BD
// Actions" on the Intelligence Feed already bypasses the signal-type
// whitelist (see eligibility.js), but never bypassed the mandatory-contact
// requirement, and there was nothing that tried harder for a contact when
// the customer explicitly asked Annie to act on a signal. A signal without
// a verified contact or a contact-candidates panel silently can't appear in
// Today's BD Actions (see isEligibleSourced/isEligibleRelationship), so a
// manual add on one of those looked to the customer exactly like a broken
// button — the click did something (flagged manually_added_at), navigated
// to Today's Actions, and then the item just wasn't there, no explanation.
//
// This endpoint is what the Feed now calls before completing that add, when
// the signal doesn't already have a contact: it re-runs the same real,
// three-layer Apollo lookup buildEnrichedSignalRow uses at scan time (see
// resolveContactForSignal in scanShared.js), but forces the widest,
// tier-gated fallback pass on for every customer regardless of plan — a
// single deliberate click justifies the extra Apollo credit the way routine
// per-signal scanning at Starter tier doesn't. If a contact is found, the
// signal row is updated in place so it's immediately eligible; if genuinely
// nobody is findable across all three layers, this returns found:false
// (not an error) so the frontend can say so honestly rather than pretending
// the click failed.
//
// Never asks the AI to invent a contact — every layer here is a real Apollo
// lookup against real data, exactly like the original scan-time attempt.
import { createClient } from '@supabase/supabase-js'
import { enrichCompany, resolveContactForSignal, createTimeoutFetch } from './lib/scanShared.js'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { jsonError } from './lib/httpError.js'
import { getEntitlements, resolveResourceCaps } from './lib/entitlements.js'

export default async (req, context) => {
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed')
  }

  const apiKey = process.env.APOLLO_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!apiKey || !supabaseUrl || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ found: false, configured: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Same pattern as apollo-enrich-companies.js: this spends real Apollo
  // credit, so it must only ever run for a genuine, signed-in customer.
  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) {
    return new Response(JSON.stringify({ found: false, error: authError === 'missing_token' ? 'Missing session token' : 'Invalid session' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  try {
    const { signalId } = await req.json()
    if (!signalId) {
      return new Response(JSON.stringify({ found: false, error: 'signalId is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    // Scoped to this user's own row on purpose — intelligence_signals is
    // personal, not team-shared (see lib/data/signals.js's own header), so
    // this can't be used to spend one customer's Apollo credit resolving a
    // contact for a signal that belongs to someone else's account.
    const { data: signal, error: fetchError } = await supabase
      .from('intelligence_signals')
      .select('id, user_id, company_name, signal_type, title_keywords, headline, contact_verified, contact_candidates')
      .eq('id', signalId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (fetchError || !signal) {
      return new Response(JSON.stringify({ found: false, error: 'Signal not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    // Already resolved (a second click, a race with the scan finding one in
    // the meantime) — nothing to do, this is a normal outcome, not an error.
    if (signal.contact_verified || (Array.isArray(signal.contact_candidates) && signal.contact_candidates.length)) {
      return new Response(JSON.stringify({ found: true, alreadyResolved: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const { tier } = await getEntitlements(supabase, user.id)
    const apolloCaps = resolveResourceCaps(tier).apollo

    // enrichCompany is cache-backed (company_enrichment, shared across every
    // customer) — this company was almost certainly already resolved once
    // at scan time, so this is typically a free cache hit, not a fresh
    // Apollo spend, purely to get back the organization_id verifyContact
    // needs. appointedName isn't persisted on the signal row (only used
    // transiently at scan time), so a leadership_change retry here falls
    // back to title-keyword search instead of exact-name search — a real,
    // minor difference from the original attempt, but title_keywords for a
    // leadership signal is usually the new title itself, which still gives
    // Apollo something concrete to match on.
    const companyInfo = await enrichCompany(apiKey, signal.company_name, supabase, [], user.id, apolloCaps)

    const { contact, contactCandidates } = await resolveContactForSignal({
      apolloKey: apiKey,
      company: signal.company_name,
      signalType: signal.signal_type,
      titleKeywords: signal.title_keywords,
      appointedName: null,
      // 2026-09-06: same implausible-hiring-contact guard the scan-time
      // resolver now applies (see resolveContactForSignal's own header in
      // scanShared.js). Without this, a manual retry on a signal that
      // originally matched a subordinate-flavored contact could just
      // re-resolve that exact same wrong person again.
      roleTitle: signal.headline,
      supabase,
      apolloOrgId: companyInfo?.apolloOrgId,
      userId: user.id,
      apolloContactRetry: true, // forced on for this one-off manual retry, regardless of tier — see this file's own header
      apolloCaps,
    })

    if (!contact && !contactCandidates.length) {
      return new Response(JSON.stringify({ found: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const { error: updateError } = await supabase
      .from('intelligence_signals')
      .update({
        contact_name: contact?.name || null,
        contact_title: contact?.title || null,
        contact_linkedin_url: contact?.linkedin_url || null,
        contact_email: contact?.email || null,
        contact_verified: !!contact,
        contact_candidates: contactCandidates.length ? contactCandidates : null,
      })
      .eq('id', signalId)
      .eq('user_id', user.id)

    if (updateError) {
      console.error('[resolve-signal-contact] failed to write resolved contact:', updateError.message)
      return new Response(JSON.stringify({ found: false, error: 'Found a contact but failed to save it — try again' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      found: true,
      contact: contact ? { name: contact.name, title: contact.title, linkedin_url: contact.linkedin_url, email: contact.email } : null,
      contactCandidates: contactCandidates.length ? contactCandidates : null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('resolve-signal-contact', err)
    return new Response(JSON.stringify({ found: false, error: err.message }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/resolve-signal-contact' }

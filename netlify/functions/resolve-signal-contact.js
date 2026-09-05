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
import { getEntitlements, resolveResourceCaps, getContactCredits, consumeContactCredit } from './lib/entitlements.js'

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
      .select('id, user_id, company_name, signal_type, title_keywords, headline, contact_verified, contact_candidates, contact_name, contact_title, contact_linkedin_url, contact_email')
      .eq('id', signalId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (fetchError || !signal) {
      return new Response(JSON.stringify({ found: false, error: 'Signal not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }

    // Already resolved (a second click, a race with the scan finding one in
    // the meantime) — nothing to do, this is a normal outcome, not an error.
    const { tier, teamId } = await getEntitlements(supabase, user.id)

    if (signal.contact_verified || (Array.isArray(signal.contact_candidates) && signal.contact_candidates.length)) {
      // A cache hit costs nothing and must therefore charge nothing.
      const credits = await getContactCredits(supabase, teamId, tier)
      return new Response(JSON.stringify({
        found: true,
        alreadyResolved: true,
        contact: signal.contact_name
          ? { name: signal.contact_name, title: signal.contact_title, linkedin_url: signal.contact_linkedin_url, email: signal.contact_email }
          : null,
        contactCandidates: signal.contact_candidates || null,
        credits,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    // 2026-09-04: the monthly contact allowance. Checked BEFORE anything is
    // spent at Apollo, so a customer at their ceiling is told plainly rather
    // than having the request quietly fail after the money is gone.
    const credits = await getContactCredits(supabase, teamId, tier)
    if (credits.remaining <= 0) {
      return new Response(JSON.stringify({
        found: false,
        capReached: true,
        credits,
        // Says what actually ran out, and never implies a top-up balance they
        // do hold has also gone — remaining already includes it.
        error: `You've used all ${credits.limit} contact lookups on your plan this month.`,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

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
      // Apollo genuinely had nobody. Verified 2026-09-04 against the live API:
      // a search costs nothing and an enrichment that matches nobody costs
      // nothing, so this outcome is free to Annie and must be free to the
      // customer. No credit is consumed. The frontend says so out loud and
      // offers the LinkedIn route instead of pretending the click failed.
      return new Response(JSON.stringify({ found: false, charged: false, credits }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const { error: updateError } = await supabase
      .from('intelligence_signals')
      .update({
        contact_name: contact?.name || null,
        contact_title: contact?.title || null,
        contact_linkedin_url: contact?.linkedin_url || null,
        contact_email: contact?.email || null,
        // See verifyContact in scanShared.js: a partial identity (first name
        // plus a LinkedIn profile, no confirmed surname) is a genuine Apollo
        // match and a usable route in, but never a verified person.
        contact_verified: !!contact && !contact.partialIdentity,
        contact_candidates: contactCandidates.length ? contactCandidates : null,
      })
      .eq('id', signalId)
      .eq('user_id', user.id)

    if (updateError) {
      console.error('[resolve-signal-contact] failed to write resolved contact:', updateError.message)
      return new Response(JSON.stringify({ found: false, error: 'Found a contact but failed to save it — try again' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    // Only now, with a real person in hand, does this cost the customer
    // anything. consumeContactCredit returns the new running total so the
    // meter in the UI updates from the same number the server just wrote.
    //
    // A person WITHOUT an email still costs a credit, because Apollo still
    // charges for it — measured 2026-09-05: 10 people submitted, 10 person
    // matches, 5 emails, 10 credits. That is not hidden from the customer:
    // hasEmail below is what lets the feed say "found them, no email — message
    // on LinkedIn instead" rather than showing a spent credit and an empty
    // field, which is what makes it read as a broken feature rather than a
    // known limit of the data.
    const consumed = await consumeContactCredit(supabase, teamId, tier)
    const updatedCredits = consumed === null
      ? credits
      : { used: consumed.used, limit: consumed.limit, topupBalance: consumed.topupBalance, remaining: consumed.remaining }

    return new Response(JSON.stringify({
      found: true,
      charged: true,
      hasEmail: !!contact?.email,
      credits: updatedCredits,
      contact: contact ? { name: contact.name, title: contact.title, linkedin_url: contact.linkedin_url, email: contact.email, partialIdentity: !!contact.partialIdentity } : null,
      contactCandidates: contactCandidates.length ? contactCandidates : null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('resolve-signal-contact', err)
    return new Response(JSON.stringify({ found: false, error: err.message }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/resolve-signal-contact' }

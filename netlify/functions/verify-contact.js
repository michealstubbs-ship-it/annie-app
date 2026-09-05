// Verify one named person's address at Apollo, on request, for one credit.
//
// Michael, 2026-09-05: "surely they should still have the ability to try and
// get the email of the contact? if Apollo doesnt have it, then annie can guess
// it from public records and say that it is a guess."
//
// The card now shows a constructed address by default — free, always labelled
// a guess, built from the organisation's format and its domain. This is the
// other half: the one-click way to replace the guess with a fact.
//
// Why a new endpoint rather than resolve-signal-contact: that one starts from
// a signal row and asks Apollo "who at this company does this kind of job".
// Here the customer already knows exactly who they mean — the person is in
// their own CRM — so it goes straight to a name lookup, which is both cheaper
// and far more likely to be the right human.
//
// Costs, measured on the live account 2026-09-05: a person match costs one
// credit whether or not an address comes back (10 submitted, 10 matched, 5
// emails, 10 credits). No match at all costs nothing. Both outcomes are said
// out loud rather than leaving a spent credit and an empty field.
import { createClient } from '@supabase/supabase-js'
import { enrichCompany, verifyContact, createTimeoutFetch } from './lib/scanShared.js'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { jsonError } from './lib/httpError.js'
import { getEntitlements, resolveResourceCaps, getContactCredits, consumeContactCredit } from './lib/entitlements.js'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export default async (req) => {
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed')

  const apiKey = process.env.APOLLO_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!apiKey || !supabaseUrl || !anonKey || !serviceKey) {
    return json({ found: false, configured: false })
  }

  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) {
    return json({ found: false, error: authError === 'missing_token' ? 'Missing session token' : 'Invalid session' }, 401)
  }

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  try {
    const { contactId } = await req.json()
    if (!contactId) return json({ found: false, error: 'contactId is required' }, 400)

    const { tier, teamId } = await getEntitlements(supabase, user.id)

    const { data: contact, error: fetchError } = await supabase
      .from('contacts')
      .select('id, user_id, team_id, name, company, title, email, linkedin_url, relationship_tier')
      .eq('id', contactId)
      .maybeSingle()

    // This runs with the service key, which bypasses RLS — so ownership is
    // checked here explicitly. Without this, any signed-in customer could
    // spend their own credit enriching a stranger's contact row and read the
    // answer back.
    const owned = contact && (contact.user_id === user.id || (teamId && contact.team_id === teamId))
    if (fetchError || !owned) return json({ found: false, error: 'Contact not found' }, 404)

    if (contact.email) {
      // Already known. Costs nothing, charges nothing.
      const credits = await getContactCredits(supabase, teamId, tier)
      return json({ found: true, charged: false, alreadyKnown: true, hasEmail: true, email: contact.email, credits })
    }
    if (!contact.name || !contact.company) {
      return json({ found: false, charged: false, error: 'Annie needs both a name and a company to look someone up.' })
    }

    const credits = await getContactCredits(supabase, teamId, tier)
    if (credits.remaining <= 0) {
      return json({
        found: false,
        capReached: true,
        credits,
        error: `You've used all ${credits.limit} contact lookups on your plan this month.`,
      })
    }

    const apolloCaps = resolveResourceCaps(tier).apollo
    const companyInfo = await enrichCompany(apiKey, contact.company, supabase, [], user.id, apolloCaps)

    // appointedName is what turns this into a name lookup rather than a
    // "find me someone with this job title" search. It also gets its own
    // bucket in the shared company_contacts cache, so the second customer to
    // ask about the same person pays nothing.
    const found = await verifyContact(
      apiKey,
      contact.company,
      null,
      supabase,
      companyInfo?.apolloOrgId,
      contact.name,
      user.id,
      apolloCaps,
    )

    if (!found) {
      // Apollo had nobody. Free at Apollo, so free here. The card keeps its
      // guess and says the check came back empty.
      return json({ found: false, charged: false, credits })
    }

    // Only write an address back onto the customer's own record. Nothing else
    // about their contact is overwritten by Apollo's version of the person —
    // their CRM is theirs.
    let saved = false
    if (found.email) {
      const { error: updateError } = await supabase
        .from('contacts')
        .update({
          email: found.email,
          // A real channel now exists, which is exactly what this tier means.
          relationship_tier: contact.relationship_tier === 'client' ? 'client' : 'contact',
          updated_at: new Date().toISOString(),
        })
        .eq('id', contact.id)
      saved = !updateError
      if (updateError) console.error('[verify-contact] failed to save address:', updateError.message)
    }

    const consumed = await consumeContactCredit(supabase, teamId, tier)
    const updatedCredits = consumed === null
      ? credits
      : { used: consumed.used, limit: consumed.limit, topupBalance: consumed.topupBalance, remaining: consumed.remaining }

    return json({
      found: true,
      charged: true,
      // The honest half of the measurement: roughly half of matched people
      // come back with no address, and it still costs a credit. The card says
      // "found them, no address" rather than showing a spent credit and an
      // empty field.
      hasEmail: !!found.email,
      email: found.email || null,
      saved,
      // A verified badge means Apollo confirmed a real person. A partial
      // identity is a real match and a real route in, but never that.
      verified: !found.partialIdentity,
      contact: { name: found.name, title: found.title, linkedin_url: found.linkedin_url, email: found.email || null },
      credits: updatedCredits,
    })
  } catch (err) {
    await reportServerError('verify-contact', err)
    return json({ found: false, error: err.message })
  }
}

export const config = { path: '/api/verify-contact' }

// Lets a Team-tier owner add a seatmate. Two paths, decided by whether the
// email already belongs to an Annie account:
//   - existing account -> added as an active team_members row immediately
//   - no account yet -> a pending team_members row is created, then
//     Supabase's own admin.inviteUserByEmail sends the real signup invite.
//     handle_new_user() (see the 2026-08-24 migration) activates that row
//     automatically the moment that email completes signup — no separate
//     "accept invite" endpoint needed.
//
// Owner-only, seat-capped, same auth pattern as every other function here:
// identify the caller from their OWN Supabase session token, never trust a
// team id or role the client claims.
import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { createTimeoutFetch } from './lib/scanShared.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const appUrl = process.env.APP_URL || 'https://app.meetannie.ai'
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
  }

  const { user, error: authError } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (authError) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  let body
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const email = String(body.email || '').trim().toLowerCase()
  if (!EMAIL_RE.test(email)) {
    return new Response(JSON.stringify({ error: 'Enter a valid email address' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  try {
    const { data: membership } = await supabase
      .from('team_members')
      .select('team_id, role')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle()

    if (!membership) {
      return new Response(JSON.stringify({ error: 'No active team found for your account' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }
    if (membership.role !== 'owner') {
      return new Response(JSON.stringify({ error: 'Only the team owner can invite members' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
    }
    const teamId = membership.team_id

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('tier, status, seats')
      .eq('team_id', teamId)
      .maybeSingle()

    if (!sub || sub.tier !== 'team' || !['active', 'trialing'].includes(sub.status)) {
      return new Response(JSON.stringify({ error: 'Upgrade to the Team plan to add teammates' }), { status: 402, headers: { 'Content-Type': 'application/json' } })
    }

    const { count: seatsUsed } = await supabase
      .from('team_members')
      .select('id', { count: 'exact', head: true })
      .eq('team_id', teamId)
      .in('status', ['active', 'invited'])

    const seatLimit = sub.seats || 3
    if ((seatsUsed || 0) >= seatLimit) {
      return new Response(
        JSON.stringify({ error: `Your plan includes ${seatLimit} seats, all in use or invited. Add seats in Billing to invite more.` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    // Already on this team, either a pending invite by this email or an
    // already-active member whose account happens to use this email?
    const { data: existingProfile } = await supabase.from('profiles').select('id').ilike('email', email).maybeSingle()
    const [{ data: pendingRow }, { data: activeRow }] = await Promise.all([
      supabase.from('team_members').select('id').eq('team_id', teamId).eq('status', 'invited').ilike('invited_email', email).maybeSingle(),
      existingProfile
        ? supabase.from('team_members').select('id').eq('team_id', teamId).eq('user_id', existingProfile.id).eq('status', 'active').maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    if (pendingRow || activeRow) {
      return new Response(JSON.stringify({ error: 'That person is already on your team' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    if (existingProfile) {
      // They already have an Annie account. Only allow adding them if
      // they're not already committed to a different team — this model is
      // one active team per user, and silently moving someone off a team
      // they're already on would be a much bigger, badder surprise than
      // just telling the inviter no.
      const { data: theirMembership } = await supabase
        .from('team_members')
        .select('id')
        .eq('user_id', existingProfile.id)
        .eq('status', 'active')
        .maybeSingle()

      if (theirMembership) {
        return new Response(JSON.stringify({ error: 'That person already belongs to a team and can\'t be added to another.' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }

      const { error } = await supabase.from('team_members').insert({
        team_id: teamId,
        user_id: existingProfile.id,
        role: 'member',
        status: 'active',
        activated_at: new Date().toISOString(),
      })
      if (error) throw new Error(`team_members insert failed: ${error.message}`)

      return new Response(JSON.stringify({ status: 'added' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    // No account yet — create the pending seat, then send the real invite.
    const { error: pendingError } = await supabase.from('team_members').insert({
      team_id: teamId,
      invited_email: email,
      role: 'member',
      status: 'invited',
    })
    if (pendingError) throw new Error(`pending team_members insert failed: ${pendingError.message}`)

    const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${appUrl}/onboarding`,
    })
    if (inviteError) {
      // Don't leave a phantom reserved seat behind if the invite email
      // itself never went out.
      await supabase.from('team_members').delete().eq('team_id', teamId).eq('invited_email', email).eq('status', 'invited')
      throw new Error(`invite email failed: ${inviteError.message}`)
    }

    return new Response(JSON.stringify({ status: 'invited' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('team-invite', err, { userId: user.id, email })
    return new Response(JSON.stringify({ error: 'Could not send that invite' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/team-invite' }

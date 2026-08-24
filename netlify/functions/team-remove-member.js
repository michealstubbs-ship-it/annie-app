// Owner-only removal of a teammate (or of a pending invite that hasn't been
// accepted yet). The removed person keeps their Annie account and login —
// only their membership in this team is deleted, which drops them back to
// having no team at all (they'd need a fresh invite, or to sign up again
// under a new email, to get a team of their own — deliberately not
// auto-granting them a new personal team here, since a removed teammate
// getting instant new access to a blank account isn't obviously the right
// default and Michael hasn't asked for it; flagging this as a decision
// worth a follow-up conversation if it comes up in practice).
import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { createTimeoutFetch } from './lib/scanShared.js'

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
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

  const memberId = body.memberId
  if (!memberId) {
    return new Response(JSON.stringify({ error: 'memberId is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  try {
    const { data: membership } = await supabase
      .from('team_members')
      .select('team_id, role')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle()

    if (!membership || membership.role !== 'owner') {
      return new Response(JSON.stringify({ error: 'Only the team owner can remove members' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
    }

    const { data: target } = await supabase.from('team_members').select('id, team_id, role').eq('id', memberId).maybeSingle()
    if (!target || target.team_id !== membership.team_id) {
      return new Response(JSON.stringify({ error: 'That person is not on your team' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    }
    if (target.role === 'owner') {
      return new Response(JSON.stringify({ error: "The team owner can't remove themselves" }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    const { error } = await supabase.from('team_members').delete().eq('id', memberId)
    if (error) throw new Error(`team_members delete failed: ${error.message}`)

    return new Response(JSON.stringify({ status: 'removed' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    await reportServerError('team-remove-member', err, { userId: user.id, memberId })
    return new Response(JSON.stringify({ error: 'Could not remove that member' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

export const config = { path: '/api/team-remove-member' }

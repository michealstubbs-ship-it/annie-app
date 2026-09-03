import { supabase } from '../supabase'

// Every raw `team_members` roster read, in one place — extracted from the
// query Billing.jsx already built for its "who's on this team" view
// (team_members has no direct FK embed to profiles since it references
// auth.users, not public.profiles, so a second by-id lookup is the
// simplest correct approach — same reasoning as Billing.jsx's own comment).
// Existing behaviour there is untouched; this is the same query shape made
// reusable for the ownership/attribution feature (2026-09-03,
// record-ownership-and-attribution.sql), which needs "who can this record
// be owned by" in several places (Candidates.jsx, Contacts.jsx,
// Companies.jsx), not just the billing/admin page.
//
// Active members only — a pending invite has no user_id yet and can't own
// anything. RLS ("Members can view their team roster") already lets any
// active member read the whole roster, not just the team owner, so this
// is safe to call from any of the pages above, not just Billing.jsx.
export async function listTeamMembers() {
  const { data: members, error: membersError } = await supabase
    .from('team_members')
    .select('user_id, role')
    .eq('status', 'active')
  if (membersError) throw membersError

  const userIds = (members || []).map(m => m.user_id).filter(Boolean)
  const { data: profileRows, error: profilesError } = userIds.length
    ? await supabase.from('profiles').select('id, email, full_name').in('id', userIds)
    : { data: [], error: null }
  if (profilesError) throw profilesError
  const profileById = new Map((profileRows || []).map(p => [p.id, p]))

  return (members || [])
    .filter(m => m.user_id)
    .map(m => {
      const profile = profileById.get(m.user_id)
      return { id: m.user_id, name: profile?.full_name || profile?.email || 'Team member', role: m.role }
    })
}

// Small display helper used everywhere a bare user_id/owner_id needs to
// become a name — falls back gracefully for a member who's since left the
// team (their team_members row would be gone, so they won't be in the
// list, but old records/history can still point at their user_id).
export function nameForMember(teamMembers, userId) {
  if (!userId) return null
  return teamMembers.find(m => m.id === userId)?.name || 'Former team member'
}

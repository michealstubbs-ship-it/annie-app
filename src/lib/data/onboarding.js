import { supabase } from '../supabase'

// Pipeline.jsx's currency lookup: target market lives in the `onboarding`
// table (locations column, an array), not on `profiles` — profiles only
// carries onboarding_completed and firm_name (see
// netlify/functions/save-onboarding.js). Swallows its own errors and
// returns null on any failure/missing row, since a currency guess is the
// only thing that ever depends on this — never worth surfacing as a page
// error.
export async function getOnboardingLocations(userId) {
  try {
    const { data, error } = await supabase.from('onboarding').select('locations').eq('user_id', userId).single()
    if (error || !data?.locations?.length) return null
    return data.locations
  } catch {
    return null
  }
}

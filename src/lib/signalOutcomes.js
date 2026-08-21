// Best-effort, fire-and-forget logging of what actually happens after a
// signal is shown to a recruiter. This is deliberately passive, nothing in
// the UI requires the recruiter to do extra work for this to capture data,
// it just observes actions they're already taking. Nothing reads this data
// yet, it exists so that when it's time to weight future signals by what's
// actually converted for THIS customer, the history is already there
// instead of starting from zero.
import { supabase } from './supabase'

export async function logSignalOutcome(user, signal, stage) {
  if (!user?.id || !signal?.id) return
  try {
    await supabase.from('signal_outcomes').insert({
      user_id: user.id,
      signal_id: signal.id,
      company_name: signal.company_name || null,
      signal_type: signal.signal_type || null,
      stage,
    })
  } catch {
    // Never let outcome logging block or break the actual action.
  }
}

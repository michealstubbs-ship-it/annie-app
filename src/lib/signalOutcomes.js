// Best-effort, fire-and-forget logging of what actually happens after a
// signal is shown to a recruiter. This is deliberately passive, nothing in
// the UI requires the recruiter to do extra work for this to capture data,
// it just observes actions they're already taking.
//
// 2026-09-05: this file's header used to end "Nothing reads this data yet",
// and it had been true since 21 Aug — every judgment every customer made about
// every lead was written down and thrown away. It is read now, in two places
// and at two very different privacy levels:
//
//   src/lib/data/parkedEmployers.js reads a customer's own rows, under their
//   own RLS policy, in their own browser, to work out which EMPLOYERS they
//   keep parking. Only the resulting company-level verdict is pooled across
//   customers, as a company key and one of two words — never a row from here.
//
//   The signal_pool trigger (2026-08-27-signal-pool-quality-feedback.sql)
//   counts 'dismissed' against the shared signal it came from.
//
// Stages actually written today: 'seen' and 'parked' (useStream.js), 'worked'
// and 'dismissed' (useStream.js), 'placed' (Candidates.jsx). Anything else the
// readers see is treated as neutral rather than guessed at.
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

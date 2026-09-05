// The employer-quality loop: read this customer's own outcomes, contribute an
// aggregate, read back the pool.
//
// Two very different things happen in this file and the difference is the
// whole point:
//
//   THE READ OF signal_outcomes is tenant-local. Those rows carry a signal id
//   and a company name and belong to one customer. They are read under that
//   customer's own RLS policy, in that customer's own browser, and nothing in
//   them is ever sent anywhere.
//
//   THE CONTRIBUTION is a desk slug and two lists of company keys. That is the
//   entire payload — record_parked_employers' signature cannot accept anything
//   else. See supabase/migrations/20260905170000_parked_employer_signal.sql,
//   where the schema itself makes a person-level leak impossible.
//
// Michael's rule, 2026-09-05: "share the fact about the ORGANISATION, never
// the record about the PERSON."
import { supabase } from '../supabase'
import { ownEmployerVerdicts, PARK_DECAY_DAYS } from '../employerSignal'

// Enough to cover a heavy user's whole window without an unbounded scan. The
// busiest real account logs a few outcomes a day; 5000 is roughly four years
// of that, against a 180-day window.
const OUTCOME_LIMIT = 5000

/**
 * What this customer's own history says about each employer.
 *
 * Returns Map<companyKey, 'parked' | 'worked'>. Empty on any failure: this
 * feature is a ranking nicety and must never be able to take the stream down.
 */
export async function fetchOwnEmployerVerdicts(userId, { now = new Date() } = {}) {
  if (!userId) return new Map()
  const since = new Date(now.getTime() - PARK_DECAY_DAYS * 86400000).toISOString()
  try {
    // user_id is redundant against the RLS policy and is here anyway: it is
    // what makes this use signal_outcomes_user_id_idx rather than filtering
    // a whole table's worth of rows the policy would then discard.
    const { data, error } = await supabase
      .from('signal_outcomes')
      .select('company_name, stage, created_at')
      .eq('user_id', userId)
      .gte('created_at', since)
      .limit(OUTCOME_LIMIT)
    if (error) return new Map()
    return ownEmployerVerdicts(data || [], { now })
  } catch {
    return new Map()
  }
}

/**
 * Contribute those verdicts to the pool.
 *
 * One round trip, fire-and-forget. A failure here must never affect the feed,
 * and re-sending the same verdicts on every load is free: the primary key
 * allows this customer exactly one row per company, so a hundred loads and a
 * hundred re-parks are still one opinion.
 *
 * Refuses outright when the customer has no desk. An unsegmented vote pools a
 * finance recruiter's judgment with a construction recruiter's, which is
 * exactly how this feature would make Annie narrower rather than sharper. The
 * RPC refuses it too; this is the client agreeing rather than relying.
 */
export function contributeEmployerVerdicts(verdicts, desks = []) {
  const desk = desks?.[0]
  if (!desk || !verdicts?.size) return

  const parked = []
  const worked = []
  for (const [key, verdict] of verdicts) {
    if (verdict === 'worked') worked.push(key)
    else parked.push(key)
  }

  supabase.rpc('record_parked_employers', {
    p_desk: desk,
    p_parked: parked,
    p_worked: worked,
  }).then(() => {}, () => {})
}

// The feed shows tens of cards, not hundreds, and the reader slices at 100
// anyway. Asking about more than that is either confusion or enumeration.
const READ_LIMIT = 100

/**
 * The pooled verdict on a batch of employers, for this customer's desks.
 *
 * Returns Map<companyKey, { parkedVoters, workedVoters } | null>. Every key
 * asked for gets an entry, and a company the pool has nothing to say about
 * gets an explicit null rather than being absent — the caller uses the map to
 * decide what still needs asking, and without the null it would ask about the
 * same silent companies on every render forever.
 *
 * The counts are DISTINCT CUSTOMERS and can only arrive at all once four of
 * them agree the company exists — that floor is in the SQL, not here.
 */
export async function fetchParkedEmployers(companyKeys = [], desks = []) {
  const wanted = [...new Set((companyKeys || []).filter(Boolean))].slice(0, READ_LIMIT)
  const out = new Map()
  if (!wanted.length || !desks?.length) return out
  for (const key of wanted) out.set(key, null)

  try {
    const { data, error } = await supabase.rpc('parked_employer_signal', {
      p_company_keys: wanted,
      p_desks: desks,
    })
    if (error) return out
    for (const row of data || []) {
      if (!row?.company_key) continue
      out.set(row.company_key, {
        parkedVoters: Number(row.parked_voters) || 0,
        workedVoters: Number(row.worked_voters) || 0,
      })
    }
  } catch {
    // The stream simply ranks without the weight, which is what it did
    // before this existed.
  }
  return out
}

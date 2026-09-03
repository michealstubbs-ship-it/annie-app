import { supabase } from '../supabase'

// 2026-09-03, Michael ("commission/fee splits" — the researched Bullhorn
// model: a candidate_owner side and a job_owner side, each split among
// whoever's actually credited on that placement). One invoice_splits row
// per (invoice, user, role_type) — a separate table rather than fixed
// columns on invoices, since more than one person can sit on either side
// (e.g. a desk handover mid-process), which a fixed number of columns
// can't express. Same "replace the whole set" pattern as
// invoices.js's replaceLineItems, for the same reason: a placement's
// splits are always a short, fully-re-enterable list, so diffing
// added/changed/removed rows client-side would be more code for no real
// benefit over just replacing them.

export async function listSplitsForInvoice(invoiceId) {
  const { data, error } = await supabase
    .from('invoice_splits')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('role_type')
  if (error) throw error
  return data || []
}

// Doesn't silently clamp/normalize a bad split — callers (the invoice
// form) show this back to the recruiter as an error rather than saving a
// commission split that doesn't add up to what they typed, since this is
// literally about who gets paid what.
export function validateSplits(splits) {
  const byRole = { candidate_owner: 0, job_owner: 0 }
  for (const s of splits || []) {
    if (!s.userId) return 'Every split needs a team member selected'
    if (!s.splitPct || Number(s.splitPct) <= 0) return 'Every split needs a percentage greater than 0'
    if (!byRole.hasOwnProperty(s.roleType)) return `Unknown split role: ${s.roleType}`
    byRole[s.roleType] += Number(s.splitPct)
  }
  for (const [role, total] of Object.entries(byRole)) {
    // Only enforce the 100% total for a role that has ANY splits at all —
    // a placement with no job-side split entered yet (still being filled
    // in) shouldn't block saving the candidate-side split that's already
    // correct.
    const hasAny = (splits || []).some(s => s.roleType === role)
    if (hasAny && Math.round(total) !== 100) {
      return `${role === 'candidate_owner' ? 'Candidate-owner' : 'Job-owner'} splits must add up to 100% (currently ${total}%)`
    }
  }
  return null
}

export async function replaceSplits(invoiceId, teamId, splits) {
  const error0 = validateSplits(splits)
  if (error0) throw new Error(error0)

  const { error: delErr } = await supabase.from('invoice_splits').delete().eq('invoice_id', invoiceId)
  if (delErr) throw delErr
  if (!splits?.length) return []

  const rows = splits.map(s => ({
    invoice_id: invoiceId,
    team_id: teamId,
    user_id: s.userId,
    role_type: s.roleType,
    split_pct: Number(s.splitPct),
  }))
  const { data, error: insErr } = await supabase.from('invoice_splits').insert(rows).select()
  if (insErr) throw insErr
  return data || []
}

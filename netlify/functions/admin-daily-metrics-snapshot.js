// Writes one row/day to admin_daily_metrics (see that migration's own
// header) so the Annie Overview MRR and signal-quality trend charts have
// real history to draw instead of a single flat point. Runs on Netlify's
// scheduler, once a day — the work here (a handful of aggregate queries
// plus one upsert) is cheap and fast, well inside the 30-second scheduled-
// function budget, so unlike intelligence-scan.js this doesn't need the
// schedule-fires-a-background-function split; that split exists there
// because the actual scan work is slow, not because scheduled functions
// can't do real work themselves.
//
// MRR is computed here in JS, reusing src/lib/pricing.js directly (the one
// place tier prices live — see that file's own header on why duplicating
// prices in a second place, including in SQL, is exactly the kind of drift
// this codebase has been closing) rather than storing raw tier counts and
// letting the frontend re-price history using TODAY's prices — that would
// silently rewrite what MRR "was" every time pricing.js changes. Storing
// the computed dollar figure at snapshot time preserves what was actually
// true that day.
import { createClient } from '@supabase/supabase-js'
import { tierByKey } from '../../src/lib/pricing.js'
import { createTimeoutFetch } from './lib/scanShared.js'
import { reportServerError } from './lib/reportError.js'

export default async () => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    return new Response('Not configured', { status: 200 })
  }

  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  try {
    const { data: subs, error: subsError } = await supabase
      .from('subscriptions')
      .select('tier, seats, status')
      .in('status', ['active', 'trialing'])
    if (subsError) throw new Error(`subscriptions read failed: ${subsError.message}`)

    let mrr = 0
    let activeAccounts = 0
    for (const s of subs || []) {
      activeAccounts += 1
      const tier = tierByKey(s.tier)
      if (!tier) continue // unrecognized/legacy tier key — don't let one bad row throw off the whole total
      mrr += tier.perSeat ? tier.monthly * (s.seats || 1) : tier.monthly
    }

    const { count: signalsTotal, error: signalsErr } = await supabase
      .from('intelligence_signals').select('*', { count: 'exact', head: true })
    const { count: signalsVerified, error: verifiedErr } = await supabase
      .from('intelligence_signals').select('*', { count: 'exact', head: true }).eq('contact_verified', true)
    const { count: companiesTotal, error: companiesErr } = await supabase
      .from('company_enrichment').select('*', { count: 'exact', head: true })
    const { count: companiesMatched, error: matchedErr } = await supabase
      .from('company_enrichment').select('*', { count: 'exact', head: true }).eq('matched', true)
    if (signalsErr || verifiedErr || companiesErr || matchedErr) {
      throw new Error(`data-quality counts failed: ${[signalsErr, verifiedErr, companiesErr, matchedErr].filter(Boolean).map(e => e.message).join('; ')}`)
    }

    const contactVerifiedRate = signalsTotal > 0 ? signalsVerified / signalsTotal : null
    const companyMatchedRate = companiesTotal > 0 ? companiesMatched / companiesTotal : null

    const today = new Date().toISOString().slice(0, 10)
    const { error: upsertError } = await supabase.from('admin_daily_metrics').upsert({
      day: today,
      mrr,
      active_accounts: activeAccounts,
      contact_verified_rate: contactVerifiedRate,
      company_matched_rate: companyMatchedRate,
      computed_at: new Date().toISOString(),
    }, { onConflict: 'day' })
    if (upsertError) throw new Error(`admin_daily_metrics upsert failed: ${upsertError.message}`)

    return new Response('ok', { status: 200 })
  } catch (err) {
    await reportServerError('admin-daily-metrics-snapshot', err, {})
    // Same "never let a background job's own failure alarm anyone but
    // Michael" posture as every other scheduled function here — the next
    // day's run tries again on its own.
    return new Response('error, logged', { status: 200 })
  }
}

export const config = { schedule: '0 1 * * *' }

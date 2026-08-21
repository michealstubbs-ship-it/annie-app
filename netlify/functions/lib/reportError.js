// Best-effort write to public.error_logs so a failure in a Netlify function
// leaves a trace someone can actually find later, instead of only existing
// for a few days in Netlify's own function logs that nobody was watching.
// See supabase-migrations/2026-08-21-error-logs.sql for the table.
//
// Never allowed to affect the caller: reporting failures are swallowed
// exactly like every other fail-open guard in this codebase
// (reserveApolloCredits in scanShared.js is the same philosophy) — a broken
// error reporter must never turn one real error into a second, worse one.
import { createClient } from '@supabase/supabase-js'

// The 4th argument exists purely for tests to inject a mock client — every
// real call site omits it and gets a real one built from env vars.
export async function reportServerError(fnName, err, context = {}, injectedClient = null) {
  try {
    let supabase = injectedClient
    if (!supabase) {
      const supabaseUrl = process.env.VITE_SUPABASE_URL
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!supabaseUrl || !serviceKey) return
      supabase = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    }
    await supabase.from('error_logs').insert({
      source: 'function',
      fn_name: fnName,
      message: (err && err.message) || String(err),
      stack: err && err.stack ? String(err.stack) : null,
      context,
    })
  } catch {
    // Reporting the error must never throw — see file header.
  }
}

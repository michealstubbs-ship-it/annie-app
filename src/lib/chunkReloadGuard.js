// Split out of ErrorBoundary.jsx on purpose: ErrorBoundary.jsx (and
// everything it imports, transitively — errorReporting.js -> supabase.js)
// throws at import time without real Supabase env vars, which is fine at
// runtime (real env vars exist) but makes ErrorBoundary.jsx untestable in
// this repo's Node-environment vitest setup (no jsdom, no env-var
// fixtures — see vitest.config.js). This tiny module has no such
// dependency, so the actual logic worth unit-testing can be, without
// dragging Supabase into a test that has nothing to do with it.
//
// One auto-reload per STALE-CHUNK INCIDENT, not per browser tab session: if
// the reload doesn't clear it (a real network problem, not a stale chunk),
// retrying forever would loop the tab instead of ever showing the customer
// anything. sessionStorage (not a module-level variable) survives the
// reload itself, which is the whole point of needing a flag at all.
//
// 2026-09-04, Michael ("I get the 'something went wrong' message a lot
// between different tabs"): this flag used to only ever get SET (from
// ErrorBoundary's componentDidCatch), never cleared, so it silently
// degraded from "one auto-reload per incident" into "one auto-reload per
// tab, ever" — the next stale-chunk hit from a LATER deploy, arbitrarily
// long after the first one healed itself, fell straight through to the
// visible error card instead of getting its own chance to self-heal.
// Exactly what happened today: several deploys landed back to back while
// Michael's tab stayed open, so only the very first stale-chunk incident
// recovered silently and every one after it surfaced the alarming card for
// something that, again, wasn't actually broken. Fixed by clearing this
// flag once the app successfully boots (see main.jsx) — reaching that
// point proves the current tab is now running fresh, matching-hash JS, so
// the next stale-chunk incident (from whatever future deploy) deserves its
// own silent first attempt again, same as this one just got.
export const CHUNK_RELOAD_GUARD_KEY = 'annie_chunk_reload_attempted'

export function hasAlreadyAttemptedChunkReload() {
  try {
    return sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) === '1'
  } catch {
    return false
  }
}

export function markChunkReloadAttempted() {
  try { sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1') } catch {}
}

// Called once from main.jsx right after a successful boot. Not exported
// alongside anything else that manipulates the flag's value on purpose —
// main.jsx should only ever clear it, never set or read it.
export function clearChunkReloadGuard() {
  try { sessionStorage.removeItem(CHUNK_RELOAD_GUARD_KEY) } catch {}
}

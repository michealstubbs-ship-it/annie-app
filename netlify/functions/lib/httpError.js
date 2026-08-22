// A production-readiness audit (2026-08-22) found error responses shaped
// inconsistently across functions — some plain text, some JSON, some JSON
// with no Content-Type header at all (confirm-contact.js, save-onboarding.js,
// scan-status.js all did this). A caller or monitoring tool expecting one
// consistent envelope got different shapes for the identical condition.
// One helper, used everywhere a user-facing (frontend-called) function
// returns an error, fixes that once instead of function-by-function.
export function jsonError(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

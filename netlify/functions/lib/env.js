// Every function read its own hand-picked list of env vars and checked
// `if (!x || !y || !z)` individually — easy to typo, easy to forget one.
// Centralized so "which vars does this endpoint need, and are they all
// present" is one call instead of a bespoke block per file.
export function requireEnv(names) {
  const values = {}
  const missing = []
  for (const name of names) {
    const v = process.env[name]
    values[name] = v
    if (!v) missing.push(name)
  }
  return { values, missing, ok: missing.length === 0 }
}

// 2026-08-26: found during a line-by-line audit — every numeric env-var
// override in this codebase used the same `parseInt(process.env.X, 10) ||
// DEFAULT` pattern, in entitlements.js, scanShared.js, chat.js, and
// start-trial-checkout.js. That pattern is correct when the var is unset
// (`parseInt(undefined, 10)` is NaN, which is falsy, so `|| DEFAULT`
// correctly falls back) but silently wrong for the one case an operator
// would actually reach for `X=0` on purpose — an emergency kill-switch,
// e.g. "set FREE_MONTH_MAX_REDEMPTIONS=0 to retire the free-trial code
// right now" or "set CHAT_PER_MINUTE_CAP=0 to pause chat during an
// incident". `parseInt("0", 10)` is `0`, and `0` is also falsy, so
// `0 || DEFAULT` silently reverts to the non-zero default instead of
// actually disabling the thing — the exact moment an operator needs the
// override to work is the one moment this pattern quietly ignores it.
// This distinguishes "unset/unparseable" (fall back to default) from
// "explicitly zero" (respect it) the way a plain `||` fallback can't.
export function parseIntEnv(raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  const parsed = parseInt(raw, 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

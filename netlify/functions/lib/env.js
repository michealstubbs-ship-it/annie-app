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

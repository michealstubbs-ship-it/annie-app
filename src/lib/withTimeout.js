// Supabase calls can hang indefinitely client-side (a browser extension, a
// corporate network policy, or an ad/privacy blocker silently swallowing the
// request) rather than rejecting cleanly. Without a hard timeout that shows up
// as a stuck spinner and nothing saved, with no error and no way to tell what
// went wrong — much worse than a clear, retryable failure. Wrap any
// user-triggered Supabase write in this so it always resolves one way or the
// other.
export function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT:${label}`)), ms)),
  ])
}

// Shared, consistent copy for the two places this shows up (Onboarding,
// LinkedIn import) so the advice is the same wherever a save times out.
export const TIMEOUT_MESSAGE = "This is taking too long, which usually means a browser extension (ad blocker, privacy tool) is silently blocking the save. Try again in an Incognito/Private window, or temporarily disable extensions for this site."

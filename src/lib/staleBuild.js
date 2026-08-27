// Detects when THIS TAB is still running a previous deploy's JS — the root
// cause behind the whole "stale tab" class of failure (see
// chatErrorMessage.js and ErrorBoundary.jsx's own header comments for two
// symptoms of the same thing). Rather than only recovering after a stale
// tab causes a failure, Chat.jsx calls isTabStale() as a pre-flight check
// before every send() — so a tab that's definitely stale never even
// attempts a doomed request, it goes straight to the reload prompt instead.
//
// 2026-08-27: built as the second, root-cause layer alongside
// chatErrorMessage.js's reactive "offer a reload after the fact" fix and
// callChat.js's retry-once (for the genuinely-transient blip this check
// can't see coming — a request that lands in the split-second Netlify
// swaps one deploy's functions for the next, with no stale JS involved at
// all). Same three-layer shape as the rest of this codebase's resilience
// fixes: catch it before it happens where possible (this file), absorb a
// single transient failure automatically (callChat.js), and never leave
// the customer at a dead end for whatever's left over
// (chatErrorMessage.js's reload suggestion).
//
// Split into a pure, DOM-free core (checkUrlsStale) plus a thin
// document-reading wrapper (isTabStale) so the actual logic is testable
// under this project's node-environment vitest config without a jsdom
// setup this codebase doesn't otherwise use — same reasoning as keeping
// shouldSearchWeb (chatWebSearch.js) a plain, injectable function.
export async function checkUrlsStale(urls, fetchImpl = fetch) {
  if (!urls.length) return false // nothing to check against — fail open, never block a real send over an inconclusive check

  const results = await Promise.all(
    urls.map(url =>
      fetchImpl(url, { method: 'HEAD', cache: 'no-store' })
        .then(r => r.ok)
        // A thrown fetch error (offline, a blocked request, an unrelated
        // network problem) means "couldn't tell" — treated as NOT stale so
        // a real outage is never mistaken for, and reported as, a stale
        // deploy.
        .catch(() => true)
    )
  )
  return results.some(ok => !ok)
}

// Vite content-hashes every built filename, so the tab's own already-loaded
// entry script(s) are the one thing worth checking: if the exact file this
// tab is currently running no longer exists on the server, a newer deploy
// replaced it — nothing else can make that specific filename disappear.
// Reading it straight off the live document means this never has to
// duplicate Vite's own build-output naming in a second place.
export async function isTabStale(fetchImpl = fetch) {
  if (typeof document === 'undefined') return false
  const urls = Array.from(document.querySelectorAll('script[type="module"][src]'))
    .map(el => el.src)
    .filter(Boolean)
  return checkUrlsStale(urls, fetchImpl)
}

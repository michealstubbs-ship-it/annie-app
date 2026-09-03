// 2026-09-06, gap-analysis batch 2 ("installable mobile app (PWA)"): the
// single most consistent complaint across every vendor researched was a
// bad mobile app, not a MISSING one — so this deliberately does the
// smallest thing that's genuinely safe for a live CRM: an installable
// shell that survives a flaky connection, not an offline-first data
// cache. Annie's data (candidates, pipeline, signals) is never served
// stale from here — only the app's own static shell/JS/CSS/images are
// cached, and every Supabase/Netlify-function call bypasses this worker
// entirely (see the very first check in fetch below).
const CACHE_VERSION = 'annie-shell-v1'

self.addEventListener('install', event => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_VERSION).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Never intercept anything that isn't this same origin's own static
  // build output — Supabase's REST/Realtime/Storage calls, every Netlify
  // function, and any third-party asset (Google Fonts, cdnjs) all go
  // straight to the network, untouched, every time. This is the whole
  // safety property of this worker: it can only ever make the SHELL
  // faster/more resilient, never serve a stale read of real CRM data.
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/.netlify/')) return

  // Navigations (a fresh tab, a reload, an installed-app cold start):
  // network first so a logged-in user always gets the current app,
  // falling back to the cached shell only when the network genuinely
  // fails (offline, or mid-flight on a bad connection) rather than
  // showing the browser's own blank error page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    )
    return
  }

  // Everything else this app itself ships (hashed JS/CSS chunks, icons,
  // fonts-that-are-actually-local) — stale-while-revalidate: an instant
  // cached response when one exists, with a background refresh so the
  // NEXT load picks up a new deploy. A brand-new asset with no cache
  // entry yet just falls through to the network like normal.
  event.respondWith(
    caches.open(CACHE_VERSION).then(async cache => {
      const cached = await cache.match(request)
      const network = fetch(request).then(resp => {
        if (resp.ok) cache.put(request, resp.clone())
        return resp
      }).catch(() => null)
      return cached || (await network) || fetch(request)
    })
  )
})

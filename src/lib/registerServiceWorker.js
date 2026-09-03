// 2026-09-06, gap-analysis batch 2 ("installable mobile app (PWA)") — see
// public/sw.js's own header for what this worker does and, just as
// importantly, does not cache. Only registered in production: registering
// it in dev would mean iterating against a cached shell instead of Vite's
// own dev server output, a well-known service-worker-in-dev footgun.
export function registerServiceWorker() {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Best-effort only — a failed registration should never block the
      // app itself from loading and working normally.
    })
  })
}

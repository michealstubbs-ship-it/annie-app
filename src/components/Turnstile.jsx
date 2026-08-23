import React, { useEffect, useRef } from 'react'

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY

// Loaded once and reused across every mount — Turnstile's own script caches
// nothing about this per-component, but re-injecting <script> tags on every
// remount (e.g. flipping between login/signup mode) would fetch it again
// for no reason. A module-level promise makes every caller await the same
// single load.
let scriptPromise = null
function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve()
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = SCRIPT_SRC
      script.async = true
      script.defer = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Failed to load Turnstile'))
      document.head.appendChild(script)
    })
  }
  return scriptPromise
}

// Bot-protection widget shown on signup only (see Login.jsx). Renders
// nothing — and calls onVerify with null — if VITE_TURNSTILE_SITE_KEY isn't
// set, so a dev environment without Cloudflare configured doesn't block
// signup locally; verify-turnstile.js is the real gate in production.
export default function Turnstile({ onVerify, onExpire }) {
  const containerRef = useRef(null)
  const widgetIdRef = useRef(null)

  useEffect(() => {
    if (!SITE_KEY) return
    let cancelled = false

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          callback: (token) => onVerify?.(token),
          'expired-callback': () => onExpire?.(),
          'error-callback': () => onExpire?.(),
        })
      })
      .catch((err) => {
        console.error(err)
        onExpire?.()
      })

    return () => {
      cancelled = true
      if (widgetIdRef.current != null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!SITE_KEY) return null

  return <div ref={containerRef} className="mt-1" />
}

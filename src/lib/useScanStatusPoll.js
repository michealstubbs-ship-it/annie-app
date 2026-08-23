import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './supabase'

// Shared by Overview.jsx (auto-resumes watching a scan onboarding started)
// and Settings.jsx (starts and watches a self-serve rescan) — both used to
// carry their own near-identical copy of this same fetch + localStorage-flag
// + recursive-setTimeout logic, which had already drifted slightly (one used
// a literal string key, the other a named constant) before this pass.
function scanFlagKey(userId) {
  return `annie_scan_started_${userId}`
}

async function fetchScanStatus() {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return { status: 'unknown' }
    const resp = await fetch('/.netlify/functions/scan-status', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    return await resp.json().catch(() => ({ status: 'unknown' }))
  } catch {
    return { status: 'unknown' }
  }
}

/**
 * Polls scan-status.js for a background research scan started by this
 * account, whichever page actually kicked it off (onboarding, or a
 * self-serve rescan from Settings) — both are tracked under the same
 * localStorage flag so either page can pick up the same in-flight scan.
 *
 * @param {object} opts
 * @param {{id: string}|null} opts.user
 * @param {number} opts.windowMs - how long to keep polling locally before giving up and reporting `still_running`
 * @param {number} [opts.initialDelayMs=3000] - delay before the first status check
 * @param {number} [opts.intervalMs=5000] - delay between subsequent checks
 * @param {boolean} [opts.autoDetectExisting=false] - on mount (or when `user` changes), resume polling if a not-yet-expired flag is already set, e.g. onboarding started a scan before this page was open
 * @param {(result: object) => void} [opts.onDone] - called once, with the final scan-status result, whether the scan genuinely finished or this poll's own window ran out first
 */
export function useScanStatusPoll({ user, windowMs, initialDelayMs = 3000, intervalMs = 5000, autoDetectExisting = false, onDone }) {
  const [polling, setPolling] = useState(false)
  const [result, setResult] = useState(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const finish = useCallback((userId, finalResult) => {
    setPolling(false)
    setResult(finalResult)
    try { localStorage.removeItem(scanFlagKey(userId)) } catch {}
    onDoneRef.current?.(finalResult)
  }, [])

  const poll = useCallback((userId, startedAt) => {
    setPolling(true)
    let cancelled = false
    let timer

    async function tick() {
      const status = await fetchScanStatus()
      if (cancelled) return

      if (status?.status === 'done') {
        finish(userId, status)
        return
      }
      if (Date.now() - startedAt > windowMs) {
        finish(userId, { status: 'done', reason: 'still_running' })
        return
      }
      timer = setTimeout(tick, intervalMs)
    }

    timer = setTimeout(tick, initialDelayMs)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [windowMs, intervalMs, initialDelayMs, finish])

  // Manual start — Settings.jsx calls this right after firing
  // scan-now-background, so the flag and the poll both begin together.
  const start = useCallback(() => {
    if (!user) return undefined
    const startedAt = Date.now()
    try { localStorage.setItem(scanFlagKey(user.id), String(startedAt)) } catch {}
    setResult(null)
    return poll(user.id, startedAt)
  }, [user, poll])

  // Auto-resume — Overview.jsx opts into this to pick up a scan that
  // onboarding already started before this page ever mounted.
  useEffect(() => {
    if (!user || !autoDetectExisting) return undefined
    let startedAt = 0
    try { startedAt = Number(localStorage.getItem(scanFlagKey(user.id))) || 0 } catch {}
    if (!startedAt || Date.now() - startedAt > windowMs) return undefined
    return poll(user.id, startedAt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, autoDetectExisting])

  return { polling, result, start }
}

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './supabase'
import { reportClientError } from './errorReporting'

// Shared by Overview.jsx (auto-resumes watching a scan onboarding started)
// and Settings.jsx (starts and watches a self-serve rescan) — both used to
// carry their own near-identical copy of this same fetch + localStorage-flag
// + recursive-setTimeout logic, which had already drifted slightly (one used
// a literal string key, the other a named constant) before this pass.
function scanFlagKey(userId) {
  return `annie_scan_started_${userId}`
}

// 2026-08-27 audit fix: found via the 19-scenario staged first-scan audit —
// every caller of this (Onboarding.jsx, Settings.jsx, Overview.jsx all had
// their own copy) fired this POST and only ever caught the fetch() PROMISE
// rejecting, never checked whether the response it got back was actually
// OK. That's exactly the same gap fixed server-side in fireNextRound (see
// scan-now-background.js) — a rejected request (a network blip, or the
// same kind of gateway rejection under load that broke this for real) came
// back looking identical to a real scan quietly starting, right up until
// this same file's own poll window ran out and told the customer "still
// running" for a scan that in fact never started at all, since scan-
// status.js never even got a status blob to report on. One immediate
// retry, then a reported (still non-throwing) failure — callers decide
// for themselves whether that needs to be surfaced in their own UI.
export async function triggerScanNow(accessToken) {
  const attempt = () => fetch('/.netlify/functions/scan-now-background', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  try {
    let resp = await attempt()
    if (!resp.ok) resp = await attempt()
    if (!resp.ok) {
      reportClientError(`scan trigger failed with HTTP ${resp.status}`, null, { stage: 'trigger-scan-now' })
      return false
    }
    return true
  } catch (err) {
    reportClientError('scan trigger failed', err, { stage: 'trigger-scan-now' })
    return false
  }
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
 * @param {(status: object) => void} [opts.onTick] - called on every poll response, including the final one, before onDone fires — for a caller that wants to show live progress while a multi-round scan is still chaining (e.g. "14 of 20 found so far"), not just the end result
 */
export function useScanStatusPoll({ user, windowMs, initialDelayMs = 3000, intervalMs = 5000, autoDetectExisting = false, onDone, onTick }) {
  const [polling, setPolling] = useState(false)
  const [result, setResult] = useState(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onTickRef = useRef(onTick)
  onTickRef.current = onTick

  // 2026-08-26 audit fix: generalizes the token-superseding pattern
  // Overview.jsx used to hand-roll itself (pollTokenRef) into the shared
  // hook, so both call sites get it "for free" — without this, a poll
  // resumed automatically on mount (autoDetectExisting) and a poll started
  // manually moments later (e.g. the user clicks "look again" before the
  // auto-resumed poll finished) would tick independently and race each
  // other's setResult/setPolling calls. Only the most recently started
  // poll is ever allowed to write state; an older one silently stops on
  // its next tick instead.
  const activeTokenRef = useRef(null)

  const finish = useCallback((userId, finalResult) => {
    setPolling(false)
    setResult(finalResult)
    try { localStorage.removeItem(scanFlagKey(userId)) } catch {}
    onDoneRef.current?.(finalResult)
  }, [])

  const poll = useCallback((userId, startedAt) => {
    const token = {}
    activeTokenRef.current = token
    setPolling(true)
    let timer

    async function tick() {
      if (activeTokenRef.current !== token) return
      const status = await fetchScanStatus()
      if (activeTokenRef.current !== token) return
      onTickRef.current?.(status)

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
    return () => { if (activeTokenRef.current === token) activeTokenRef.current = null; clearTimeout(timer) }
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

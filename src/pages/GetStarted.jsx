// The first screen after onboarding: give Annie something to watch.
//
// It replaces /import, which showed the LinkedIn CSV importer and a "Skip for
// now" link. The link set profiles.linkedin_import_completed = true, which was
// the flag the dashboard gate read — so the ordinary path through signup was
// to skip (LinkedIn can take 24 hours to email the export), land on a
// dashboard with an empty CRM, and be shown the open market. Annie's whole
// argument is that the best leads are already in your own network; the first
// screen said the opposite.
//
// The mailbox is step one now: instant OAuth instead of a 24-hour wait, and
// the only source that yields real interaction history — of 753 LinkedIn
// contacts on the production account, zero had a note or a logged call. The
// contacts export is step two, and it is the way in for anyone who will not
// hand over a mailbox ninety seconds after signing up. There is no step three.
//
// All the copy lives in lib/getStarted.js, which is where it is tested. This
// file is layout.
import { useState, useEffect, useRef, Suspense, lazy } from 'react'
import { useAuth } from '../contexts/AuthContext'
import PageLoader from '../components/PageLoader'
import ErrorBanner from '../components/ErrorBanner'
import { getEmailStatus, startEmailConnect } from '../lib/email/emailApi'
import { getStartedCopy } from '../lib/getStarted'
import { mailboxState, MAILBOX_CONNECTED, MAILBOX_CONNECTING } from '../lib/networkGate'
import { trackEvent } from '../lib/analytics'

// Kept lazy, and imported from nowhere else at the top level, so it stays in
// its own chunk — the same reason App.jsx stopped importing it statically.
const LinkedInImport = lazy(() => import('./LinkedInImport'))

// Coming back from Google or Microsoft, the account row is written by
// Unipile's webhook, not by the browser that just landed here — so the status
// is 'connecting' for a moment after the redirect. Poll rather than tell
// someone their mailbox failed one second before it succeeds.
const CONFIRM_POLL_MS = 3000
const CONFIRM_POLL_TRIES = 20

export default function GetStarted() {
  const { refreshNetwork } = useAuth()

  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [confirming, setConfirming] = useState(
    () => new URLSearchParams(window.location.search).get('email') === 'connected',
  )
  const triesRef = useRef(0)

  const read = async () => {
    const next = await getEmailStatus()
    setStatus(next)
    setLoading(false)
    return next
  }

  useEffect(() => { read() }, [])

  // The wait after consent. Every pass also refreshes the gate, so the moment
  // the mailbox lands GetStartedRoute sends them on to the dashboard — this
  // screen never has to navigate anywhere itself.
  useEffect(() => {
    if (!confirming) return
    let live = true
    const timer = setInterval(async () => {
      if (!live) return
      triesRef.current += 1
      const next = await read()
      if (mailboxState(next?.account) === MAILBOX_CONNECTED) {
        setConfirming(false)
        await refreshNetwork()
        return
      }
      if (triesRef.current >= CONFIRM_POLL_TRIES) setConfirming(false)
    }, CONFIRM_POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [confirming, refreshNetwork])

  async function connect() {
    setBusy(true)
    setError('')
    trackEvent('get_started_mailbox_connect_started')
    const { url, error: err } = await startEmailConnect({ returnTo: '/get-started?email=connected' })
    if (url) { window.location.href = url; return }
    setBusy(false)
    setError(err || 'Could not start the connection. Upload a contacts export instead, or try again.')
  }

  if (loading) return <PageLoader />

  const mailbox = mailboxState(status?.account)
  const copy = getStartedCopy({
    mailbox: confirming ? MAILBOX_CONNECTING : mailbox,
    mailboxOffered: Boolean(status?.available && status?.configured),
  })

  return (
    <div className="min-h-screen bg-navy flex flex-col items-center justify-center px-4 py-12">
      <div className="flex items-center gap-3 mb-8">
        <svg width="40" height="40" viewBox="0 0 36 36" fill="none">
          <rect width="36" height="36" rx="8" fill="#c9a84c"/>
          <path d="M18 3L29 33H25L18 13L11 33H7L18 3Z" fill="#0d1b3e"/>
          <rect x="10" y="22" width="16" height="3.2" rx="1.6" fill="#c9a84c"/>
        </svg>
        <div>
          <div className="text-white font-bold text-xl leading-none">annie</div>
          <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-8 shadow-2xl w-full max-w-2xl">
        {showUpload ? (
          <Suspense fallback={<PageLoader />}>
            <LinkedInImport embedded onCancel={() => setShowUpload(false)} cancelLabel="← Back" />
          </Suspense>
        ) : (
          <>
            <h2 className="text-2xl font-bold text-navy mb-1">{copy.heading}</h2>
            <p className="text-gray-500 text-sm mb-6">{copy.intro}</p>

            <ErrorBanner>{error}</ErrorBanner>

            {copy.mailbox && (
              <div className="border-2 border-gold rounded-xl p-5 mb-4 bg-yellow-50">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-navy text-gold text-xs font-bold flex items-center justify-center flex-shrink-0">1</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-navy mb-1">{copy.mailbox.title}</div>
                    <p className="text-xs text-gray-600 mb-3">{copy.mailbox.body}</p>

                    {copy.mailbox.state === 'offer' && (
                      <ul className="space-y-1.5 mb-4">
                        {copy.mailbox.points.map(point => (
                          <li key={point} className="flex gap-2 text-xs text-gray-700">
                            <span className="text-emerald-600 font-bold" aria-hidden="true">✓</span>
                            <span>{point}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {copy.mailbox.state === 'waiting' && (
                      <div className="flex items-center gap-2.5 mb-3">
                        <div className="w-4 h-4 border-2 border-gold border-t-transparent rounded-full animate-spin" />
                        <span className="text-xs text-gray-500">Waiting for confirmation…</span>
                      </div>
                    )}

                    {copy.mailbox.state !== 'connected' && (
                      <>
                        <div className="bg-white/70 border border-gold/40 rounded-lg px-3 py-2.5 mb-4">
                          <p className="text-[11px] text-gray-600 leading-relaxed">
                            <span className="font-semibold text-navy">What Annie does not do: </span>
                            {copy.mailbox.keeps}
                          </p>
                        </div>
                        <button onClick={connect} disabled={busy} className="btn-primary text-sm">
                          {busy ? 'Opening…' : copy.mailbox.cta}
                        </button>
                        <p className="text-[11px] text-gray-400 mt-2">{copy.mailbox.note}</p>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="bg-page-bg rounded-xl p-5 mb-6">
              <div className="flex items-start gap-3">
                {copy.mailbox && (
                  <div className="w-6 h-6 rounded-full bg-white border border-gray-200 text-gray-500 text-xs font-bold flex items-center justify-center flex-shrink-0">2</div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-navy mb-1">{copy.upload.title}</div>
                  <p className="text-xs text-gray-600 mb-2">{copy.upload.body}</p>
                  <p className="text-[11px] text-gray-400 mb-3">{copy.upload.note}</p>
                  <button onClick={() => setShowUpload(true)} className="btn-secondary text-sm">
                    {copy.upload.cta}
                  </button>
                </div>
              </div>
            </div>

            {/* No skip. This is the sentence that used to be a link. */}
            <p className="text-[11px] text-gray-400 leading-relaxed">{copy.footnote}</p>
          </>
        )}
      </div>
    </div>
  )
}

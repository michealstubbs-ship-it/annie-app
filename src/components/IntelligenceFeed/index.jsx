// The Intelligence Feed — one stream.
//
// 2026-09-04, Michael, approving a pre-launch rebuild: Today's Actions and the
// Intelligence Feed merge into this one surface, keeping this name. They
// always read the same table (intelligence_signals); what divided them was an
// invisible contact gate in isEligibleSourced that required a verified Apollo
// contact before anything reached Today's Actions.
//
// Measured over seven days across five test tenants, that gate hid 338 of 446
// BD signals — 82% in the GCC, 65% in the UK, 58% in the US. Among the
// suppressed: Man Group filing for an ADGM licence, Aldar's AED 38bn Dubai
// joint venture, Stake's $31M Series B led by Emirates NBD. Each had been
// discovered, researched, enriched and paid for, then shown to nobody.
//
// So nothing here is hidden for lacking a contact. Every item is ranked by the
// strength of the route in and says which rung it is on. CRM housekeeping —
// follow-ups, dormant contacts, meeting prep — has moved out; on day one of
// the snag week this page showed nine cards and every one was admin.
import { useState, useMemo, useEffect } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useStream } from './useStream'
import StreamItem from './StreamItem'
import Spinner from '../Spinner'
import ErrorBanner from '../ErrorBanner'
import { STATE_WORKING, STATE_PARKED } from '../../lib/stream/buildStream'
import TopUpPanel from './TopUpPanel'
import EmailSyncBanner from './EmailSyncBanner'
import { getEmailStatus } from '../../lib/email/emailApi'

// 2026-09-05: four tabs became one list.
//
// "With a route in" only ever needed to exist because most items had no route
// in - 31 of 38 on a real account. Now that the scan is scoped to the
// customer's own companies, everything in the list has a route in, so the tab
// was selecting the whole list. Working and Parked are STATES, not places: they
// belong on a quiet toggle beside the list, not as destinations you navigate
// to and have to remember to come back from.
//
// The eight type chips went with them. The type is already a coloured pill on
// every card, and filtering thirty-odd items by "Expansion" is not a job a
// recruiter does - they read the list. Nine controls removed, two rows became
// one, and the first card moved up the page by about eighty pixels.
const ASIDES = [
  { key: 'working', label: 'Working' },
  { key: 'parked', label: 'Parked' },
]

export default function IntelligenceFeed() {
  const { user, profile } = useAuth()
  const { items, counts, credits, loading, error, onboarding, contacts, setState, markDone, dismiss, markSeen, applyResolvedContact, applyContactLogged, applyContactSaved } = useStream({ user })
  // Asked once for the whole feed, not once per card: twenty items would
  // otherwise fire twenty identical status calls on every render pass. A
  // failure here is silent on purpose — email is an extra, and the feed must
  // still work exactly as before when it is off or unreachable.
  const [emailReady, setEmailReady] = useState(false)
  useEffect(() => {
    let live = true
    getEmailStatus().then(status => {
      if (live) setEmailReady(Boolean(status?.available && status?.account?.status === 'connected'))
    })
    return () => { live = false }
  }, [])

  const [view, setView] = useState('all')
  const [topUpDismissed, setTopUpDismissed] = useState(false)

  // Only surfaced when the allowance is genuinely nearly gone. Showing a buy
  // prompt to someone with 40 of 50 left is a shop, not a product.
  const lowOnCredits = !!credits && credits.limit > 0 && credits.remaining <= Math.max(3, Math.round(credits.limit * 0.1))

  const visible = useMemo(() => {
    if (view === 'working') return items.filter(i => i.state === STATE_WORKING)
    if (view === 'parked') return items.filter(i => i.state === STATE_PARKED)
    // The list. Parked items are the only thing held back, because the
    // recruiter explicitly said not now.
    return items.filter(i => i.state !== STATE_PARKED)
  }, [items, view])

  const asideCount = (key) => (key === 'working' ? counts.working : counts.parked)
  const listCount = counts.all - counts.parked

  return (
    <div className="max-w-4xl">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-1">
        <div>
          <h1 className="text-2xl font-bold text-navy">Intelligence Feed</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            What moved in your markets, and how you get in.
          </p>
        </div>

        {/* The contact allowance. Shown from the start rather than sprung on
            someone at the ceiling — and it counts CONTACTS, not attempts,
            because a lookup that finds nobody is free. */}
        {credits && (
          <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-xl px-3.5 py-2">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-400 font-bold">Contact lookups</div>
              <div className="text-navy font-bold tabular-nums">
                {credits.remaining}
                <span className="text-gray-400 font-medium text-[12px]">
                  {' '}left{credits.topupBalance > 0 && ` (${credits.topupBalance} purchased)`}
                </span>
              </div>
            </div>
            <div className="w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div
                className="h-full bg-gold rounded-full transition-all"
                style={{ width: `${Math.max(0, Math.min(100, (credits.remaining / Math.max(1, credits.limit + (credits.topupBalance || 0))) * 100))}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {lowOnCredits && !topUpDismissed && (
        <div className="mt-4">
          <TopUpPanel credits={credits} tier={credits.tier} onClose={() => setTopUpDismissed(true)} />
        </div>
      )}

      {/* One row. The list is the product; Working and Parked are somewhere you
          glance, not somewhere you go, so they sit to the right as quiet
          toggles that show a count only when they hold something. */}
      <div className="flex items-center justify-between gap-3 flex-wrap border-b border-gray-200 mt-4 mb-3 pb-2">
        <button
          onClick={() => setView('all')}
          className={`text-[15px] font-bold pb-1.5 border-b-2 -mb-2.5 transition-colors ${
            view === 'all' ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'
          }`}
        >
          Who to call {listCount > 0 && <span className="text-[13px] font-semibold text-gray-400">({listCount})</span>}
        </button>

        <div className="flex items-center gap-1">
          {ASIDES.map(a => (
            asideCount(a.key) > 0 || view === a.key ? (
              <button
                key={a.key}
                onClick={() => setView(view === a.key ? 'all' : a.key)}
                className={`text-[12.5px] font-semibold px-2.5 py-1 rounded-lg transition-colors ${
                  view === a.key ? 'bg-navy text-gold' : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {a.label} {asideCount(a.key) > 0 && `(${asideCount(a.key)})`}
              </button>
            ) : null
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : visible.length === 0 ? (
        <div className="card p-12 text-center">
          <h3 className="font-bold text-navy mb-1">
            {view === 'parked' ? 'Nothing parked' : view === 'working' ? 'Nothing in progress' : 'No one to call yet'}
          </h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">
            {view === 'all'
              ? 'Annie watches the companies and people you already know. Import your LinkedIn contacts and she has a network to watch — until then there is nothing she can honestly recommend.'
              : 'Close this to go back to your list.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <EmailSyncBanner userId={user?.id} />
          {visible.map(item => (
            <StreamItem
              contacts={contacts}
              key={item.id}
              item={item}
              userId={user?.id}
              profile={profile}
              onboarding={onboarding}
              emailReady={emailReady}
              onSetState={setState}
              onDone={markDone}
              onDismiss={dismiss}
              onSeen={markSeen}
              onResolved={applyResolvedContact}
              onContactLogged={applyContactLogged}
              onContactSaved={applyContactSaved}
            />
          ))}
        </div>
      )}
    </div>
  )
}

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
import { useState, useMemo } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useStream } from './useStream'
import StreamItem from './StreamItem'
import Spinner from '../Spinner'
import ErrorBanner from '../ErrorBanner'
import { SIGNAL_TYPE_META } from '../../lib/signalTypes'
import { STATE_WORKING, STATE_PARKED } from '../../lib/stream/buildStream'
import { RUNG_COLD } from '../../lib/stream/wayIn'
import TopUpPanel from './TopUpPanel'

const VIEWS = [
  { key: 'all', label: 'Everything' },
  { key: 'route', label: 'With a route in' },
  { key: 'working', label: 'Working' },
  { key: 'parked', label: 'Parked' },
]

export default function IntelligenceFeed() {
  const { user, profile } = useAuth()
  const { items, counts, credits, loading, error, onboarding, setState, markDone, dismiss, markSeen, applyResolvedContact, applyContactLogged, applyContactSaved } = useStream({ user })
  const [view, setView] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [topUpDismissed, setTopUpDismissed] = useState(false)

  // Only surfaced when the allowance is genuinely nearly gone. Showing a buy
  // prompt to someone with 40 of 50 left is a shop, not a product.
  const lowOnCredits = !!credits && credits.limit > 0 && credits.remaining <= Math.max(3, Math.round(credits.limit * 0.1))

  const presentTypes = useMemo(
    () => [...new Set(items.map(i => i.signal.signal_type))],
    [items],
  )

  const visible = useMemo(() => {
    let list = items
    if (view === 'route') list = list.filter(i => i.wayIn.rung !== RUNG_COLD)
    else if (view === 'working') list = list.filter(i => i.state === STATE_WORKING)
    else if (view === 'parked') list = list.filter(i => i.state === STATE_PARKED)
    else list = list.filter(i => i.state !== STATE_PARKED)
    if (typeFilter !== 'all') list = list.filter(i => i.signal.signal_type === typeFilter)
    return list
  }, [items, view, typeFilter])

  const viewCount = (key) => {
    if (key === 'all') return counts.all - counts.parked
    if (key === 'route') return counts.withWayIn
    if (key === 'working') return counts.working
    return counts.parked
  }

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

      <div className="flex items-center gap-1 border-b border-gray-200 mt-4 mb-3 overflow-x-auto">
        {VIEWS.map(v => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={`px-3 py-2.5 text-[13.5px] font-bold border-b-2 -mb-0.5 whitespace-nowrap transition-colors ${
              view === v.key ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'
            }`}
          >
            {v.label} {viewCount(v.key) > 0 && <span className="text-xs font-semibold">({viewCount(v.key)})</span>}
          </button>
        ))}
      </div>

      {presentTypes.length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 mb-4">
          <button
            onClick={() => setTypeFilter('all')}
            className={`flex-shrink-0 text-[12.5px] font-bold px-3.5 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
              typeFilter === 'all' ? 'bg-navy text-gold border-navy' : 'bg-page-bg text-gray-600 border-gray-200 hover:border-gray-300'
            }`}
          >All types</button>
          {presentTypes.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`flex-shrink-0 text-[12.5px] font-bold px-3.5 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
                typeFilter === t ? 'bg-navy text-gold border-navy' : 'bg-page-bg text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
            >
              {(SIGNAL_TYPE_META[t]?.icon ? SIGNAL_TYPE_META[t].icon + ' ' : '') + (SIGNAL_TYPE_META[t]?.chipLabel || SIGNAL_TYPE_META[t]?.label || t)}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : visible.length === 0 ? (
        <div className="card p-12 text-center">
          <h3 className="font-bold text-navy mb-1">
            {view === 'parked' ? 'Nothing parked' : view === 'working' ? 'Nothing in progress' : 'Nothing here yet'}
          </h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">
            {view === 'all'
              ? 'Annie scans your sectors and markets twice a day in the background. Check back soon, or import your LinkedIn contacts so she has more to watch.'
              : 'Switch back to Everything to see the rest of your stream.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(item => (
            <StreamItem
              key={item.id}
              item={item}
              userId={user?.id}
              profile={profile}
              onboarding={onboarding}
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

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
import { dailySetLines, queueLine } from '../../lib/stream/dailySet'
import TopUpPanel from './TopUpPanel'
import QueuePanel from './QueuePanel'
import EmailSyncBanner from './EmailSyncBanner'
import OutreachReadout from './OutreachReadout'
import { getEmailStatus } from '../../lib/email/emailApi'

// 2026-09-05, later: the list got a bottom to it.
//
// Until now this page showed eight backlog leads and refilled itself from a
// pool of ~600 eligible contacts the moment one was worked. Nothing was ever
// finished, because the list was never shorter than it started. What is on
// screen now is a DAY: a set chosen once in the morning, worked down, and then
// a plain statement that it is done — no top-up, no encouragement, no score.
// Everything not in today's set is deferred rather than hidden, counted in the
// open ("612 more in your network") and readable in full in the queue.
// See lib/stream/dailySet.js for how the set is kept stable through a day.
//
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
  const { items, daily, queue, counts, credits, loading, error, onboarding, contacts, setState, markDone, dismiss, markSeen, applyResolvedContact, applyContactLogged, applyContactSaved } = useStream({ user })
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
    // The day's work: what was chosen this morning and is still open, with
    // anything the recruiter is working on top of it. Everything else exists,
    // is counted, and is one click away in the queue — it is simply not today.
    return daily.today
  }, [items, view, daily.today])

  const asideCount = (key) => (key === 'working' ? counts.working : counts.parked)
  // Today's work, counted the same whichever view is open — switching a filter
  // must never move the number next to another filter.
  const listCount = daily.today.length

  // What the day is. Null while there is still work on the list — a day in
  // progress needs no commentary.
  const dayLines = dailySetLines({
    chosen: daily.chosen,
    size: daily.size,
    done: daily.done,
    thin: daily.thin,
    empty: daily.empty,
    working: daily.working.length,
    remaining: queue.remaining,
  })
  const behind = queueLine(queue.remaining)

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

      {/* Above the list rather than inside it, because it is true whether or
          not there are cards left today — a recruiter who has worked the whole
          feed still wants to know what came back from what they sent. */}
      <div className="mt-4 -mb-1">
        <OutreachReadout userId={user?.id} />
      </div>

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
          {/* Nothing is hidden, so the rest of the network is always reachable
              and always counted. */}
          {(queue.remaining > 0 || view === 'queue') && (
            <button
              onClick={() => setView(view === 'queue' ? 'all' : 'queue')}
              className={`text-[12.5px] font-semibold px-2.5 py-1 rounded-lg transition-colors ${
                view === 'queue' ? 'bg-navy text-gold' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              Queue {queue.remaining > 0 && `(${queue.remaining})`}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : view === 'queue' ? (
        <QueuePanel rows={queue.rows} />
      ) : view !== 'all' && visible.length === 0 ? (
        <div className="card p-12 text-center">
          <h3 className="font-bold text-navy mb-1">
            {view === 'parked' ? 'Nothing parked' : 'Nothing in progress'}
          </h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">Close this to go back to your list.</p>
        </div>
      ) : view === 'all' && visible.length === 0 && contacts.length === 0 ? (
        // No CRM at all. Nothing to do with the day's set — Annie has no
        // network to watch yet, and says so rather than pretending to a day.
        <div className="card p-12 text-center">
          <h3 className="font-bold text-navy mb-1">No one to call yet</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">
            Annie watches the companies and people you already know. Import your LinkedIn contacts and she has a network to watch — until then there is nothing she can honestly recommend.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <EmailSyncBanner userId={user?.id} />

          {/* An honest short day, said before the list rather than after it:
              three leads with no explanation reads as a bug. */}
          {view === 'all' && dayLines && !daily.done && (
            <div className="card px-5 py-4">
              <h3 className="font-bold text-navy">{dayLines.heading}</h3>
              <p className="text-gray-600 text-[13.5px] mt-1 max-w-[70ch] leading-relaxed">{dayLines.detail}</p>
            </div>
          )}

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

          {/* THE END OF THE DAY. It states a fact and stops: no encouragement,
              no score, and above all no top-up to keep the list looking full.
              The refill is the behaviour this whole release removes. */}
          {view === 'all' && daily.done && dayLines && (
            <div className="card px-5 py-6 border-t-2 border-t-gold">
              <h3 className="font-bold text-navy">{dayLines.heading}</h3>
              <p className="text-gray-600 text-[13.5px] mt-1 max-w-[70ch] leading-relaxed">{dayLines.detail}</p>
              {queue.remaining > 0 && (
                <button
                  onClick={() => setView('queue')}
                  className="text-[12.5px] font-bold px-3 py-1.5 mt-3 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
                >See the whole queue</button>
              )}
            </div>
          )}

          {/* While the day is still being worked: the rest of the network is
              a number the recruiter can see and open, never a hidden pool. */}
          {view === 'all' && !daily.done && behind && (
            <div className="flex items-center gap-3 flex-wrap px-1 pt-1">
              <span className="text-[12.5px] text-gray-500">{behind} The next set is tomorrow.</span>
              <button
                onClick={() => setView('queue')}
                className="text-[12.5px] font-semibold text-gold-ink border-b border-gold/40 hover:border-gold-ink"
              >See the whole queue</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

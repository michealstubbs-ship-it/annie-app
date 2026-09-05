import { describe, it, expect } from 'vitest'
import { dayKey, selectDailySet, dailySetLines, queueLine, queueRows, DAILY_SET_SIZE } from './dailySet'
import { STATE_NEW, STATE_WORKING, STATE_PARKED, buildStream } from './buildStream'
import { BACKLOG_SIGNAL_TYPE } from './backlogSignals'

const KEY = '2026-09-05'

const item = (id, state = STATE_NEW, over = {}) => ({
  id,
  state,
  signal: { id, company_name: 'ADQ', headline: `${id} happened` },
  ...over,
})

const ids = (list) => list.map(i => i.id)

describe('selectDailySet — the list at 9am is the list at 4pm', () => {
  // THE BUG THIS EXISTS FOR. The feed held eight backlog leads and refilled
  // from a pool of ~600 the moment one was worked, so the list never got
  // shorter and the day never ended. Everything below is that treadmill,
  // taken apart one property at a time.
  it('chooses a finite set out of a much larger stream', () => {
    const stream = Array.from({ length: 40 }, (_, i) => item(`s${i}`))
    const day = selectDailySet({ items: stream, key: KEY })
    expect(day.today).toHaveLength(DAILY_SET_SIZE)
    expect(day.chosen).toBe(DAILY_SET_SIZE)
    // The other 32 exist and are countable. Nothing is suppressed.
    expect(day.deferred).toHaveLength(32)
  })

  it('reads membership back from the record instead of re-choosing it', () => {
    // Scores move during a day: freshness decays, a colleague imports
    // contacts, the scan writes new signals at 11am. None of that is allowed
    // to change who is on today's list, so the choice is made once and
    // recorded, and every later render is a lookup.
    const morning = selectDailySet({ items: [item('a'), item('b'), item('c')], key: KEY, size: 2 })
    expect(morning.ids).toEqual(['a', 'b'])

    const afternoon = selectDailySet({
      // Re-ranked, and with a strong new arrival at the top.
      items: [item('new-and-hot'), item('c'), item('b'), item('a')],
      key: KEY,
      record: { key: KEY, ids: morning.ids },
      size: 2,
    })
    expect(ids(afternoon.today)).toEqual(['a', 'b'])
    expect(ids(afternoon.deferred)).toContain('new-and-hot')
  })

  it('keeps the order it recorded, so cards do not swap places under the reader', () => {
    const record = { key: KEY, ids: ['c', 'a', 'b'] }
    const day = selectDailySet({ items: [item('a'), item('b'), item('c')], key: KEY, record, size: 3 })
    expect(ids(day.today)).toEqual(['c', 'a', 'b'])
  })

  it('does not top the list back up when a lead is worked', () => {
    // The whole point. Working two of eight leaves six, not eight.
    const stream = Array.from({ length: 20 }, (_, i) => item(`s${i}`))
    const morning = selectDailySet({ items: stream, key: KEY })
    const later = selectDailySet({
      items: stream.filter(i => i.id !== 's0' && i.id !== 's1'),
      key: KEY,
      record: { key: KEY, ids: morning.ids },
    })
    expect(later.today).toHaveLength(DAILY_SET_SIZE - 2)
    expect(later.resolved).toBe(2)
    expect(later.done).toBe(false)
  })

  it('draws a new set on a new day', () => {
    const day = selectDailySet({
      items: [item('a'), item('b')],
      key: '2026-09-06',
      record: { key: KEY, ids: ['x', 'y'] },
      size: 2,
    })
    expect(day.ids).toEqual(['a', 'b'])
  })
})

describe('selectDailySet — work in progress is sacred', () => {
  it('keeps a Working item on screen even when it is not in today ' + 'set', () => {
    // Losing in-flight work is the one unforgivable bug in a feed. A lead the
    // recruiter marked Working yesterday is on screen today whatever the
    // day's set says.
    const day = selectDailySet({
      items: [item('yesterday', STATE_WORKING), item('a'), item('b')],
      key: KEY,
      record: { key: KEY, ids: ['a'] },
      size: 1,
    })
    expect(ids(day.today)).toEqual(['yesterday', 'a'])
  })

  it('puts work in progress first', () => {
    const day = selectDailySet({
      items: [item('a'), item('inflight', STATE_WORKING)],
      key: KEY,
      record: { key: KEY, ids: ['a', 'inflight'] },
    })
    expect(ids(day.today)[0]).toBe('inflight')
  })

  it('shows a set member marked Working once, not twice', () => {
    const day = selectDailySet({
      items: [item('a', STATE_WORKING), item('b')],
      key: KEY,
      record: { key: KEY, ids: ['a', 'b'] },
    })
    expect(ids(day.today)).toEqual(['a', 'b'])
  })

  it('does not call the day done while something is still being worked', () => {
    const day = selectDailySet({
      items: [item('a', STATE_WORKING)],
      key: KEY,
      record: { key: KEY, ids: ['a'] },
    })
    expect(day.done).toBe(false)
  })

  it('never chooses a parked lead into a new day', () => {
    // Parked means the recruiter said not now. Handing it back to them
    // tomorrow morning as today's work would overrule that.
    const day = selectDailySet({ items: [item('parked', STATE_PARKED), item('a')], key: KEY, size: 2 })
    expect(day.ids).toEqual(['a'])
  })
})

describe('selectDailySet — a day that ends', () => {
  it('is done when every lead on it is worked, parked or dismissed', () => {
    const day = selectDailySet({
      // 'gone' was marked done or dismissed, so it is no longer in the stream.
      items: [item('parked', STATE_PARKED)],
      key: KEY,
      record: { key: KEY, ids: ['gone', 'parked'] },
    })
    expect(day.done).toBe(true)
    expect(day.today).toHaveLength(0)
    expect(day.resolved).toBe(2)
  })

  it('does not replace a lead that left the stream', () => {
    const day = selectDailySet({
      items: [item('a'), item('spare-1'), item('spare-2')],
      key: KEY,
      record: { key: KEY, ids: ['a', 'gone'] },
    })
    expect(ids(day.today)).toEqual(['a'])
    expect(ids(day.deferred)).toEqual(['spare-1', 'spare-2'])
  })

  it('treats an empty set as an empty day, not a finished one', () => {
    // "That is today's list" said to someone who was never given one is a lie
    // told by a state machine.
    const day = selectDailySet({ items: [], key: KEY })
    expect(day.done).toBe(false)
    expect(day.empty).toBe(true)
  })

  it('reports a short day as short rather than padding it', () => {
    const day = selectDailySet({ items: [item('a'), item('b'), item('c')], key: KEY })
    expect(day.thin).toBe(true)
    expect(day.today).toHaveLength(3)
  })
})

describe('dailySetLines — what the feed says, exactly', () => {
  // COPY RULE, Michael 2026-09-05: no recruiter-marketing language, nothing
  // motivational or gamified. He rejected "bench", "new seat", "budget and
  // something to prove" and "the warmest call in recruitment" as things
  // nobody says. A completion state states a fact and stops.
  it('says nothing at all while the day is still being worked', () => {
    expect(dailySetLines({ chosen: 8, done: false, thin: false })).toBeNull()
  })

  it('states the end of the day as a fact', () => {
    const lines = dailySetLines({ chosen: 8, done: true, remaining: 612 })
    expect(lines.heading).toBe('That is today\'s list.')
    expect(lines.detail).toBe('All 8 are worked, parked or dismissed. 612 more in your network. The next set is tomorrow.')
  })

  it('says so when the queue behind the day is empty too', () => {
    const lines = dailySetLines({ chosen: 4, done: true, remaining: 0 })
    expect(lines.detail).toBe('All 4 are worked, parked or dismissed. The queue behind it is empty too. New names appear when your contacts change or something moves at a company you know.')
  })

  it('mentions work still in progress rather than claiming everything is finished', () => {
    const lines = dailySetLines({ chosen: 8, done: true, remaining: 12, working: 2 })
    expect(lines.detail).toContain('Two are still marked Working above.')
  })

  it('explains a thin day instead of padding it to eight', () => {
    // Honest about a thin network: three leads and the reason, never three
    // leads plus five weaker ones to make the page look full.
    const lines = dailySetLines({ chosen: 3, size: 8, thin: true, remaining: 0 })
    expect(lines.heading).toBe('Three today, not eight.')
    expect(lines.detail).toBe('That is everyone in your network who is senior enough, works in a sector you chose and has not been contacted yet. Weaker names are not added to make up the number.')
  })

  it('counts the rest of the network out loud', () => {
    expect(queueLine(612)).toBe('612 more in your network.')
    expect(queueLine(1)).toBe('1 more in your network.')
    expect(queueLine(0)).toBeNull()
  })

  it('uses none of the language Michael has already rejected', () => {
    const all = [
      dailySetLines({ chosen: 8, done: true, remaining: 612, working: 2 }),
      dailySetLines({ chosen: 3, size: 8, thin: true, remaining: 0 }),
      dailySetLines({ chosen: 3, size: 8, thin: true, remaining: 40 }),
      dailySetLines({ chosen: 0, empty: true, remaining: 0 }),
      dailySetLines({ chosen: 0, empty: true, remaining: 5 }),
      dailySetLines({ chosen: 1, done: true, remaining: 0 }),
    ].flatMap(l => [l.heading, l.detail]).concat(queueLine(612))

    const banned = /\b(bench|new seat|something to prove|warmest call|streak|well done|great job|congratulat|nice work|keep it up|crush|smash)\b/i
    for (const line of all) {
      expect(line, line).not.toMatch(banned)
      // No exclamation marks anywhere: the tell of a product congratulating
      // someone for using it.
      expect(line, line).not.toContain('!')
    }
  })
})

describe('queueRows — the rest of the network, visible', () => {
  it('lists deferred leads before the unbuilt backlog, because the scales differ', () => {
    // A stream item is scored on route in, event type and freshness; a backlog
    // entry on seniority, account depth and connection recency. Sorting one
    // list by two rulers would put names in an order nothing could explain.
    const rows = queueRows({
      deferred: [{ id: 's1', signal: { company_name: 'ADQ', headline: 'Raised a round' } }],
      backlog: [{ contact: { id: 'c1', name: 'Mohamed Kaissi', title: 'CFO', company: 'ADQ' } }],
    })
    expect(rows.map(r => r.key)).toEqual(['s1', 'backlog:c1'])
    expect(rows[1]).toMatchObject({ name: 'Mohamed Kaissi', detail: 'CFO · ADQ' })
  })

  it('names the person when the card is about one', () => {
    const rows = queueRows({
      deferred: [{ id: 's1', person: { name: 'Johan Nilerud', title: 'CTO' }, signal: { company_name: 'Khazna Data Centers' } }],
    })
    expect(rows[0]).toMatchObject({ name: 'Johan Nilerud', detail: 'CTO · Khazna Data Centers' })
  })
})

describe('dayKey', () => {
  it('turns over with the recruiter local day, not UTC', () => {
    // A UTC boundary lands at 4am in the Gulf, and would let a 4pm reload in
    // London redraw the list of someone in Dubai halfway through it.
    const nyeEvening = new Date(2026, 11, 31, 23, 30)
    expect(dayKey(nyeEvening)).toBe('2026-12-31')
    expect(dayKey(new Date(2026, 0, 5, 0, 5))).toBe('2026-01-05')
  })
})

describe('the day, over the real stream', () => {
  const contact = (over = {}) => ({
    id: over.id || Math.random().toString(36).slice(2),
    name: 'A Person',
    company: over.company || 'ADQ',
    title: 'Chief Strategy Officer',
    seniority_band: 'c_suite',
    function_area: 'Strategy & Corporate Development',
    is_competitor: false,
    last_contacted: null,
    created_at: '2026-08-01T00:00:00Z',
    ...over,
  })

  it('draws a set out of a CRM far bigger than a day', () => {
    // The measured account: 753 contacts, 600 of them senior and none ever
    // contacted. The feed shows a day of them and can count the rest.
    const contacts = Array.from({ length: 60 }, (_, i) => contact({ id: `c${i}`, company: `Company ${i}` }))
    const items = buildStream({ signals: [], contacts, backlogLimit: 24 })
    const day = selectDailySet({ items, key: KEY })
    expect(day.today).toHaveLength(DAILY_SET_SIZE)
    expect(day.today.every(i => i.signal.signal_type === BACKLOG_SIGNAL_TYPE)).toBe(true)
  })

  it('does not lose a lead when a signal lands at its company mid-day', () => {
    // Mid-day drift, the concrete case. At 9am ADQ is a backlog card and goes
    // on today's list. At 11am the scan writes a funding signal at ADQ, the
    // two merge into one card (one company, one card) and the recorded id
    // stops existing. Following the merge is what keeps the day whole instead
    // of quietly marking that name dealt with.
    const c = contact({ id: 'c1', company: 'ADQ' })
    const morning = buildStream({ signals: [], contacts: [c] })
    const day = selectDailySet({ items: morning, key: KEY })
    expect(day.ids).toEqual(['backlog:c1'])

    const signals = [{
      id: 's1', signal_type: 'funding', company_name: 'ADQ', headline: 'Raised a round',
      status: 'new', found_at: '2026-09-05T09:00:00Z',
    }]
    const later = buildStream({ signals, contacts: [c], backlogPin: new Set(['c1']) })
    const merged = later.find(i => (i.absorbed || []).includes('backlog:c1')) || later.find(i => i.id === 'backlog:c1')
    expect(merged).toBeTruthy()

    const afternoon = selectDailySet({ items: later, key: KEY, record: { key: KEY, ids: day.ids } })
    expect(afternoon.today).toHaveLength(1)
    expect(afternoon.done).toBe(false)
  })

  it('keeps a backlog lead the recruiter is working, and marks it Working', () => {
    const c = contact({ id: 'c1' })
    const items = buildStream({ signals: [], contacts: [c], backlogWorking: new Set(['c1']) })
    const card = items.find(i => i.id === 'backlog:c1')
    expect(card.state).toBe(STATE_WORKING)
    const day = selectDailySet({ items, key: KEY, record: { key: KEY, ids: [] } })
    // Not in today's set at all, and still on screen.
    expect(ids(day.today)).toEqual(['backlog:c1'])
  })
})

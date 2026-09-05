// Data + mutations for the single stream.
//
// Replaces both useTodaysActions (621 lines, five pools, an AI copy pass and a
// candidate-pitch pass) and the old IntelligenceFeed's inline loader. The two
// surfaces read the same table and were separated only by an invisible
// contact gate; merging them is mostly deletion.
//
// Deliberately much simpler than useTodaysActions: no AI call on load. The old
// page ran an enrichment prompt and a pitch prompt across every item before it
// could render, which is why it was slow and why it burned Anthropic tokens on
// items the recruiter never opened. Copy is now generated on request, per
// item, the same way contacts are.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import { listActiveSignals, markSignalSeen, markSignalActioned, markSignalWorking, markSignalParked, markSignalOpen } from '../../lib/data/signals'
import { listBacklogWorking, markBacklogWorking, clearBacklogWorking, parkBacklogContact, unparkBacklogContact } from '../../lib/data/backlogState'
import { listCandidatesForMatching } from '../../lib/data/candidates'
import { collapseFeedDuplicates } from '../../lib/intelligenceFeedDedup'
import { buildStream, streamCounts, STATE_NEW, STATE_WORKING, STATE_PARKED } from '../../lib/stream/buildStream'
import { planFacetBackfill, runFacetBackfill } from '../../lib/backfillFacets'
import { fetchContactCredits } from '../../lib/data/contactCredits'
import { logSignalOutcome } from '../../lib/signalOutcomes'
import { fetchCompanyDomains, learnOwnPatterns, contributePatterns, fetchPooledPatterns, domainForCompany } from '../../lib/data/emailPatterns'
import { fetchOwnEmployerVerdicts, contributeEmployerVerdicts, fetchParkedEmployers } from '../../lib/data/parkedEmployers'
import { deskKeys, employerKey } from '../../lib/employerSignal'
import { cardEmail } from '../../lib/stream/cardEmail'
import { backlogQueue, isBacklogSignal } from '../../lib/stream/backlogSignals'
import { dayKey, selectDailySet, queueRows, DAILY_POOL_SIZE } from '../../lib/stream/dailySet'
import { loadDailySet, saveDailySet } from '../../lib/stream/dailySetStore'

// 'backlog:<contact uuid>' — a synthetic row, so every write about it goes to
// the contact rather than to intelligence_signals, which has no row for it.
function backlogContactId(item) {
  return isBacklogSignal(item?.signal) ? item.signal.linked_contact_id || null : null
}

// Postgres: undefined_column. Everything else in the backlog write path exists
// in every environment; backlog_working_at ships in
// 20260905200000_daily_set.sql, so until that is applied a Working click
// should quietly last until the next reload rather than raise an error banner
// over a feed that is otherwise working perfectly.
function isMissingColumn(err) {
  return err?.code === '42703'
}

export function useStream({ user }) {
  const [signals, setSignals] = useState([])
  const [contacts, setContacts] = useState([])
  const [candidates, setCandidates] = useState([])
  // Only used to give a drafted approach the recruiter's own sectors, markets
  // and writing style. Loaded once, never blocks the stream.
  const [onboarding, setOnboarding] = useState(null)
  const [credits, setCredits] = useState(null)
  const [domains, setDomains] = useState({ exact: new Map(), loose: new Map() })
  const [pooled, setPooled] = useState(new Map())
  const [parkedEmployers, setParkedEmployers] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Which backlog leads the recruiter is on, and which leads are today's.
  // Both are read once with everything else; neither may fail the load.
  const [workingBacklog, setWorkingBacklog] = useState(() => new Set())
  const [today, setToday] = useState(() => dayKey())
  const [dayRecord, setDayRecord] = useState(null)

  const load = useCallback(async () => {
    if (!user?.id) return
    setError(null)
    // Read the day once per load rather than per render: a set is drawn for
    // the day it was drawn on, and a tab left open overnight redraws when it
    // is next reloaded rather than silently mid-scroll.
    const key = dayKey()
    setToday(key)
    try {
      // Contacts and candidates are team-scoped by RLS and deliberately not
      // filtered by user_id — a colleague's contact at the target company is
      // still a way in. Signals are personal (see data/signals.js's header).
      const [signalRows, contactRes, candidateRows, onboardingRes, working, record] = await Promise.all([
        listActiveSignals(user.id),
        // The five columns after last_contacted are what the backlog ranks on.
        // Without them every contact scores zero and the backlog is silently
        // empty — a failure that looks exactly like "you have no leads".
        // created_from is what lets the card say "Imported from LinkedIn"
        // rather than the vaguer "in your contacts" — see provenance.js.
        supabase.from('contacts').select('id, name, company, title, email, linkedin_url, notes, last_contacted, seniority_band, function_area, relationship_tier, is_competitor, connected_on, backlog_parked_at, created_at, created_from').limit(1000),
        listCandidatesForMatching(user.id),
        supabase.from('onboarding').select('sectors, functions, locations, tone, writing_style').eq('user_id', user.id).maybeSingle(),
        // Both of these answer with a usable empty value rather than throwing.
        // A feed that cannot render because it could not remember which eight
        // leads it chose this morning is worse than a feed that re-chooses.
        listBacklogWorking(),
        loadDailySet({ userId: user.id, key }),
      ])
      if (contactRes.error) throw contactRes.error
      const contactRows = contactRes.data || []

      // Contacts imported before the classifier existed have null facets, and a
      // contact with no seniority_band scores zero and never reaches the
      // backlog — on the account this was built for that was all 778 rows and
      // a completely empty call list.
      //
      // planFacetBackfill computes the facets from data already in hand, so
      // `patched` is what gets rendered: the backlog is correct on this paint
      // rather than after a write returns. The write itself is
      // fire-and-forget and never throws — a failed repair must not take the
      // feed down, and it simply happens again on the next load.
      const { updates, patched } = planFacetBackfill(contactRows)

      setSignals(signalRows || [])
      setContacts(patched)
      setCandidates(candidateRows || [])
      setOnboarding(onboardingRes?.data || null)
      setWorkingBacklog(working instanceof Set ? working : new Set())
      setDayRecord(record)

      if (updates.length) {
        runFacetBackfill(supabase, contactRows)
          .then(({ written }) => console.info(`[backfillFacets] classified ${written} contact(s)`))
          .catch(() => {})
      }
    } catch (err) {
      setError(err.message || 'Could not load your stream.')
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => { load() }, [load])

  // The meter loads independently and is allowed to fail silently — the
  // stream must render whether or not it resolves.
  useEffect(() => {
    let cancelled = false
    fetchContactCredits().then(c => { if (!cancelled) setCredits(c) })
    return () => { cancelled = true }
  }, [user?.id])

  // Domains Annie already holds, from the shared company_enrichment cache.
  // Loads independently and is allowed to fail silently: without it the card
  // simply shows no address row, which is the honest state anyway.
  useEffect(() => {
    let cancelled = false
    fetchCompanyDomains().then(d => { if (!cancelled) setDomains(d) })
    return () => { cancelled = true }
  }, [user?.id])

  // What this customer's own contacts show about each organisation's email
  // format. Computed in the browser over data they already have — nothing is
  // sent anywhere to work it out.
  const ownPatterns = useMemo(() => learnOwnPatterns(contacts), [contacts])

  // Contribute those formats to the pool. A format key and a count; the RPC's
  // signature cannot carry an address or a name. Michael, 2026-09-05: "We will
  // not steal exact emails of contacts from our customers."
  useEffect(() => {
    if (ownPatterns.size) contributePatterns(ownPatterns)
  }, [ownPatterns])

  // The desks this recruiter works, from the functions they chose at signup.
  // Everything below is a no-op without one: a vote with no desk would pool a
  // finance recruiter's judgment with a construction recruiter's, which is
  // exactly how learning from other customers would make Annie NARROWER
  // instead of sharper. See employerSignal.js.
  const desks = useMemo(() => deskKeys(onboarding?.functions || []), [onboarding])

  // Which employers this customer keeps parking, from their own outcome log —
  // read under their own RLS policy, in their own browser — contributed to the
  // pool as a desk slug and two lists of company keys. That is the entire
  // payload; record_parked_employers' signature cannot carry a person.
  // Michael, 2026-09-05: "share the fact about the ORGANISATION, never the
  // record about the PERSON."
  useEffect(() => {
    if (!user?.id || !desks.length) return
    let cancelled = false
    fetchOwnEmployerVerdicts(user.id).then(verdicts => {
      if (!cancelled) contributeEmployerVerdicts(verdicts, desks)
    })
    return () => { cancelled = true }
  }, [user?.id, desks])

  const deduped = useMemo(() => collapseFeedDuplicates(signals), [signals])

  // The contacts today's set already named. Pinned into the build so a lead
  // chosen at 9am cannot be pushed out of the pool by a score that moved
  // during the day — see stream/dailySet.js.
  const backlogPin = useMemo(() => {
    const ids = new Set()
    for (const id of dayRecord?.ids || []) {
      if (typeof id === 'string' && id.startsWith('backlog:')) ids.add(id.slice('backlog:'.length))
    }
    return ids
  }, [dayRecord])

  const items = useMemo(
    // onboarding.functions is the function filter the recruiter chose at
    // signup. It has existed since onboarding shipped and was enforced nowhere
    // — FEED-6 was a regulatory/HSE card reaching a recruiter who works in
    // Strategy, Finance and Technology. Passing it here is the first place it
    // actually gates anything.
    () => buildStream({
      signals: deduped,
      contacts,
      candidates,
      functions: onboarding?.functions || [],
      // A pool, not a page. The day's set is drawn from the top of this once;
      // it is wider than a day's work so the set can still be filled after
      // same-company cards merge, and far narrower than the whole network
      // because building 600 cards costs ~2.5s on a 900-contact CRM.
      backlogLimit: DAILY_POOL_SIZE,
      backlogWorking: workingBacklog,
      backlogPin,
      // Ranking weight only — never a filter. See employerSignal.js.
      parkedEmployers,
    }),
    // onboarding is in here deliberately: it loads in the same Promise.all as
    // the signals but lands in its own state, so without it the memo keeps the
    // first-paint value and the function filter never applies.
    [deduped, contacts, candidates, onboarding, workingBacklog, backlogPin, parkedEmployers],
  )

  // The pooled verdict on the employers actually on screen. One round trip for
  // the batch, and companies the pool says nothing about come back as explicit
  // nulls — which is what stops this asking about the same silent companies on
  // every render. The stream ranks perfectly well without any of it.
  const wantedEmployers = useMemo(() => {
    const out = []
    for (const item of items) {
      const key = employerKey(item.signal.company_name)
      if (key && !parkedEmployers.has(key)) out.push(key)
    }
    return [...new Set(out)].sort().join('|')
  }, [items, parkedEmployers])

  useEffect(() => {
    if (!wantedEmployers || !desks.length) return
    let cancelled = false
    fetchParkedEmployers(wantedEmployers.split('|'), desks).then(found => {
      if (cancelled || !found.size) return
      setParkedEmployers(prev => {
        const next = new Map(prev)
        for (const [k, v] of found) next.set(k, v)
        return next
      })
    })
    return () => { cancelled = true }
  }, [wantedEmployers, desks])

  // The domains actually on screen, for cards where the customer's own
  // contacts taught us nothing. Deliberately capped and only for what is
  // visible: this is one round trip per domain, and the feed shows ten cards,
  // not six hundred.
  const wantedDomains = useMemo(() => {
    const out = []
    for (const item of items.slice(0, 25)) {
      const d = domainForCompany(item.signal.company_name, domains)
      if (d && !ownPatterns.has(d) && !pooled.has(d)) out.push(d)
    }
    return [...new Set(out)].sort().join(',')
  }, [items, domains, ownPatterns, pooled])

  useEffect(() => {
    if (!wantedDomains) return
    let cancelled = false
    fetchPooledPatterns(wantedDomains.split(',')).then(found => {
      if (cancelled || !found.size) return
      setPooled(prev => {
        const next = new Map(prev)
        for (const [k, v] of found) next.set(k, v)
        return next
      })
    })
    return () => { cancelled = true }
  }, [wantedDomains])

  // The address row. A real address if there is one, otherwise a construction
  // that is always labelled a guess and says where it came from.
  const withEmail = useMemo(() => items.map(item => {
    const person = item.wayIn?.person || null
    const domain = domainForCompany(item.signal.company_name, domains)
    const pattern = (domain && (ownPatterns.get(domain) || pooled.get(domain))) || null
    return { ...item, email: cardEmail({ item, person, domain, pattern }) }
  }), [items, domains, ownPatterns, pooled])

  const counts = useMemo(() => streamCounts(withEmail), [withEmail])

  // TODAY'S SET. Chosen once, recorded, and read back for the rest of the day.
  const daily = useMemo(
    () => selectDailySet({ items: withEmail, key: today, record: dayRecord }),
    [withEmail, today, dayRecord],
  )

  // Write the day's set the first time it is drawn, and only then: the guard
  // is what stops this from re-recording a shorter list every time a lead is
  // worked, which would quietly turn the record back into a treadmill.
  useEffect(() => {
    if (loading || !user?.id || !daily.ids.length) return
    if (dayRecord?.key === today && dayRecord.ids.join(',') === daily.ids.join(',')) return
    const record = { key: today, ids: daily.ids }
    setDayRecord(record)
    saveDailySet({ userId: user.id, record })
  }, [loading, user?.id, today, dayRecord, daily.ids])

  // Everyone the day did not reach. Counted from the same eligibility rule the
  // feed itself uses, so the number cannot describe a population the list
  // could never show — see backlogSignals.eligibleBacklogContacts.
  const queue = useMemo(() => {
    const shown = new Set()
    for (const item of withEmail) {
      if (item.signal?.linked_contact_id) shown.add(item.signal.linked_contact_id)
      if (item.person?.id) shown.add(item.person.id)
    }
    const entries = backlogQueue({
      contacts,
      signals: deduped,
      functions: onboarding?.functions || [],
      exclude: shown,
    })
    return {
      rows: queueRows({ deferred: daily.deferred, backlog: entries }),
      remaining: daily.deferred.length + entries.length,
    }
  }, [withEmail, contacts, deduped, onboarding, daily.deferred])

  // Every mutation updates local state first so the stream never jumps or
  // reloads under the recruiter mid-read.
  const patchSignal = useCallback((id, patch) => {
    setSignals(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)))
  }, [])

  const patchContact = useCallback((id, patch) => {
    setContacts(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)))
  }, [])

  const forgetWorking = useCallback((contactId) => {
    setWorkingBacklog(prev => {
      if (!prev.has(contactId)) return prev
      const next = new Set(prev)
      next.delete(contactId)
      return next
    })
  }, [])

  // The same three states, for a lead that has no row of its own. Working goes
  // on the contact so it survives a reload; Park writes the column the
  // network-first release already added for exactly this.
  const setBacklogState = useCallback(async (contactId, next) => {
    if (next === STATE_WORKING) {
      setWorkingBacklog(prev => new Set(prev).add(contactId))
      const { error: err } = await markBacklogWorking(contactId)
      if (err && !isMissingColumn(err)) {
        forgetWorking(contactId)
        setError('Could not save that — your change was undone.')
      }
      return
    }

    if (next === STATE_PARKED) {
      const at = new Date().toISOString()
      patchContact(contactId, { backlog_parked_at: at })
      const { error: err } = await parkBacklogContact(contactId)
      if (err) {
        patchContact(contactId, { backlog_parked_at: null })
        setError('Could not save that — your change was undone.')
        return
      }
      forgetWorking(contactId)
      // Best effort, and deliberately not undone on failure: the lead is
      // parked either way, and a leftover flag on a parked contact changes
      // nothing — parked is checked first when the lead is built.
      await clearBacklogWorking(contactId)
      return
    }

    forgetWorking(contactId)
    patchContact(contactId, { backlog_parked_at: null })
    await clearBacklogWorking(contactId)
    const { error: err } = await unparkBacklogContact(contactId)
    if (err) setError('Could not save that — your change was undone.')
  }, [forgetWorking, patchContact])

  const setState = useCallback(async (item, next) => {
    const contactId = backlogContactId(item)
    if (contactId) return setBacklogState(contactId, next)
    const id = item.id
    const previous = item.signal.status
    const statusFor = { [STATE_WORKING]: 'working', [STATE_PARKED]: 'parked', [STATE_NEW]: 'seen' }
    patchSignal(id, { status: statusFor[next] })
    const fn = next === STATE_WORKING ? markSignalWorking : next === STATE_PARKED ? markSignalParked : markSignalOpen
    const { error: err } = await fn(id)
    if (err) {
      patchSignal(id, { status: previous })
      setError('Could not save that — your change was undone.')
      return
    }
    // Parking is the judgment "not this company, not now", and until now it
    // was the one judgment in the stream that left no trace at all — the
    // outcome log recorded seen, worked and dismissed and never this. It is
    // the evidence the pooled employer weight is built from, so it has to be
    // written down. Logged only on a park, not on un-parking or on starting
    // work, because those are not that judgment.
    //
    // logSignalOutcome itself skips synthetic 'backlog:<uuid>' ids — its
    // signal_id is a uuid foreign key into intelligence_signals, so those
    // inserts could only ever fail silently.
    if (next === STATE_PARKED) logSignalOutcome(user, item.signal, 'parked')
  }, [patchSignal, setBacklogState, user])

  // Finishing with a backlog lead. Done and dismissed land in the same place
  // for the same reason they do in backlogState.js: both mean "not from this
  // list any more", and neither is allowed to claim a conversation happened —
  // logging a note is what sets last_contacted, and it always was.
  //
  // signal_outcomes is skipped for these on purpose: its signal_id is a uuid
  // foreign key into intelligence_signals, and 'backlog:<uuid>' is not a row
  // there. Every one of these inserts has been failing silently.
  const finishBacklog = useCallback(async (contactId, message) => {
    const at = new Date().toISOString()
    patchContact(contactId, { backlog_parked_at: at })
    forgetWorking(contactId)
    const { error: err } = await parkBacklogContact(contactId)
    if (err) {
      patchContact(contactId, { backlog_parked_at: null })
      setError(message)
      load()
    }
  }, [patchContact, forgetWorking, load])

  const markDone = useCallback(async (item) => {
    const contactId = backlogContactId(item)
    if (contactId) return finishBacklog(contactId, 'Could not mark that done — reloading.')
    const id = item.id
    setSignals(prev => prev.filter(s => s.id !== id))
    const { error: err } = await markSignalActioned(id)
    if (err) {
      setError('Could not mark that done — reloading.')
      load()
      return
    }
    logSignalOutcome(user, item.signal, 'worked')
  }, [load, user, finishBacklog])

  const dismiss = useCallback(async (item) => {
    const contactId = backlogContactId(item)
    if (contactId) return finishBacklog(contactId, 'Could not dismiss that — reloading.')
    const id = item.id
    setSignals(prev => prev.filter(s => s.id !== id))
    const { error: err } = await markSignalActioned(id)
    if (err) {
      setError('Could not dismiss that — reloading.')
      load()
      return
    }
    logSignalOutcome(user, item.signal, 'dismissed')
  }, [load, user, finishBacklog])

  const markSeen = useCallback((item) => {
    if (item.signal.status !== 'new') return
    // Nothing to mark seen on a synthetic row, and the write would target an
    // id that exists in no table.
    if (isBacklogSignal(item.signal)) return
    patchSignal(item.id, { status: 'seen' })
    markSignalSeen(item.id)
    logSignalOutcome(user, item.signal, 'seen')
  }, [patchSignal, user])

  // Called by the card once a contact lookup comes back, so the resolved
  // person and the new credit total land in the same render.
  const applyResolvedContact = useCallback((id, result) => {
    if (result?.contact) {
      patchSignal(id, {
        contact_name: result.contact.name,
        contact_title: result.contact.title,
        contact_linkedin_url: result.contact.linkedin_url,
        contact_email: result.contact.email,
        contact_verified: true,
      })
    }
    if (result?.contactCandidates) patchSignal(id, { contact_candidates: result.contactCandidates })
    if (result?.credits && Number.isFinite(result.credits.limit)) setCredits(result.credits)
  }, [patchSignal])

  // A note just logged against a contact. Patching contacts locally is what
  // moves the card from "In CRM" to "Spoken to" immediately — the whole point
  // of putting the note field on the card in the first place.
  const applyContactLogged = useCallback((contactId, patch) => {
    setContacts(prev => prev.map(c => (c.id === contactId ? { ...c, ...patch } : c)))
  }, [])

  // A contact just saved from a resolved Apollo lookup. Adding it locally means
  // every other card at that company drops from cold to a real rung without a
  // reload — and without spending the credit again.
  const applyContactSaved = useCallback((contact) => {
    if (!contact?.id) return
    setContacts(prev => (prev.some(c => c.id === contact.id) ? prev : [...prev, contact]))
  }, [])

  return { items: withEmail, daily, queue, counts, credits, loading, error, setError, onboarding, contacts, refresh: load, setState, markDone, dismiss, markSeen, applyResolvedContact, applyContactLogged, applyContactSaved }
}

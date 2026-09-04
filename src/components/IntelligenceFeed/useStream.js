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
import { listCandidatesForMatching } from '../../lib/data/candidates'
import { collapseFeedDuplicates } from '../../lib/intelligenceFeedDedup'
import { buildStream, streamCounts, STATE_NEW, STATE_WORKING, STATE_PARKED } from '../../lib/stream/buildStream'
import { fetchContactCredits } from '../../lib/data/contactCredits'
import { logSignalOutcome } from '../../lib/signalOutcomes'

export function useStream({ user }) {
  const [signals, setSignals] = useState([])
  const [contacts, setContacts] = useState([])
  const [candidates, setCandidates] = useState([])
  const [credits, setCredits] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!user?.id) return
    setError(null)
    try {
      // Contacts and candidates are team-scoped by RLS and deliberately not
      // filtered by user_id — a colleague's contact at the target company is
      // still a way in. Signals are personal (see data/signals.js's header).
      const [signalRows, contactRes, candidateRows] = await Promise.all([
        listActiveSignals(user.id),
        supabase.from('contacts').select('id, name, company, title, email, linkedin_url, notes, last_contacted').limit(1000),
        listCandidatesForMatching(user.id),
      ])
      if (contactRes.error) throw contactRes.error
      setSignals(signalRows || [])
      setContacts(contactRes.data || [])
      setCandidates(candidateRows || [])
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

  const deduped = useMemo(() => collapseFeedDuplicates(signals), [signals])
  const items = useMemo(
    () => buildStream({ signals: deduped, contacts, candidates }),
    [deduped, contacts, candidates],
  )
  const counts = useMemo(() => streamCounts(items), [items])

  // Every mutation updates local state first so the stream never jumps or
  // reloads under the recruiter mid-read.
  const patchSignal = useCallback((id, patch) => {
    setSignals(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)))
  }, [])

  const setState = useCallback(async (item, next) => {
    const id = item.id
    const previous = item.signal.status
    const statusFor = { [STATE_WORKING]: 'working', [STATE_PARKED]: 'parked', [STATE_NEW]: 'seen' }
    patchSignal(id, { status: statusFor[next] })
    const fn = next === STATE_WORKING ? markSignalWorking : next === STATE_PARKED ? markSignalParked : markSignalOpen
    const { error: err } = await fn(id)
    if (err) {
      patchSignal(id, { status: previous })
      setError('Could not save that — your change was undone.')
    }
  }, [patchSignal])

  const markDone = useCallback(async (item) => {
    const id = item.id
    setSignals(prev => prev.filter(s => s.id !== id))
    const { error: err } = await markSignalActioned(id)
    if (err) {
      setError('Could not mark that done — reloading.')
      load()
      return
    }
    logSignalOutcome(user, item.signal, 'worked')
  }, [load, user])

  const dismiss = useCallback(async (item) => {
    const id = item.id
    setSignals(prev => prev.filter(s => s.id !== id))
    const { error: err } = await markSignalActioned(id)
    if (err) {
      setError('Could not dismiss that — reloading.')
      load()
      return
    }
    logSignalOutcome(user, item.signal, 'dismissed')
  }, [load, user])

  const markSeen = useCallback((item) => {
    if (item.signal.status !== 'new') return
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

  return { items, counts, credits, loading, error, setError, refresh: load, setState, markDone, dismiss, markSeen, applyResolvedContact }
}

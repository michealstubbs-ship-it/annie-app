// Regression tests for Today's Actions' deterministic scoring, the audit's
// M2 finding: unactioned "sourced" signals asymptote to a score floor above
// the inclusion threshold and never age out on their own. These tests pin
// today's actual behaviour and give the eventual age-cutoff fix something
// concrete to change.
import { describe, it, expect } from 'vitest'
import {
  buildDormantPool, buildRelationshipPool, buildSourcedPool, buildNewClientPool, selectDailyItems,
  BD_ACTION_SIGNAL_TYPES, actionKey, mergeActions,
} from './actionsEngine.js'

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe('buildDormantPool', () => {
  it('excludes contacts contacted recently', () => {
    const contacts = [{ id: 1, status: 'warm', last_contacted: daysAgoIso(5) }]
    expect(buildDormantPool(contacts)).toEqual([])
  })

  it('includes a contact silent well past the dormant threshold', () => {
    const contacts = [{ id: 1, status: 'warm', company: 'Acme', last_contacted: daysAgoIso(90) }]
    const pool = buildDormantPool(contacts)
    expect(pool).toHaveLength(1)
    expect(pool[0].score).toBeGreaterThan(0)
  })

  it('excludes client and inactive statuses regardless of staleness', () => {
    const contacts = [
      { id: 1, status: 'client', last_contacted: daysAgoIso(400) },
      { id: 2, status: 'inactive', last_contacted: daysAgoIso(400) },
    ]
    expect(buildDormantPool(contacts)).toEqual([])
  })
})

describe('buildRelationshipPool', () => {
  const contacts = [{ id: 1, company: 'Acme Ltd', status: 'warm' }]

  it('only includes signals about companies already in the contact list', () => {
    const signals = [{ id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(1) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it('excludes signals older than the freshness window even for a known company', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', found_at: daysAgoIso(30) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it('includes a fresh signal about a known company', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'funding', found_at: daysAgoIso(1) }]
    const pool = buildRelationshipPool(signals, contacts)
    expect(pool).toHaveLength(1)
    expect(pool[0].contact).toEqual(contacts[0])
  })

  it('excludes signals already marked actioned', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'actioned', found_at: daysAgoIso(1) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it('gives a leadership_change signal a wider freshness window (60 days) than the ordinary 14-day one', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'leadership_change', found_at: daysAgoIso(30) }]
    const pool = buildRelationshipPool(signals, contacts)
    expect(pool).toHaveLength(1)
    expect(pool[0].urgency).toBe(2)
  })

  it('still excludes a leadership_change signal well past even its own wider window', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'leadership_change', found_at: daysAgoIso(90) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it('a manually-added signal clears the freshness window even when otherwise too old — the recruiter already chose to pursue it from the Feed', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'funding', found_at: daysAgoIso(90), manually_added_at: daysAgoIso(0) }]
    const pool = buildRelationshipPool(signals, contacts)
    expect(pool).toHaveLength(1)
  })

  it('excludes a regulatory signal even when fresh and about a known company — market intel only, never a BD trigger', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'regulatory', found_at: daysAgoIso(1) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it('excludes a regulatory signal even when manually added — the Feed button cannot override this exclusion', () => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type: 'regulatory', found_at: daysAgoIso(1), manually_added_at: daysAgoIso(0) }]
    expect(buildRelationshipPool(signals, contacts)).toEqual([])
  })

  it.each(['m_and_a', 'hiring_activity', 'public_commentary', 'team_building', 'job_posting_unclaimed'])(
    'excludes a fresh %s signal about a known company — only the whitelisted BD types belong here',
    (signal_type) => {
      const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type, found_at: daysAgoIso(1) }]
      expect(buildRelationshipPool(signals, contacts)).toEqual([])
    }
  )

  it.each(['m_and_a', 'hiring_activity', 'public_commentary'])(
    'excludes a %s signal even when manually added — the whitelist cannot be overridden from the Feed',
    (signal_type) => {
      const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type, found_at: daysAgoIso(1), manually_added_at: daysAgoIso(0) }]
      expect(buildRelationshipPool(signals, contacts)).toEqual([])
    }
  )

  it.each(BD_ACTION_SIGNAL_TYPES)('includes a fresh %s signal about a known company — the whitelisted types all surface here', (signal_type) => {
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', signal_type, found_at: daysAgoIso(1) }]
    expect(buildRelationshipPool(signals, contacts)).toHaveLength(1)
  })
})

describe('buildSourcedPool — the M2 "never ages out" fix', () => {
  it('excludes a signal past SOURCED_MAX_AGE_DAYS entirely, rather than letting it score forever', () => {
    // This used to pin the audit's exact finding: score decayed toward an
    // additive floor (25, or 40 if contact-verified) rather than toward
    // zero, so a very old signal never naturally dropped below the 20-point
    // inclusion bar — it just sat there competing for a slot forever. Now
    // it's excluded outright once it's older than the cutoff.
    const veryOldSignal = [{ id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(400), contact_verified: false, signal_type: 'funding' }]
    expect(buildSourcedPool(veryOldSignal, [])).toEqual([])
  })

  it('a manually-added signal clears the age cutoff even when otherwise past SOURCED_MAX_AGE_DAYS — "Add to Today\'s BD Actions" from the Feed always sticks, no dependency on cache timing', () => {
    const veryOldButChosen = [{ id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(400), contact_verified: false, contact_candidates: [{ name: 'Jane Doe' }], signal_type: 'funding', manually_added_at: daysAgoIso(0) }]
    const pool = buildSourcedPool(veryOldButChosen, [])
    expect(pool).toHaveLength(1)
  })

  it('excludes a regulatory signal about a brand-new company even when fresh — market intel only, never a BD trigger', () => {
    const signals = [{ id: 's1', company_name: 'Unknown Co', status: 'new', signal_type: 'regulatory', found_at: daysAgoIso(1), contact_verified: false }]
    expect(buildSourcedPool(signals, [])).toEqual([])
  })

  it('excludes a regulatory signal even when manually added — the Feed button cannot override this exclusion', () => {
    const signals = [{ id: 's1', company_name: 'Unknown Co', status: 'new', signal_type: 'regulatory', found_at: daysAgoIso(1), contact_verified: false, manually_added_at: daysAgoIso(0) }]
    expect(buildSourcedPool(signals, [])).toEqual([])
  })

  it.each(['m_and_a', 'hiring_activity', 'public_commentary', 'team_building', 'job_posting_unclaimed'])(
    'excludes a fresh %s signal about a brand-new company — only the whitelisted BD types belong here',
    (signal_type) => {
      const signals = [{ id: 's1', company_name: 'Unknown Co', status: 'new', signal_type, found_at: daysAgoIso(1), contact_verified: false }]
      expect(buildSourcedPool(signals, [])).toEqual([])
    }
  )

  it.each(['m_and_a', 'hiring_activity', 'public_commentary'])(
    'excludes a %s signal even when manually added — the whitelist cannot be overridden from the Feed',
    (signal_type) => {
      const signals = [{ id: 's1', company_name: 'Unknown Co', status: 'new', signal_type, found_at: daysAgoIso(1), contact_verified: false, manually_added_at: daysAgoIso(0) }]
      expect(buildSourcedPool(signals, [])).toEqual([])
    }
  )

  it('still includes a genuinely fresh signal', () => {
    const freshSignal = [{ id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(2), contact_verified: false, contact_candidates: [{ name: 'Jane Doe' }], signal_type: 'funding' }]
    const pool = buildSourcedPool(freshSignal, [])
    expect(pool).toHaveLength(1)
    expect(pool[0].score).toBeGreaterThanOrEqual(20)
  })

  it('excludes signals about companies already in the contact list (belongs to relationship pool instead)', () => {
    const contacts = [{ id: 1, company: 'Acme Ltd' }]
    const signals = [{ id: 's1', company_name: 'Acme Ltd', status: 'new', found_at: daysAgoIso(1) }]
    expect(buildSourcedPool(signals, contacts)).toEqual([])
  })

  it('a contact-verified signal scores higher than an otherwise-identical unverified one (both carrying a contact candidate, so the contact-requirement filter isn\'t what\'s being measured here)', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(1), signal_type: 'funding', contact_candidates: [{ name: 'Jane Doe' }] }
    const [unverified] = buildSourcedPool([{ ...base, contact_verified: false }], [])
    const [verified] = buildSourcedPool([{ ...base, contact_verified: true }], [])
    expect(verified.score).toBeGreaterThan(unverified.score)
  })

  it('a live_job entry scores higher than an otherwise-identical generic signal — a specific real open role is the strongest lead this pool surfaces', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(1), contact_verified: false, contact_candidates: [{ name: 'Jane Doe' }] }
    const [generic] = buildSourcedPool([{ ...base, signal_type: 'funding' }], [])
    const [liveJob] = buildSourcedPool([{ ...base, signal_type: 'live_job' }], [])
    expect(liveJob.score).toBeGreaterThan(generic.score)
  })

  it('a live_job entry still counts as urgent up to 7 days old, wider than the 3-day window an ordinary racy signal gets — a real open req stays live longer than a news mention', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', signal_type: 'live_job', contact_verified: false, contact_candidates: [{ name: 'Jane Doe' }] }
    const [recent] = buildSourcedPool([{ ...base, found_at: daysAgoIso(6) }], [])
    expect(recent.urgency).toBe(2)
  })

  it('an ordinary racy signal (expansion) drops to urgency 1 past 3 days, unlike live_job', () => {
    // hiring_activity used to be the example racy type here, but it's no
    // longer whitelisted for Today's BD Actions at all (see
    // BD_ACTION_SIGNAL_TYPES) — expansion is racy and still whitelisted, so
    // it's the one that actually exercises this scoring path today.
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', signal_type: 'expansion', contact_verified: false, contact_candidates: [{ name: 'Jane Doe' }] }
    const [older] = buildSourcedPool([{ ...base, found_at: daysAgoIso(6) }], [])
    expect(older.urgency).toBe(1)
  })

  it('a leadership_change entry scores higher than an otherwise-identical generic signal — a new leader is a high-value opportunity', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', found_at: daysAgoIso(1), contact_verified: false, contact_candidates: [{ name: 'Jane Doe' }] }
    const [generic] = buildSourcedPool([{ ...base, signal_type: 'funding' }], [])
    const [leadership] = buildSourcedPool([{ ...base, signal_type: 'leadership_change' }], [])
    expect(leadership.score).toBeGreaterThan(generic.score)
  })

  it('a leadership_change entry stays urgency 2 well past the 3-7 day window ordinary signals get, up to 60 days', () => {
    const base = { id: 's1', company_name: 'Unknown Co', status: 'new', signal_type: 'leadership_change', contact_verified: false, contact_candidates: [{ name: 'Jane Doe' }] }
    const [fresh] = buildSourcedPool([{ ...base, found_at: daysAgoIso(1) }], [])
    const [older] = buildSourcedPool([{ ...base, found_at: daysAgoIso(45) }], [])
    expect(fresh.urgency).toBe(2)
    expect(older.urgency).toBe(2)
  })
})

describe('buildSourcedPool — a BD action always has someone real to approach (2026-08-23)', () => {
  // The exact regression this guards: a DP World leadership-change card
  // reached Today's BD Actions with neither contact_verified nor any
  // contact_candidates — "no verified contact found yet, approach by role"
  // — and still rendered a headline, a candidate pitch, and a "lead with
  // this" prompt as if it were an actionable task for today. Fixing only
  // the card's own message panel wasn't enough; a card with nobody to
  // approach shouldn't reach the list at all.
  const base = { id: 's1', company_name: 'DP World', status: 'new', found_at: daysAgoIso(1), signal_type: 'leadership_change' }

  it('excludes a signal with no verified contact and no contact candidates', () => {
    expect(buildSourcedPool([{ ...base, contact_verified: false, contact_candidates: [] }], [])).toEqual([])
  })

  it('excludes a signal where contact_candidates is missing entirely, not just empty', () => {
    expect(buildSourcedPool([{ ...base, contact_verified: false }], [])).toEqual([])
  })

  it('includes a signal with a single verified contact, even with no candidate panel', () => {
    const pool = buildSourcedPool([{ ...base, contact_verified: true, contact_candidates: [] }], [])
    expect(pool).toHaveLength(1)
  })

  it('includes a signal with at least one contact candidate, even when not itself contact_verified', () => {
    const pool = buildSourcedPool([{ ...base, contact_verified: false, contact_candidates: [{ name: 'Jane Doe', function: 'commercial' }] }], [])
    expect(pool).toHaveLength(1)
  })

  it('still excludes a contact-less signal even when manually added — same no-bypass rule as the signal-type whitelist', () => {
    const signals = [{ ...base, contact_verified: false, contact_candidates: [], manually_added_at: daysAgoIso(0) }]
    expect(buildSourcedPool(signals, [])).toEqual([])
  })
})

describe('buildNewClientPool', () => {
  it('excludes a hot/warm contact that already has an active deal', () => {
    const contacts = [{ id: 1, status: 'hot', company: 'Acme Ltd' }]
    const deals = [{ company: 'Acme Ltd', stage: 'approached' }]
    expect(buildNewClientPool(contacts, deals)).toEqual([])
  })

  it('includes a hot contact with no active deal', () => {
    const contacts = [{ id: 1, status: 'hot', company: 'Acme Ltd', last_contacted: daysAgoIso(1) }]
    expect(buildNewClientPool(contacts, [])).toHaveLength(1)
  })
})

describe('mergeActions', () => {
  it('keeps a cached signal-backed item whose signal is still active, untouched, rather than replacing it', () => {
    const cached = [{ signalId: 's1', category: 'sourced', headline: 'Old headline', urgency: 1, score: 40 }]
    const fresh = []
    const merged = mergeActions(cached, fresh, { signalIds: new Set(['s1']) }, [])
    expect(merged).toEqual(cached)
  })

  it('drops a cached signal-backed item whose signal is no longer active (actioned elsewhere, e.g. the Feed\'s "Mark seen")', () => {
    const cached = [{ signalId: 's1', category: 'sourced', headline: 'Old headline', urgency: 1, score: 40 }]
    const merged = mergeActions(cached, [], { signalIds: new Set() }, [])
    expect(merged).toEqual([])
  })

  it('appends a genuinely new fresh item not already represented in the cache', () => {
    const cached = [{ signalId: 's1', category: 'sourced', urgency: 1, score: 40 }]
    const fresh = [{ signalId: 's1', category: 'sourced', urgency: 1, score: 40 }, { signalId: 's2', category: 'sourced', urgency: 2, score: 30 }]
    const merged = mergeActions(cached, fresh, { signalIds: new Set(['s1', 's2']) }, [])
    expect(merged.map(a => a.signalId)).toEqual(['s2', 's1']) // s2 sorts first: higher urgency
  })

  it('does not duplicate a cached item that also appears in fresh', () => {
    const cached = [{ signalId: 's1', category: 'sourced', urgency: 1, score: 40 }]
    const fresh = [{ signalId: 's1', category: 'sourced', urgency: 1, score: 40 }]
    const merged = mergeActions(cached, fresh, { signalIds: new Set(['s1']) }, [])
    expect(merged).toHaveLength(1)
  })

  it('keeps a CRM-category item (no signalId) whose contact still exists', () => {
    const cached = [{ category: 'dormant', contactId: 'c1', urgency: 0, score: 20 }]
    const merged = mergeActions(cached, [], { contactIds: new Set(['c1']) }, [])
    expect(merged).toEqual(cached)
  })

  it('drops a CRM-category item whose contact no longer exists', () => {
    const cached = [{ category: 'dormant', contactId: 'c1', urgency: 0, score: 20 }]
    const merged = mergeActions(cached, [], { contactIds: new Set() }, [])
    expect(merged).toEqual([])
  })

  it('drops a CRM-category item whose key was explicitly marked done, even though its contact still exists — dismissedKeys is the only "done" flag these categories have', () => {
    const item = { category: 'dormant', contactId: 'c1', keyContext: '2026-01-01', urgency: 0, score: 20 }
    const merged = mergeActions([item], [item], { contactIds: new Set(['c1']) }, [actionKey(item)])
    expect(merged).toEqual([])
  })

  it('a dismissed dormant contact resurfaces as a new occurrence once keyContext changes (re-engaged, then went dormant again)', () => {
    const oldOccurrence = { category: 'dormant', contactId: 'c1', keyContext: '2026-01-01', urgency: 0, score: 20 }
    const newOccurrence = { category: 'dormant', contactId: 'c1', keyContext: '2026-06-01', urgency: 0, score: 20 }
    const merged = mergeActions([], [newOccurrence], { contactIds: new Set(['c1']) }, [actionKey(oldOccurrence)])
    expect(merged).toEqual([newOccurrence])
  })

  it('sorts the merged result by urgency then score, same rule as selectDailyItems', () => {
    const cached = [{ signalId: 's1', category: 'sourced', urgency: 0, score: 90 }]
    const fresh = [{ signalId: 's1', category: 'sourced', urgency: 0, score: 90 }, { signalId: 's2', category: 'sourced', urgency: 2, score: 10 }]
    const merged = mergeActions(cached, fresh, { signalIds: new Set(['s1', 's2']) }, [])
    expect(merged[0].signalId).toBe('s2')
  })
})

describe('mergeActions — a carried-forward sourced item is re-checked against the contact requirement, not just "does the record still exist" (2026-08-24)', () => {
  // The exact bug this guards: a DP World card with no verified contact and
  // no contact candidates survived every single cache clear during this
  // fix, because clearing actions_cache never touched the underlying
  // intelligence_signals row — so the very next merge, from any tab, saw
  // "signal still exists" and kept the item exactly as before, undoing the
  // clear. buildSourcedPool being correct was never enough on its own; a
  // rule change there only affects what's freshly proposed, never what's
  // already sitting in someone's cache, unless the merge itself also
  // enforces it.
  const sourcedNoContact = { source: 'sourced', category: 'sourced', signalId: 's1', headline: 'x', urgency: 2, score: 40, verifiedContact: null, contactCandidates: [] }
  const sourcedVerified = { source: 'sourced', category: 'sourced', signalId: 's1', headline: 'x', urgency: 2, score: 40, verifiedContact: { name: 'Jane Doe' }, contactCandidates: [] }
  const sourcedWithCandidates = { source: 'sourced', category: 'sourced', signalId: 's1', headline: 'x', urgency: 2, score: 40, verifiedContact: null, contactCandidates: [{ name: 'Jane Doe' }] }

  it('drops a cached sourced item with no verified contact and no candidates, even though its signal still exists', () => {
    const merged = mergeActions([sourcedNoContact], [], { signalIds: new Set(['s1']) }, [])
    expect(merged).toEqual([])
  })

  it('keeps a cached sourced item with a verified contact', () => {
    const merged = mergeActions([sourcedVerified], [], { signalIds: new Set(['s1']) }, [])
    expect(merged).toEqual([sourcedVerified])
  })

  it('keeps a cached sourced item with at least one contact candidate, even without a single verified contact', () => {
    const merged = mergeActions([sourcedWithCandidates], [], { signalIds: new Set(['s1']) }, [])
    expect(merged).toEqual([sourcedWithCandidates])
  })

  it('never applies this check to a non-sourced (CRM) cached item, which has no verifiedContact/contactCandidates concept at all', () => {
    const dormant = { source: 'crm', category: 'dormant', contactId: 'c1', urgency: 0, score: 20 }
    const merged = mergeActions([dormant], [], { contactIds: new Set(['c1']) }, [])
    expect(merged).toEqual([dormant])
  })
})

describe('actionKey', () => {
  it('returns null for an action with no stable identity', () => {
    expect(actionKey({ category: 'sourced' })).toBeNull()
  })

  it('produces distinct keys for the same contact at two different dormancy occurrences', () => {
    const a = actionKey({ category: 'dormant', contactId: 'c1', keyContext: '2026-01-01' })
    const b = actionKey({ category: 'dormant', contactId: 'c1', keyContext: '2026-06-01' })
    expect(a).not.toBe(b)
  })
})

describe('selectDailyItems', () => {
  it('filters out anything below MIN_SCORE and sorts urgency first, then score', () => {
    const pools = {
      a: [{ category: 'x', score: 10, urgency: 0 }], // below bar, excluded
      b: [{ category: 'x', score: 50, urgency: 0 }],
      c: [{ category: 'x', score: 30, urgency: 1 }], // lower score but higher urgency, should rank first
    }
    const result = selectDailyItems(pools)
    expect(result).toHaveLength(2)
    expect(result[0].urgency).toBe(1)
    expect(result[1].score).toBe(50)
  })
})

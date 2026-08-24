import React, { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { getTeamActivitySummary } from '../lib/data/teamActivity'
import ErrorBanner from './ErrorBanner'

// Tier copy lives here, not in a shared constants file — the ONLY thing
// that has to match the backend exactly is the tier key ('starter' /
// 'growth' / 'team'), which stripe-checkout.js maps to a real Stripe Price
// ID via env vars. Everything else here (price shown, description, feature
// list) is display copy and safe to tune without touching billing logic.
// See Annie-Pricing-Strategy.md for how these numbers were arrived at —
// treat them as the working proposal, not a locked-in final price.
const TIERS = [
  {
    key: 'starter',
    name: 'Starter',
    blurb: 'For a solo recruiter or a single desk.',
    monthly: 79,
    yearly: 69,
    features: ['Full CRM, pipeline & contacts', 'Recurring BD signal scan', "Today's Actions", 'Ask Annie (up to 100 messages/mo)', 'LinkedIn import'],
  },
  {
    key: 'growth',
    name: 'Growth',
    blurb: 'For a biller who wants more from Annie.',
    monthly: 129,
    yearly: 109,
    features: ['Everything in Starter', 'Unlimited Ask Annie messages', 'Deeper onboarding research pass', 'LinkedIn re-import on demand', 'Priority support'],
    featured: true,
  },
  {
    key: 'team',
    name: 'Team',
    blurb: 'For an agency, 3 seats minimum.',
    monthly: 99,
    yearly: 84,
    perSeat: true,
    features: ['Everything in Growth, per seat', 'Shared target-company list', 'Team admin & insights view', 'Volume pricing on extra seats'],
  },
]

function formatDate(iso) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export default function Billing() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()
  const [subscription, setSubscription] = useState(null)
  const [loading, setLoading] = useState(true)
  const [interval, setInterval_] = useState('month')
  const [checkingOutTier, setCheckingOutTier] = useState(null)
  const [openingPortal, setOpeningPortal] = useState(false)
  const [error, setError] = useState('')

  // Team roster — only ever populated/shown for a Team-tier account. Read
  // directly via the client (RLS's "Members can view their team roster"
  // policy already scopes this to the caller's own team), no dedicated
  // list endpoint needed. Every write (invite/remove) still goes through
  // the two service-role functions below, which enforce owner-only + seat
  // caps that RLS alone doesn't express.
  const [teamMembers, setTeamMembers] = useState([])
  const [myRole, setMyRole] = useState(null)
  // Owner-only — populated from the "Team owners can view members' ..." RLS
  // policies (2026-08-24). A non-owner's query would just come back empty,
  // so this only ever gets fetched once loadTeam() has confirmed the role.
  const [teamActivity, setTeamActivity] = useState(new Map())
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviting, setInviting] = useState(false)
  const [teamError, setTeamError] = useState('')
  const [teamNotice, setTeamNotice] = useState('')

  useEffect(() => { loadSubscription() }, [user])
  useEffect(() => { if (subscription?.tier === 'team') loadTeam() }, [subscription?.tier])

  async function loadSubscription() {
    if (!user) return
    setLoading(true)
    // 2026-08-24: subscriptions.user_id is the checkout initiator, not
    // "this viewer" — a non-owner teammate has no row of their own there at
    // all. RLS now scopes this table by team membership (see "Own
    // subscription read-only" in the 2026-08-24 migration), so dropping the
    // user_id filter is what actually lets every team member see their
    // team's plan, not just whoever ran checkout.
    const { data } = await supabase.from('subscriptions').select('*').maybeSingle()
    setSubscription(data)
    setLoading(false)
  }

  async function loadTeam() {
    const { data: members } = await supabase
      .from('team_members')
      .select('id, user_id, invited_email, role, status, created_at')
      .order('created_at', { ascending: true })

    // team_members.user_id references auth.users, not profiles directly, so
    // there's no PostgREST embed to lean on here — a second lookup by id is
    // simpler and clearer than forcing a foreign-table embed that doesn't
    // exist. Names/emails are just display copy for the roster.
    const userIds = (members || []).map(m => m.user_id).filter(Boolean)
    const { data: profileRows } = userIds.length
      ? await supabase.from('profiles').select('id, email, full_name').in('id', userIds)
      : { data: [] }
    const profileById = new Map((profileRows || []).map(p => [p.id, p]))

    const enriched = (members || []).map(m => ({ ...m, profile: m.user_id ? profileById.get(m.user_id) : null }))
    setTeamMembers(enriched)
    const role = enriched.find(m => m.user_id === user.id)?.role || null
    setMyRole(role)

    // Owner-only "what's everyone working on" view — the "Team admin &
    // insights view" already named in the pricing copy below. Skipped
    // entirely for a non-owner rather than fetched-and-discarded, since the
    // RLS policies backing this only ever return anything for an owner
    // anyway (see teamActivity.js's header comment).
    if (role === 'owner') {
      const activeMemberIds = enriched.filter(m => m.status === 'active' && m.user_id).map(m => m.user_id)
      const activity = await getTeamActivitySummary(activeMemberIds)
      setTeamActivity(activity)
    } else {
      setTeamActivity(new Map())
    }
  }

  async function sendInvite(e) {
    e.preventDefault()
    setTeamError('')
    setTeamNotice('')
    setInviting(true)
    try {
      const result = await authedPost('/api/team-invite', { email: inviteEmail.trim() })
      setInviteEmail('')
      setTeamNotice(result.status === 'added' ? 'Added to your team — they have access now.' : 'Invite sent — they\'ll get an email to set up their account.')
      await loadTeam()
    } catch (err) {
      setTeamError(err.message || 'Could not send that invite.')
    } finally {
      setInviting(false)
    }
  }

  async function removeMember(memberId) {
    setTeamError('')
    setTeamNotice('')
    try {
      await authedPost('/api/team-remove-member', { memberId })
      await loadTeam()
    } catch (err) {
      setTeamError(err.message || 'Could not remove that member.')
    }
  }

  async function authedPost(path, body) {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) throw new Error('You need to be signed in for that.')
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) throw new Error(data.error || 'Request failed')
    return data
  }

  async function choosePlan(tierKey) {
    setError('')
    setCheckingOutTier(tierKey)
    try {
      // stripe-checkout.js only resolves at its custom config.path
      // ('/api/stripe-checkout') — see callChat.js's comment for why the
      // default '/.netlify/functions/...' alias 404s once a function sets
      // a custom path.
      const { url } = await authedPost('/api/stripe-checkout', { tier: tierKey, interval })
      window.location.href = url
    } catch (err) {
      setError(err.message || 'Could not start checkout. Please try again.')
      setCheckingOutTier(null)
    }
  }

  async function manageBilling() {
    setError('')
    setOpeningPortal(true)
    try {
      // Same custom-path fix as choosePlan above — stripe-portal.js only
      // resolves at '/api/stripe-portal'.
      const { url } = await authedPost('/api/stripe-portal', {})
      window.location.href = url
    } catch (err) {
      setError(err.message || 'Could not open the billing portal. Please try again.')
      setOpeningPortal(false)
    }
  }

  const isActive = subscription && ['active', 'trialing'].includes(subscription.status)
  const checkoutStatus = searchParams.get('checkout')

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-navy">Billing</h1>
        <p className="text-gray-500 mt-1">Manage your Annie subscription</p>
      </div>

      {checkoutStatus === 'success' && !isActive && (
        <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-3 text-sm mb-6">
          Payment received — your plan will show as active here in a moment. Refresh if it doesn't update shortly.
        </div>
      )}
      {checkoutStatus === 'cancelled' && (
        <div className="bg-gray-50 border border-gray-200 text-gray-600 rounded-lg px-4 py-3 text-sm mb-6">
          Checkout was cancelled — no charge was made.
        </div>
      )}
      <ErrorBanner>{error}</ErrorBanner>

      {loading ? (
        <div className="text-gray-400 text-sm">Loading...</div>
      ) : isActive ? (
        <div className="card p-6">
          <h2 className="text-lg font-bold text-navy mb-1 capitalize">{subscription.tier || 'Annie'} plan</h2>
          <p className="text-sm text-gray-500 mb-4">
            {subscription.status === 'trialing' ? 'Free trial' : 'Active'}
            {subscription.current_period_end && (
              <>
                {' · '}
                {subscription.status === 'trialing'
                  ? `Trial ends ${formatDate(subscription.current_period_end)}, then billing starts`
                  : `${subscription.cancel_at_period_end ? 'Ends' : 'Renews'} ${formatDate(subscription.current_period_end)}`}
              </>
            )}
            {subscription.seats > 1 && <> · {subscription.seats} seats</>}
          </p>
          <button onClick={manageBilling} disabled={openingPortal} className="btn-primary">
            {openingPortal ? 'Opening...' : 'Manage billing'}
          </button>
          <p className="text-xs text-gray-400 mt-3">Update your card, change plans, view invoices, or cancel — all handled securely by Stripe.</p>
        </div>
      ) : null}

      {isActive && subscription.tier === 'team' && (
        <div className="card p-6 mt-5">
          <h2 className="text-lg font-bold text-navy mb-1">Team members</h2>
          <p className="text-sm text-gray-500 mb-4">
            Everyone on your team shares one CRM — the same contacts, jobs, deals, candidates, and meetings, kept in sync for the whole desk.
            Each person's Intelligence Feed and Today's Actions stay tuned to their own market, since recruiters on the same team can be working entirely different sectors.
            {subscription.seats > 0 && <> Your plan includes {subscription.seats} seats.</>}
          </p>

          <ErrorBanner>{teamError}</ErrorBanner>
          {teamNotice && <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-2 text-sm mb-4">{teamNotice}</div>}

          <ul className="divide-y divide-gray-100 mb-4">
            {teamMembers.map(m => {
              const activity = m.user_id ? teamActivity.get(m.user_id) : null
              return (
              <li key={m.id} className="flex items-center justify-between py-2.5">
                <div>
                  <div className="text-sm font-medium text-navy">
                    {m.status === 'active' ? (m.profile?.full_name || m.profile?.email || 'Team member') : m.invited_email}
                  </div>
                  <div className="text-xs text-gray-400">
                    {m.role === 'owner' ? 'Owner' : 'Member'}
                    {m.status === 'invited' && ' · Invite pending'}
                    {/* Owner-only visibility into what each teammate is
                        working on — "Team admin & insights view" from the
                        pricing copy above, backed by the read-only RLS
                        policies added alongside this. Not shown for the
                        viewer's own row (myRole==='owner' already sees
                        their own feed directly) or for a still-pending
                        invite (nothing to report on yet). */}
                    {myRole === 'owner' && activity && m.user_id !== user.id && (
                      <> · {activity.newSignals} new signal{activity.newSignals === 1 ? '' : 's'} this week · {activity.actionsPending} action{activity.actionsPending === 1 ? '' : 's'} open, {activity.actionsDone} done</>
                    )}
                  </div>
                </div>
                {myRole === 'owner' && m.role !== 'owner' && (
                  <button onClick={() => removeMember(m.id)} className="text-xs text-red-500 hover:text-red-700 font-medium">
                    Remove
                  </button>
                )}
              </li>
              )
            })}
          </ul>

          {myRole === 'owner' && (
            <form onSubmit={sendInvite} className="flex gap-2">
              <input
                type="email"
                required
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder="teammate@yourfirm.com"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
              <button type="submit" disabled={inviting} className="btn-primary whitespace-nowrap">
                {inviting ? 'Sending...' : 'Invite'}
              </button>
            </form>
          )}
        </div>
      )}

      {!isActive && (
        <>
          {/* Matches the trial-eligibility rule in stripe-checkout.js: a
              customer with no subscriptions row at all gets 7 days free on
              their first plan. A returning customer (this row exists but is
              e.g. cancelled) has already had that trial once, so this
              messaging — and the discount it implies — doesn't show for
              them, and their next checkout starts billing immediately. */}
          {!subscription ? (
            <p className="text-sm text-gray-600 mb-4">Every plan starts with a <span className="font-semibold text-navy">7-day free trial</span>. Cancel anytime before it ends and you won't be charged.</p>
          ) : (
            <p className="text-sm text-gray-600 mb-4">Choose a plan to resubscribe.</p>
          )}
          <div className="flex items-center gap-3 mb-6">
            <span className={`text-sm font-medium ${interval === 'month' ? 'text-navy' : 'text-gray-400'}`}>Monthly</span>
            <button
              type="button"
              onClick={() => setInterval_(i => i === 'month' ? 'year' : 'month')}
              aria-label="Toggle billing interval"
              className={`relative w-11 h-6 rounded-full transition-colors ${interval === 'year' ? 'bg-navy' : 'bg-gray-300'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${interval === 'year' ? 'translate-x-5' : ''}`} />
            </button>
            <span className={`text-sm font-medium ${interval === 'year' ? 'text-navy' : 'text-gray-400'}`}>Annual <span className="text-gold-ink">(save ~15%)</span></span>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {TIERS.map(tier => (
              <div key={tier.key} className={`card p-6 flex flex-col ${tier.featured ? 'ring-2 ring-gold' : ''}`}>
                {tier.featured && <div className="text-[10px] font-bold text-gold-ink uppercase tracking-wider mb-2">Most popular</div>}
                <h3 className="text-lg font-bold text-navy">{tier.name}</h3>
                <p className="text-sm text-gray-500 mb-4">{tier.blurb}</p>
                <div className="mb-4">
                  <span className="text-3xl font-bold text-navy">${interval === 'year' ? tier.yearly : tier.monthly}</span>
                  <span className="text-gray-500 text-sm">/mo{tier.perSeat ? ' per seat' : ''}{interval === 'year' ? ', billed annually' : ''}</span>
                </div>
                <ul className="text-sm text-gray-600 space-y-2 mb-6 flex-1">
                  {tier.features.map(f => (
                    <li key={f} className="flex gap-2">
                      <span className="text-gold-ink flex-shrink-0">✓</span>{f}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => choosePlan(tier.key)}
                  disabled={checkingOutTier === tier.key}
                  className={tier.featured ? 'btn-primary' : 'btn-ghost'}
                >
                  {checkingOutTier === tier.key ? 'Redirecting...' : subscription ? 'Choose plan' : 'Start free trial'}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

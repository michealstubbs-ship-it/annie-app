import React, { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

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
    monthly: 149,
    yearly: 129,
    features: ['Everything in Starter', 'Higher Ask Annie usage', 'Deeper onboarding research pass', 'LinkedIn re-import on demand', 'Priority support'],
    featured: true,
  },
  {
    key: 'team',
    name: 'Team',
    blurb: 'For an agency, 3 seats minimum.',
    monthly: 129,
    yearly: 109,
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

  useEffect(() => { loadSubscription() }, [user])

  async function loadSubscription() {
    if (!user) return
    setLoading(true)
    const { data } = await supabase.from('subscriptions').select('*').eq('user_id', user.id).maybeSingle()
    setSubscription(data)
    setLoading(false)
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
      const { url } = await authedPost('/.netlify/functions/stripe-checkout', { tier: tierKey, interval })
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
      const { url } = await authedPost('/.netlify/functions/stripe-portal', {})
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
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-6">{error}</div>
      )}

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
      ) : (
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

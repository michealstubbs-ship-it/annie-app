// Buying more contact credits, from where they ran out.
//
// Deliberately shown only when the monthly allowance is actually low, and
// deliberately leading with the UPGRADE rather than the packs when the customer
// is on Starter. A Starter recruiter hitting 50 every month is a Growth
// customer who has not been asked properly — Growth is +$50 for +100 credits
// plus unlimited Ask Annie, which is better value per credit than any pack here
// and is priced that way on purpose (see netlify/functions/lib/topups.js).
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchTopupPacks, startTopupCheckout } from '../../lib/data/topups'

export default function TopUpPanel({ credits, tier, onClose }) {
  const [packs, setPacks] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchTopupPacks().then(p => { if (!cancelled) setPacks(p) })
    return () => { cancelled = true }
  }, [])

  async function buy(key) {
    setBusy(key)
    setError(null)
    try {
      window.location.href = await startTopupCheckout(key)
    } catch (err) {
      setError(err.message)
      setBusy(null)
    }
  }

  const showUpgradeFirst = tier === 'starter'

  return (
    <div className="card p-5 mb-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-bold text-navy">
            {credits?.remaining === 0 ? 'You’ve used your contact lookups' : 'Running low on contact lookups'}
          </h3>
          <p className="text-[13px] text-gray-500 mt-0.5">
            {credits?.remaining ?? 0} left of {credits?.limit ?? 0} this month
            {credits?.topupBalance > 0 && `, including ${credits.topupBalance} purchased`}. Everything else in the Feed keeps working — only finding a new contact needs one.
          </p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">Dismiss</button>
        )}
      </div>

      {showUpgradeFirst && (
        <div className="mt-3.5 flex items-center gap-3 flex-wrap bg-page-bg border border-gray-200 rounded-lg px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-[13.5px] font-bold text-navy">Growth gives you 150 a month</p>
            <p className="text-[12.5px] text-gray-500">Plus unlimited Ask Annie and deeper scans. Cheaper per lookup than any top-up.</p>
          </div>
          <Link
            to="/dashboard/billing"
            className="ml-auto text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-navy text-gold hover:bg-navy-light transition-colors"
          >
            See Growth
          </Link>
        </div>
      )}

      {packs.length > 0 && (
        <>
          <p className="text-[11px] uppercase tracking-wider text-gray-400 font-bold mt-4 mb-2">
            {showUpgradeFirst ? 'Or top up this month' : 'Top up'}
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {packs.map(p => (
              <button
                key={p.key}
                type="button"
                onClick={() => buy(p.key)}
                disabled={!!busy}
                className="text-left border border-gray-200 rounded-lg px-3.5 py-3 hover:border-gold transition-colors disabled:opacity-60"
              >
                <div className="font-bold text-navy tabular-nums">{p.credits} lookups</div>
                <div className="text-[13px] text-gray-600 tabular-nums">${p.priceUsd}</div>
                <div className="text-[11.5px] text-gray-400 tabular-nums mt-0.5">${p.perCredit.toFixed(2)} each</div>
                {busy === p.key && <div className="text-[11.5px] text-gold-ink mt-1">Opening checkout…</div>}
              </button>
            ))}
          </div>
          <p className="text-[11.5px] text-gray-400 mt-2">
            Purchased lookups don’t expire, and your monthly allowance is always used first.
          </p>
        </>
      )}

      {error && <p className="text-[12.5px] text-red-600 mt-2">{error}</p>}
    </div>
  )
}

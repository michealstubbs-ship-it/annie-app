import { useState } from 'react'
import CompanyLogo from '../CompanyLogo'
import WayInPanel from './WayInPanel'
import ContactLookup from './ContactLookup'
import { SIGNAL_TYPE_META } from '../../lib/signalTypes'
import { STATE_NEW, STATE_WORKING, STATE_PARKED } from '../../lib/stream/buildStream'

function timeAgo(iso) {
  if (!iso) return null
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (!Number.isFinite(days)) return null
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? 'last month' : `${months} months ago`
}

const STATES = [
  { key: STATE_NEW, label: 'New' },
  { key: STATE_WORKING, label: 'Working' },
  { key: STATE_PARKED, label: 'Park' },
]

export default function StreamItem({ item, onSetState, onDone, onDismiss, onSeen, onResolved }) {
  const [open, setOpen] = useState(false)
  const s = item.signal
  const meta = SIGNAL_TYPE_META[s.signal_type] || { label: s.signal_type, icon: '📌' }

  function toggle() {
    if (!open) onSeen?.(item)
    setOpen(o => !o)
  }

  return (
    <article className="card overflow-hidden">
      <div className="px-5 pt-4">
        <div className="flex items-center gap-2 flex-wrap mb-2.5">
          <span className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border border-navy/15 bg-navy/5 text-navy">
            {(meta.icon ? meta.icon + ' ' : '') + (meta.chipLabel || meta.label)}
          </span>
          {s.company_country && (
            <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-page-bg text-gray-500 border border-gray-200">
              {s.company_country}
            </span>
          )}
          {timeAgo(s.found_at) && (
            <span className="text-[11px] text-gray-400">Found {timeAgo(s.found_at)}</span>
          )}
          {s.status === 'new' && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gold/15 text-gold-ink">New</span>
          )}

          {/* What the recruiter is doing about it. This is the behavioural
              signal the product has never had — nothing today records whether
              an item was worked, parked or ignored. */}
          <div className="ml-auto flex gap-1" role="group" aria-label="What are you doing with this">
            {STATES.map(st => {
              const on = item.state === st.key
              return (
                <button
                  key={st.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onSetState(item, st.key)}
                  className={`text-[11px] font-bold px-2.5 py-1 rounded-md border transition-colors ${
                    on ? 'bg-navy text-white border-navy' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                  }`}
                >{st.label}</button>
              )
            })}
          </div>
        </div>

        <div className="flex items-start gap-3">
          <CompanyLogo name={s.company_name} logoUrl={s.company_logo_url} />
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold text-gray-500">{s.company_name}</div>
            <h3 className="text-[17px] font-bold text-navy leading-snug mt-0.5 text-balance">{s.headline}</h3>
          </div>
        </div>

        {s.why_it_matters && (
          <p className="text-[13.5px] text-gray-600 mt-2 max-w-[68ch]">{s.why_it_matters}</p>
        )}

        {/* The source, on every item. All 530 signals from the last seven days
            already stored source_url and source_label — 100% of them. Nothing
            in the product ever displayed one. "Not yet checked" is
            deliberately weaker than "unverified": source_verified false means
            nobody has opened the link, not that it is fake. Two unchecked ones
            were opened by hand on 2026-09-04 and were real pages. */}
        {item.source.url && (
          <div className="flex items-center gap-2 flex-wrap mt-2.5 pb-4">
            <a
              href={item.source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11.5px] font-medium text-gold-ink border-b border-gold/40 hover:border-gold-ink pb-px"
            >
              {item.source.label || 'source'} <span aria-hidden="true">↗</span>
            </a>
            {item.source.checked ? (
              <span className="text-[10.5px] px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-700">link checked</span>
            ) : (
              <span className="text-[10.5px] px-1.5 py-0.5 rounded border border-dashed border-gray-200 text-gray-400">link not yet checked</span>
            )}
          </div>
        )}
      </div>

      <WayInPanel wayIn={item.wayIn} companyName={s.company_name}>
        <div className="flex gap-2 flex-wrap mt-3 items-center">
          <ContactLookup item={item} onResolved={onResolved} linkedinRoute={item.linkedinRoute} />

          {item.linkedinRoute && (
            <a
              className="inline-flex items-center gap-2 text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
              href={item.linkedinRoute.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {item.linkedinRoute.tier === 'profile' ? 'Open LinkedIn' : 'LinkedIn route'}
              <span className="text-[10.5px] font-semibold text-emerald-700">free</span>
            </a>
          )}

          <button
            type="button"
            onClick={toggle}
            className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
          >
            {open ? 'Hide detail' : 'More detail'}
          </button>
        </div>

        {open && (
          <div className="mt-3 pt-3 border-t border-gray-200/70 space-y-3">
            {s.who_to_approach && (
              <div>
                <span className="block text-[10.5px] uppercase tracking-wider text-gray-400 font-bold mb-0.5">Who to approach</span>
                <p className="text-[13px] text-gray-700">{s.who_to_approach}</p>
              </div>
            )}
            {Array.isArray(s.likely_roles) && s.likely_roles.length > 0 && (
              <div>
                <span className="block text-[10.5px] uppercase tracking-wider text-gray-400 font-bold mb-0.5">Roles this probably creates</span>
                <p className="text-[13px] text-gray-700">{s.likely_roles.join(' · ')}</p>
              </div>
            )}
            {s.candidate_angle && (
              <div>
                <span className="block text-[10.5px] uppercase tracking-wider text-gray-400 font-bold mb-0.5">Candidate angle</span>
                <p className="text-[13px] text-gray-700">{s.candidate_angle}</p>
              </div>
            )}
            <div className="flex gap-2 flex-wrap pt-1">
              <button
                type="button"
                onClick={() => onDone(item)}
                className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
              >Mark as done</button>
              <button
                type="button"
                onClick={() => onDismiss(item)}
                className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
              >Not relevant</button>
            </div>
          </div>
        )}
      </WayInPanel>
    </article>
  )
}

// Shared presentational pieces for the 5 Annie Overview tabs
// (AdminOverviewTab/AdminFinanceTab/AdminCustomersTab/AdminProductTab/
// AdminEscalationsTab). Pulled out here rather than duplicated per tab —
// the whole point of splitting the old single-file AdminOverview.jsx into
// five tabs was so one broken data source only breaks one tab (see
// AdminOverview.jsx's own header), not so five copies of the same KPI
// tile/bar-row/pill markup drift out of sync with each other.
import React from 'react'

export function StatTile({ label, value, sub, subClass = 'text-gray-400', valueClass = 'text-navy' }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-extrabold mt-1.5 tabular-nums ${valueClass}`}>{value}</div>
      {sub && <div className={`text-xs font-medium mt-1.5 ${subClass}`}>{sub}</div>}
    </div>
  )
}

const PILL_STYLES = {
  good: 'bg-green-50 text-status-good',
  warn: 'bg-yellow-50 text-status-warning',
  crit: 'bg-red-50 text-status-critical',
  neutral: 'bg-page-bg text-gray-500',
}

export function Pill({ tone = 'neutral', children }) {
  return <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold ${PILL_STYLES[tone] || PILL_STYLES.neutral}`}>{children}</span>
}

export function SectionTitle({ children, note }) {
  return (
    <h2 className="text-[15px] font-extrabold text-navy mt-2 mb-1">
      {children}{note && <span className="ml-2 text-xs font-medium text-gray-400">{note}</span>}
    </h2>
  )
}

// One horizontal bar with a label and a right-aligned value — the same
// visual shape used for revenue-by-tier, vendor spend, cost-cap headroom,
// funnel bars, and feature-adoption bars. `pct` is 0-100 and already
// clamped by the caller (different bars clamp differently: a funnel bar
// floors at 3% so a real-but-tiny stage stays visible, a cap-headroom bar
// caps at 100 so overshoot doesn't blow out the layout).
export function BarRow({ label, pct, value, color = 'bg-series-1' }) {
  return (
    <div className="flex items-center gap-2.5 mb-2.5 last:mb-0">
      <span className="text-[12.5px] font-semibold text-gray-600 w-28 flex-shrink-0 truncate">{label}</span>
      <div className="flex-1 bg-page-bg rounded-full h-2.5 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-bold text-navy w-20 flex-shrink-0 text-right tabular-nums">{value}</span>
    </div>
  )
}

export function NotTrackedCard({ title, children }) {
  return (
    <div className="border border-dashed border-gray-200 rounded-xl p-4 text-center text-gray-400 text-xs">
      <strong className="block text-gray-600 text-xs mb-1">{title}</strong>
      {children}
    </div>
  )
}

// Self-contained inline-SVG trend line — no chart library, so it renders
// identically regardless of whether the viewer's browser can reach a CDN
// (see the mock's own header for why: Chart.js from a CDN silently failed
// in this session's own sandboxed verification browser).
export function TrendChart({ labels, data, color = '#c9a84c', format = (v) => String(Math.round(v)) }) {
  if (!data || data.length === 0) return <p className="text-sm text-gray-400 py-8 text-center">Not enough history yet.</p>
  const w = 560, h = 190, padL = 44, padR = 14, padT = 14, padB = 22
  const plotW = w - padL - padR, plotH = h - padT - padB
  const min = Math.min(...data), max = Math.max(...data)
  const span = max - min || 1
  const yFor = (v) => padT + plotH - ((v - min) / span) * plotH
  const xFor = (i) => (data.length === 1 ? padL : padL + (i / (data.length - 1)) * plotW)
  const linePts = data.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ')
  const areaPts = `${padL},${padT + plotH} ${linePts} ${xFor(data.length - 1)},${padT + plotH}`
  const gridFractions = [0, 0.5, 1]
  const lastX = xFor(data.length - 1), lastY = yFor(data[data.length - 1])

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={200} preserveAspectRatio="none" role="img" aria-label="Trend chart">
      {gridFractions.map((f) => {
        const y = padT + plotH * f
        const val = max - span * f
        return (
          <g key={f}>
            <line x1={padL} y1={y} x2={padL + plotW} y2={y} stroke="#e5e7eb" strokeWidth={1} />
            <text x={padL - 8} y={y + 3} textAnchor="end" fontSize={10} fill="#9ca3af">{format(val)}</text>
          </g>
        )
      })}
      <polygon points={areaPts} fill={color} fillOpacity={0.14} stroke="none" />
      <polyline points={linePts} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={4} fill={color} />
      {labels && (
        <>
          <text x={padL} y={h - 4} fontSize={10} fill="#9ca3af">{labels[0]}</text>
          <text x={padL + plotW} y={h - 4} textAnchor="end" fontSize={10} fill="#9ca3af">{labels[labels.length - 1]}</text>
        </>
      )}
    </svg>
  )
}

const SEVERITY_TONE = { action: 'crit', watch: 'warn', info: 'neutral' }
const CATEGORY_LABEL = { finance: 'Finance', product: 'Product', customer: 'Customer', growth: 'Growth' }

// "Annie's Read" card — narrate-only by design (see admin_ai_insights
// migration's own header): every card requires an explicit human
// approve/dismiss, nothing here ever acts on its own.
export function InsightCard({ insight, onReview, busy }) {
  return (
    <div className="border border-dashed border-gold-ink/60 bg-yellow-50/40 rounded-xl p-4 mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-gold-ink">💡 Annie's read — needs your review</span>
        <Pill tone={SEVERITY_TONE[insight.severity] || 'neutral'}>{CATEGORY_LABEL[insight.category] || insight.category}</Pill>
      </div>
      <p className="text-[13.5px] text-navy leading-relaxed mb-2">{insight.headline}{insight.detail ? ` ${insight.detail}` : ''}</p>
      {insight.cited_metric && <p className="text-[11.5px] text-gray-400 mb-2.5">Based on: {insight.cited_metric}</p>}
      <div className="flex gap-2">
        <button
          disabled={busy}
          onClick={() => onReview(insight.id, 'approved')}
          className="text-[11.5px] font-bold px-3 py-1 rounded-md bg-gold text-navy disabled:opacity-50"
        >
          Approve
        </button>
        <button
          disabled={busy}
          onClick={() => onReview(insight.id, 'dismissed')}
          className="text-[11.5px] font-bold px-3 py-1 rounded-md border border-gray-200 text-gray-500 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

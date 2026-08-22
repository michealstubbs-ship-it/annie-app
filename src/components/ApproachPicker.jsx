import React from 'react'

// Presents Annie's "recommended approach" options for a signal — a real
// pipeline match, a candidate-to-lead-with pitch, a bench-strength pitch —
// as clickable boxes instead of stacking every available angle's full text
// at once. One tweak requested directly: reading two or three paragraphs of
// italic grey text back to back read as "lots of words"; picking an angle
// and reading just that one is faster to act on.
//
// Shared by IntelligenceFeed and TodaysActions, which both surface the same
// three angles Annie's scan writes per signal (just from slightly different
// data shapes) and previously duplicated the same stacked-text markup.
//
// `approaches`: [{ key, icon, label, tone: 'match' | 'default', content }]
// Pass just one entry to skip the picker row entirely and show its content
// directly — there's nothing to choose between.
export default function ApproachPicker({ approaches, selectedKey, onSelect }) {
  if (!approaches.length) return null
  const active = approaches.find(a => a.key === selectedKey) || approaches[0]

  return (
    <div className="mb-2.5" onClick={e => e.stopPropagation()}>
      {approaches.length > 1 && (
        <div className="flex gap-2 mb-2">
          {approaches.map(a => (
            <button
              key={a.key}
              onClick={() => onSelect(a.key)}
              className={`flex-1 min-w-0 text-left px-3.5 py-3 rounded-lg border-2 text-[11.5px] font-semibold transition-colors ${
                active.key === a.key
                  ? 'border-navy bg-navy text-white'
                  : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <span className="block text-base leading-none mb-1">{a.icon}</span>
              <span className="block truncate">{a.label}</span>
            </button>
          ))}
        </div>
      )}
      <div className={`rounded-lg px-3.5 py-3 ${active.tone === 'match' ? 'bg-emerald-50 border border-emerald-200' : 'bg-page-bg'}`}>
        <p className={`text-[11.5px] leading-relaxed ${active.tone === 'match' ? 'font-semibold text-emerald-800' : 'text-gray-600'}`}>
          {active.content}
        </p>
      </div>
    </div>
  )
}

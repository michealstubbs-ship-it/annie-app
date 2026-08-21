import React, { useState } from 'react'

// Multi-select sector picker. Each category is a chip (selecting it means "match
// this whole category"), with an optional dropdown to narrow down to specific
// sub-sectors instead. Selections are stored as plain strings, either the bare
// category label ("Technology") or "Category > Sub-sector" once narrowed, so no
// schema change was needed, onboarding.sectors stays a plain text array.
export default function SectorPicker({ taxonomy, value, onChange }) {
  const [openLabel, setOpenLabel] = useState(null)

  function isCategorySelected(parentLabel) {
    return value.some(v => v === parentLabel || v.startsWith(parentLabel + ' > '))
  }
  // null = whole category (every sub-sector implicitly included), array = narrowed to just these
  function narrowedSubs(parentLabel) {
    if (value.includes(parentLabel)) return null
    const subs = value.filter(v => v.startsWith(parentLabel + ' > ')).map(v => v.slice(parentLabel.length + 3))
    return subs
  }

  function toggleParentChip(parentLabel) {
    if (isCategorySelected(parentLabel)) {
      onChange(value.filter(v => v !== parentLabel && !v.startsWith(parentLabel + ' > ')))
    } else {
      onChange([...value, parentLabel])
    }
  }

  function toggleSub(parentLabel, subLabel, allSubLabels) {
    const wasWhole = value.includes(parentLabel)
    const entry = `${parentLabel} > ${subLabel}`

    if (wasWhole) {
      // Narrowing down for the first time, start with just this one selected.
      onChange([...value.filter(v => v !== parentLabel), entry])
      return
    }

    const has = value.includes(entry)
    let next = has ? value.filter(v => v !== entry) : [...value, entry]

    // If every sub-sector ends up selected, collapse back to the tidy whole-category form.
    const allNowSelected = allSubLabels.every(s => next.includes(`${parentLabel} > ${s}`))
    if (allNowSelected) {
      next = [...next.filter(v => !v.startsWith(parentLabel + ' > ')), parentLabel]
    }
    onChange(next)
  }

  function selectAll(parentLabel) {
    onChange([...value.filter(v => v !== parentLabel && !v.startsWith(parentLabel + ' > ')), parentLabel])
  }

  return (
    <div className="space-y-1">
      {taxonomy.map(cat => {
        const selected = isCategorySelected(cat.label)
        const subs = narrowedSubs(cat.label)
        const isOpen = openLabel === cat.label
        return (
          <div key={cat.label}>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => toggleParentChip(cat.label)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all bg-white
                  ${selected ? 'border-gold text-navy' : 'border-gray-200 text-gray-500'}`}
              >
                {cat.label}
              </button>
              {subs !== null && subs.length > 0 && (
                <span className="text-[10px] text-gray-400">{subs.length} of {cat.subSectors.length} selected</span>
              )}
              <button
                type="button"
                onClick={() => setOpenLabel(isOpen ? null : cat.label)}
                className="text-[11px] text-gray-400 hover:text-navy font-medium"
              >
                {isOpen ? 'Hide sub-sectors ▴' : 'Narrow down ▾'}
              </button>
            </div>

            {isOpen && (
              <div className="ml-1 mt-1.5 mb-2 p-3 bg-page-bg rounded-lg border border-gray-100">
                <div className="flex flex-wrap gap-1.5 mb-2.5">
                  {cat.subSectors.map(s => {
                    const checked = subs === null || subs.includes(s.label)
                    return (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => toggleSub(cat.label, s.label, cat.subSectors.map(x => x.label))}
                        className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-all
                          ${checked ? 'border-gold bg-yellow-50 text-navy' : 'border-gray-200 bg-white text-gray-500'}`}
                      >
                        {s.label}
                      </button>
                    )
                  })}
                </div>
                <button type="button" onClick={() => selectAll(cat.label)} className="text-[11px] font-semibold text-gold-ink hover:underline">
                  All {cat.label}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

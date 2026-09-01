import React, { useState } from 'react'

// Multi-select sector picker. Each category is a chip (selecting it means "match
// this whole category"), with an optional dropdown to narrow down to specific
// sub-sectors instead. Selections are stored as plain strings, either the bare
// category label ("Technology") or "Category > Sub-sector" once narrowed, so no
// schema change was needed, onboarding.sectors stays a plain text array.
//
// 2026-09-01, Michael: "to provide you the best quality leads, pick your top
// [maxSelections] [itemLabel]" — a hard cap, not just advisory copy ("no you
// actually have to make it a UI prompt they cant pick more than what we have
// discussed"). Picking more functions/industries than a specialist firm
// actually targets dilutes Annie's own query budget across all of them (see
// scanShared.js's buildJobTitleQueries — a shared, not per-function, title
// cap), so this directly protects match quality, not just a UI nicety.
// `maxSelections` is optional so this component still works uncapped
// anywhere else it's used without every call site needing to pass it.
export default function SectorPicker({ taxonomy, value, onChange, maxSelections, itemLabel = 'options' }) {
  const [openLabel, setOpenLabel] = useState(null)

  function isCategorySelected(parentLabel) {
    return value.some(v => v === parentLabel || v.startsWith(parentLabel + ' > '))
  }

  const selectedCount = taxonomy.filter(cat => isCategorySelected(cat.label)).length
  const atCap = maxSelections != null && selectedCount >= maxSelections
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
      // Hard cap: a NEW category can't be added once maxSelections is
      // already reached — deselecting one first is always still allowed
      // (the branch above), only adding a category beyond the cap is
      // blocked. The chip is also visually disabled below, this is the
      // belt-and-braces guard against any stale-state click race.
      if (atCap) return
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
    // Narrowing a category that isn't selected AT ALL yet (no whole-category
    // entry, no other sub already narrowed) is itself a new category
    // selection — same cap as toggleParentChip, for the same reason (this
    // is the "Narrow down" panel's own path to selecting a brand new
    // category without ever touching its parent chip).
    if (!has && !isCategorySelected(parentLabel) && atCap) return

    let next = has ? value.filter(v => v !== entry) : [...value, entry]

    // If every sub-sector ends up selected, collapse back to the tidy whole-category form.
    const allNowSelected = allSubLabels.every(s => next.includes(`${parentLabel} > ${s}`))
    if (allNowSelected) {
      next = [...next.filter(v => !v.startsWith(parentLabel + ' > ')), parentLabel]
    }
    onChange(next)
  }

  function selectAll(parentLabel) {
    if (!isCategorySelected(parentLabel) && atCap) return
    onChange([...value.filter(v => v !== parentLabel && !v.startsWith(parentLabel + ' > ')), parentLabel])
  }

  return (
    <div className="space-y-1">
      {maxSelections != null && (
        <p className={`text-xs mb-2 ${atCap ? 'text-gold-ink font-semibold' : 'text-gray-400'}`}>
          {atCap
            ? `You've picked your ${maxSelections} ${itemLabel} — that's the max, for the best quality leads. Remove one to pick a different one.`
            : `To provide you the best quality leads, pick your top ${maxSelections} ${itemLabel} (${selectedCount} of ${maxSelections} picked).`}
        </p>
      )}
      {taxonomy.map(cat => {
        const selected = isCategorySelected(cat.label)
        const subs = narrowedSubs(cat.label)
        const isOpen = openLabel === cat.label
        const disabledByCap = !selected && atCap
        return (
          <div key={cat.label}>
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => toggleParentChip(cat.label)}
                disabled={disabledByCap}
                title={disabledByCap ? `You've reached your ${maxSelections} ${itemLabel} — remove one first to pick this instead.` : undefined}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all bg-white
                  ${selected ? 'border-gold text-navy' : disabledByCap ? 'border-gray-100 text-gray-300 cursor-not-allowed' : 'border-gray-200 text-gray-500'}`}
              >
                {cat.label}
              </button>
              {subs !== null && subs.length > 0 && (
                <span className="text-[10px] text-gray-400">{subs.length} of {cat.subSectors.length} selected</span>
              )}
              <button
                type="button"
                onClick={() => setOpenLabel(isOpen ? null : cat.label)}
                disabled={disabledByCap}
                className={`text-[11px] font-medium ${disabledByCap ? 'text-gray-300 cursor-not-allowed' : 'text-gray-400 hover:text-navy'}`}
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

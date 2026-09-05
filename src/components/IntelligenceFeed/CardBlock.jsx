import { useState } from 'react'

// A disclosure on the card. Collapsed by default, and the header alone has to
// be worth reading — "You know 3 other people at NEOM · 4 total" tells the
// recruiter something even if they never open it.
//
// Michael, 2026-09-05: "there should be a tab taking you them on another
// list", then "UX/UI needs to be slick. But we always need to tell the client
// what they looking at."
export default function CardBlock({ title, count = null, children, defaultOpen = false, onOpen }) {
  const [open, setOpen] = useState(defaultOpen)

  function toggle() {
    if (!open) onOpen?.()
    setOpen(o => !o)
  }

  return (
    <div className="mt-2.5 border border-gray-200 rounded-xl bg-page-bg overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-left text-[13px] font-bold text-navy hover:bg-gray-100/70 transition-colors"
      >
        <span aria-hidden="true" className={`text-[10px] text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <span className="min-w-0">{title}</span>
        {count != null && (
          <span className="ml-auto text-[11px] font-medium text-gray-400 tabular-nums">{count}</span>
        )}
      </button>
      {open && <div className="border-t border-gray-200/70">{children}</div>}
    </div>
  )
}

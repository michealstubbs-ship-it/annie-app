import React, { useState, useEffect, useRef } from 'react'

export default function InfoTip({ text }) {
  const [show, setShow] = useState(false)
  const ref = useRef(null)

  // Low/polish item from the pre-launch audit: this popover had no way to
  // dismiss it except moving the mouse away, which doesn't exist on a touch
  // device — a tap opened it and it just stayed open. Escape and a click
  // outside now both close it, same as any other dismissible popover in
  // the app.
  useEffect(() => {
    if (!show) return
    function onKeyDown(e) { if (e.key === 'Escape') setShow(false) }
    function onClickOutside(e) { if (ref.current && !ref.current.contains(e.target)) setShow(false) }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onClickOutside)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onClickOutside)
    }
  }, [show])

  return (
    <span ref={ref} className="relative inline-flex items-center ml-1.5">
      {/* 2026-08-29 audit fix: with a real mouse, onMouseEnter always fires
          before the click that follows it (you have to be hovering the
          button to click it) — so setShow(true) from the hover, then the
          very same click's setShow(s => !s) immediately flipped it back to
          false. The tooltip opened and closed in the same instant, which
          reads as "clicking does nothing" even though something did fire.
          Click now only ever sets it open (never toggles closed) — a no-op
          on top of hover for a mouse, and the one thing that opens it at
          all for touch/keyboard activation, which never fires
          onMouseEnter. Closing is still handled by mouseleave, Escape, and
          click-outside above, unchanged. */}
      <button
        type="button"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(true)}
        className="w-4 h-4 rounded-full bg-gray-200 text-gray-500 text-[10px] font-bold flex items-center justify-center hover:bg-gold hover:text-navy transition-colors"
        aria-label="More info"
      >
        ?
      </button>
      {show && (
        <span className="absolute left-1/2 -translate-x-1/2 bottom-6 w-56 bg-navy text-white text-xs leading-relaxed rounded-lg px-3 py-2 shadow-xl z-10">
          {text}
        </span>
      )}
    </span>
  )
}

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
      <button
        type="button"
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(s => !s)}
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

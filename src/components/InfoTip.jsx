import React, { useState } from 'react'

export default function InfoTip({ text }) {
  const [show, setShow] = useState(false)
  return (
    <span className="relative inline-flex items-center ml-1.5">
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

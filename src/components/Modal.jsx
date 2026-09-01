import React, { useEffect, useRef } from 'react'

// Shared modal shell — every form dialog and confirmation in the app should
// render through this instead of hand-rolling its own overlay div. Before
// this, none of the app's modals had role="dialog", aria-modal, Escape-to-
// close, or a focus trap: a keyboard or screen-reader user had no reliable
// way to close or navigate any form in the product. This fixes that once,
// centrally, instead of needing the same fix repeated in every component
// that opens a dialog.
export default function Modal({ open, onClose, title, children, maxWidth = 'max-w-md' }) {
  const panelRef = useRef(null)
  const previouslyFocused = useRef(null)
  // 2026-09-01 audit fix, real customer report ("it lets me type one letter
  // then goes off, then I have to click back in"): every caller passes
  // onClose as an inline arrow function (`onClose={() => setShowModal(false)}`),
  // a new function identity on every render of the PARENT — and typing into
  // any field in the form re-renders that parent (the keystroke's own
  // setState). With onClose in this effect's dependency array, that meant
  // the whole setup effect below re-ran on every single keystroke anywhere
  // in the modal, including its `firstField?.focus()` line — which
  // unconditionally steals focus back to the modal's FIRST focusable
  // field. Typing in that exact first field masked the bug (re-focusing an
  // already-focused element is a no-op), which is why this went unnoticed —
  // but typing into anything else (Meetings' Outcome/Next steps, a middle
  // field in any Add/Edit form) yanked focus away after every character.
  // A ref keeps the effect's own logic reading the latest onClose without
  // needing it in the dependency array, so this setup now runs exactly
  // once per open/close transition, not once per keystroke — which also
  // fixes a second, quieter bug in the same effect: `previouslyFocused`
  // was being re-captured on every keystroke too, so "restore focus to
  // whatever opened the modal" on close was actually restoring focus to
  // whatever field was focused right before closing, not the real trigger.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  useEffect(() => {
    if (!open) return

    previouslyFocused.current = document.activeElement

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onCloseRef.current?.()
        return
      }
      // Basic focus trap: Tab/Shift+Tab cycles within the dialog instead of
      // escaping to the page behind it.
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if (!focusable.length) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    // Move focus into the dialog so keyboard/screen-reader users land
    // somewhere sensible instead of the trigger button that's now hidden
    // behind the overlay.
    const firstField = panelRef.current?.querySelector('input, textarea, select, button')
    firstField?.focus()

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      // Restore focus to whatever opened the modal, standard dialog behaviour.
      previouslyFocused.current?.focus?.()
    }
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`bg-white rounded-2xl shadow-2xl w-full ${maxWidth} max-h-[90vh] overflow-y-auto`}
        onClick={e => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-bold text-navy">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-gray-400 hover:text-navy text-xl leading-none w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-100"
            >
              ×
            </button>
          </div>
        )}
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

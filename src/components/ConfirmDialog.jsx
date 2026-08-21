import React from 'react'
import Modal from './Modal'

// Replaces the browser's native confirm() for destructive actions across
// the app. window.confirm() is unstyled, blocks the render thread, and is
// the one interaction pattern that broke out of Annie's own branded UI —
// every other dialog in the product is a styled modal, deletes were the
// one exception. Renders through the same accessible Modal shell (Escape,
// focus trap, role="dialog") everything else now uses.
export default function ConfirmDialog({ open, onClose, onConfirm, title = 'Are you sure?', message, confirmLabel = 'Delete', danger = true }) {
  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-sm">
      {message && <p className="text-sm text-gray-600 mb-5">{message}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
        <button
          onClick={() => { onConfirm(); onClose(); }}
          className={`text-sm font-semibold px-4 py-2 rounded-lg text-white ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-navy hover:bg-navy-light'}`}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

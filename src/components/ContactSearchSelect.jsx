import React, { useState, useRef, useEffect } from 'react'

// 2026-09-01, Michael: "you should be able to search a contact, not just a
// drop down, because if there are 500 contacts that will take forever."
// Replaces a plain <select> (every option rendered, scroll-to-find) with a
// type-ahead: type a few letters of a name or company, pick from the
// filtered list. Filters client-side against whatever `contacts` the caller
// already loaded (Meetings.jsx already fetches the full list once via
// listContactsMinimal) — no extra network round trip needed for a few
// hundred rows, and it keeps this a plain, dependency-free combobox rather
// than adding a new debounced-search data path for the same list this page
// already has in memory.
export default function ContactSearchSelect({ contacts, value, onChange, id }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  const selectedContact = contacts.find(c => c.id === value) || null

  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const q = query.trim().toLowerCase()
  const filtered = q
    ? contacts.filter(c => c.name?.toLowerCase().includes(q) || c.company?.toLowerCase().includes(q))
    : contacts

  function pick(c) {
    onChange(c ? c.id : '')
    setQuery('')
    setOpen(false)
  }

  return (
    <div className="relative" ref={wrapRef}>
      <input
        id={id}
        className="input"
        placeholder={selectedContact ? undefined : 'Search contacts by name or company...'}
        value={open ? query : (selectedContact ? `${selectedContact.name}${selectedContact.company ? ` (${selectedContact.company})` : ''}` : query)}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { setQuery(''); setOpen(true) }}
      />
      {value && !open && (
        <button
          type="button"
          onClick={() => pick(null)}
          aria-label="Clear linked contact"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-navy text-sm"
        >
          ×
        </button>
      )}
      {open && (
        <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
          <button
            type="button"
            onClick={() => pick(null)}
            className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
          >
            Not linked to a contact
          </button>
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-gray-400">No contacts match "{query}"</p>
          ) : (
            filtered.slice(0, 50).map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => pick(c)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${c.id === value ? 'bg-yellow-50 text-navy font-semibold' : 'text-gray-700'}`}
              >
                {c.name}{c.company ? ` (${c.company})` : ''}
              </button>
            ))
          )}
          {filtered.length > 50 && (
            <p className="px-3 py-1.5 text-[11px] text-gray-400 border-t border-gray-100">Showing first 50 — keep typing to narrow down.</p>
          )}
        </div>
      )}
    </div>
  )
}

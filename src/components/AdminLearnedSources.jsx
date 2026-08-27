import React, { useState, useEffect, useCallback } from 'react'
import ErrorBanner from './ErrorBanner'
import Spinner from './Spinner'
import { getAdminLearnedSources, deleteAdminLearnedSource } from '../lib/data/adminLearnedSources'
import { SECTOR_PARENT_LABELS } from '../lib/sectorTaxonomy'

// Admin visibility into annie_learned_sources — the shared company/source
// memory every scan prompt reads from (see scanShared.js's own header on
// getLearnedSources). Built alongside a quality guard on what gets written
// in (2026-08-27-learned-sources-quality-guard.sql) as the second half of
// the same fix: rejecting obvious junk at write time catches most of it,
// but this is the backstop for anything that still gets through, or that
// was already in the table before the guard existed — a real, if
// imperfect, way to look and remove one, rather than none at all.
function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function AdminLearnedSources() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sector, setSector] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [deletingId, setDeletingId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setRows(await getAdminLearnedSources({ sector: sector || null, search: search || null }))
    } catch (err) {
      setError(err.message || 'Could not load learned sources.')
    } finally {
      setLoading(false)
    }
  }, [sector, search])

  useEffect(() => { load() }, [load])

  function onSearchSubmit(e) {
    e.preventDefault()
    setSearch(searchInput.trim())
  }

  async function onDelete(row) {
    if (!window.confirm(`Remove "${row.value}" from Annie's learned ${row.kind === 'source' ? 'sources' : 'companies'} for ${row.sector}? This can't be undone, and Annie will stop suggesting it on future scans.`)) return
    setDeletingId(row.id)
    setError('')
    try {
      await deleteAdminLearnedSource(row.id)
      setRows(prev => prev.filter(r => r.id !== row.id))
    } catch (err) {
      setError(err.message || 'Could not remove that entry.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <h2 className="text-sm font-bold text-navy">What Annie has learned</h2>
        <p className="text-xs text-gray-400 mb-3">Companies and sources fed into future scan prompts for each sector — grown from Annie's own research and from what customers add to their CRM</p>

        <div className="flex flex-wrap gap-2 mb-1">
          <select
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-700 bg-white"
          >
            <option value="">All sectors</option>
            {SECTOR_PARENT_LABELS.map(label => <option key={label} value={label}>{label}</option>)}
          </select>
          <form onSubmit={onSearchSubmit} className="flex gap-2 flex-1 min-w-[220px]">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by company or source name…"
              className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-gray-700"
            />
            <button type="submit" className="text-sm font-medium px-3 py-1.5 rounded-lg bg-navy text-white">Search</button>
          </form>
        </div>
      </div>

      <ErrorBanner>{error}</ErrorBanner>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : rows.length === 0 ? (
        <div className="card p-12 text-center">
          <h3 className="font-bold text-navy mb-1">Nothing learned yet{sector ? ` for ${sector}` : ''}{search ? ` matching "${search}"` : ''}</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">As Annie researches, and as customers add companies to their own CRM, entries will show up here.</p>
        </div>
      ) : (
        <div className="card p-2 divide-y divide-gray-100">
          {rows.map(row => (
            <div key={row.id} className="flex items-center gap-2.5 py-2.5 px-2">
              <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded flex-shrink-0 ${row.kind === 'source' ? 'bg-series-2 text-white' : 'bg-series-1 text-white'}`}>
                {row.kind === 'source' ? 'Source' : 'Company'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-navy truncate">{row.value}</div>
                <div className="text-[11px] text-gray-400 truncate">
                  {row.sector} · {row.location} · found via {row.found_via || 'unknown'} · first seen {formatDate(row.first_seen_at)} · last confirmed {formatDate(row.last_confirmed_at)}
                </div>
              </div>
              <button
                onClick={() => onDelete(row)}
                disabled={deletingId === row.id}
                className="text-xs font-semibold text-status-serious hover:underline flex-shrink-0 disabled:opacity-50"
              >
                {deletingId === row.id ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ))}
          {rows.length >= 200 && (
            <p className="text-[11px] text-gray-400 px-2 pt-2">Showing the 200 most recently confirmed matches — narrow with a sector or search to see more specific results.</p>
          )}
        </div>
      )}
    </div>
  )
}

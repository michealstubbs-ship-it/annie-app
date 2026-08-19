import React, { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

const SECTOR_OPTIONS = ['Financial Services', 'Technology', 'Real Estate', 'Legal', 'Healthcare', 'Energy & Utilities', 'Professional Services', 'Private Equity', 'Consumer & Retail', 'Industrial', 'Government & Public Sector', 'Executive Search']
const MARKET_OPTIONS = ['UAE / GCC', 'United Kingdom', 'United States', 'Europe', 'Asia Pacific', 'Global']
const FUNCTION_OPTIONS = [
  { label: 'Finance & Accounting', keywords: ['finance', 'accounting', 'cfo', 'controller', 'treasury', 'fp&a'] },
  { label: 'Technology & Engineering', keywords: ['engineer', 'developer', 'cto', 'technology', 'software', 'it director', 'data'] },
  { label: 'HR & People', keywords: ['hr', 'human resources', 'people', 'talent', 'chro', 'recruit'] },
  { label: 'Strategy & Corporate Dev', keywords: ['strategy', 'corporate development', 'business development', 'chief of staff'] },
  { label: 'Sales & BD', keywords: ['sales', 'business development', 'revenue', 'account executive', 'partnerships'] },
  { label: 'Legal & Compliance', keywords: ['legal', 'counsel', 'compliance', 'regulatory'] },
  { label: 'Operations', keywords: ['operations', 'coo', 'operational'] },
  { label: 'Risk & Audit', keywords: ['risk', 'audit', 'internal audit'] },
  { label: 'Marketing', keywords: ['marketing', 'cmo', 'brand', 'communications'] },
  { label: 'Investment Management', keywords: ['investment', 'portfolio manager', 'asset management', 'fund manager'] },
  { label: 'General Management', keywords: ['ceo', 'managing director', 'general manager', 'president', 'founder'] },
]
const SENIORITY_OPTIONS = [
  { label: 'Any level', keywords: [] },
  { label: 'Manager+', keywords: ['manager', 'lead', 'head'] },
  { label: 'Director / VP+', keywords: ['director', 'vp', 'vice president', 'head of'] },
  { label: 'C-Suite / Partner / MD', keywords: ['ceo', 'cfo', 'coo', 'cto', 'chro', 'cmo', 'chief', 'partner', 'managing director', 'president', 'founder', 'md'] },
]

const DEFAULT_SECTORS = ['Financial Services', 'Technology', 'Real Estate']
const DEFAULT_MARKETS = ['UAE / GCC', 'United Kingdom']
const DEFAULT_FUNCTIONS = ['Finance & Accounting', 'Technology & Engineering', 'HR & People', 'Strategy & Corporate Dev']
const DEFAULT_SENIORITY = ['Manager+', 'Director / VP+', 'C-Suite / Partner / MD']

const SIGNAL_TYPES = [
  'Job moves & promotions', 'Company funding rounds', 'Leadership changes', 'Headcount growth signals',
  'New market expansions', 'M&A and restructuring', 'Regulatory announcements', 'Open roles at their firm',
]

function parseCSV(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
      else if (c === '\r') { /* skip */ }
      else field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(v => v && v.trim()))
}

function findColumn(headers, candidates) {
  const lower = headers.map(h => h.toLowerCase().trim())
  for (const c of candidates) {
    const idx = lower.findIndex(h => h.includes(c))
    if (idx !== -1) return idx
  }
  return -1
}

export default function LinkedInImport() {
  const { user, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [sectors, setSectors] = useState(DEFAULT_SECTORS)
  const [markets, setMarkets] = useState(DEFAULT_MARKETS)
  const [functions, setFunctions] = useState(DEFAULT_FUNCTIONS)
  const [seniority, setSeniority] = useState(DEFAULT_SENIORITY)
  const [years, setYears] = useState(5)

  const [rawContacts, setRawContacts] = useState(null) // parsed from CSV
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [done, setDone] = useState(null) // { imported, targets }

  function toggle(arr, setArr, value) {
    setArr(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value])
  }

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const rows = parseCSV(String(reader.result))
        if (rows.length < 2) throw new Error('empty')
        const headers = rows[0]
        const firstIdx = findColumn(headers, ['first name'])
        const lastIdx = findColumn(headers, ['last name'])
        const companyIdx = findColumn(headers, ['company'])
        const titleIdx = findColumn(headers, ['position', 'title'])
        const urlIdx = findColumn(headers, ['url'])
        const emailIdx = findColumn(headers, ['email'])
        const dateIdx = findColumn(headers, ['connected on'])

        const contacts = rows.slice(1).map(r => ({
          name: [r[firstIdx], r[lastIdx]].filter(Boolean).join(' ').trim(),
          company: companyIdx !== -1 ? (r[companyIdx] || '').trim() : '',
          title: titleIdx !== -1 ? (r[titleIdx] || '').trim() : '',
          linkedin_url: urlIdx !== -1 ? (r[urlIdx] || '').trim() : '',
          email: emailIdx !== -1 ? (r[emailIdx] || '').trim() : '',
          connectedOn: dateIdx !== -1 ? (r[dateIdx] || '').trim() : '',
        })).filter(c => c.name)

        if (!contacts.length) throw new Error('no rows')
        setRawContacts(contacts)
      } catch {
        setError("Couldn't read that file. Make sure it's the Connections.csv export from LinkedIn.")
        setRawContacts(null)
      }
    }
    reader.readAsText(file)
  }

  function matchesFilters(contact) {
    const text = `${contact.title} ${contact.company}`.toLowerCase()

    // Function filter — must match at least one selected function's keywords
    if (functions.length) {
      const selectedFns = FUNCTION_OPTIONS.filter(f => functions.includes(f.label))
      const fnMatch = selectedFns.some(f => f.keywords.some(k => text.includes(k)))
      if (!fnMatch) return false
    }

    // Seniority filter
    if (seniority.length && !seniority.includes('Any level')) {
      const selectedSen = SENIORITY_OPTIONS.filter(s => seniority.includes(s.label))
      const senMatch = selectedSen.some(s => s.keywords.some(k => text.includes(k)))
      if (!senMatch) return false
    }

    // Years filter
    if (contact.connectedOn) {
      const parsed = Date.parse(contact.connectedOn)
      if (!isNaN(parsed)) {
        const yearsAgo = (Date.now() - parsed) / (1000 * 60 * 60 * 24 * 365)
        if (yearsAgo > years) return false
      }
    }

    return true
  }

  const filtered = rawContacts ? rawContacts.filter(matchesFilters) : []

  async function handleImport() {
    setImporting(true)
    setError('')
    try {
      // fetch target companies from onboarding to flag hot contacts
      const { data: onboarding } = await supabase.from('onboarding').select('target_companies').eq('user_id', user.id).single()
      const targetCompanies = (onboarding?.target_companies || []).map(t => t.toLowerCase())

      const toInsert = filtered.slice(0, 1000).map(c => {
        const isTarget = targetCompanies.some(t => c.company.toLowerCase().includes(t) || t.includes(c.company.toLowerCase()))
        return {
          user_id: user.id,
          name: c.name,
          email: c.email || null,
          company: c.company || null,
          title: c.title || null,
          linkedin_url: c.linkedin_url || null,
          status: isTarget ? 'hot' : 'warm',
          tags: ['linkedin-import'],
        }
      })

      if (toInsert.length) {
        const { error: insertErr } = await supabase.from('contacts').insert(toInsert)
        if (insertErr) throw insertErr
      }

      const targetCount = toInsert.filter(c => c.status === 'hot').length

      await supabase.from('profiles').update({ linkedin_import_completed: true }).eq('id', user.id)
      await refreshProfile()

      setDone({ imported: toInsert.length, targets: targetCount })
    } catch (err) {
      setError(err.message || 'Something went wrong during import.')
    } finally {
      setImporting(false)
    }
  }

  async function handleSkip() {
    await supabase.from('profiles').update({ linkedin_import_completed: true }).eq('id', user.id)
    await refreshProfile()
    navigate('/dashboard')
  }

  if (done) {
    return (
      <div className="min-h-screen bg-navy flex flex-col items-center justify-center px-4 py-12">
        <div className="bg-white rounded-2xl p-8 shadow-2xl w-full max-w-md text-center">
          <div className="w-14 h-14 rounded-full bg-yellow-50 border-2 border-gold flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">✓</span>
          </div>
          <h2 className="text-2xl font-bold text-navy mb-2">You're all set</h2>
          <p className="text-gray-500 text-sm mb-6">
            Annie imported <span className="font-semibold text-navy">{done.imported} contacts</span>
            {done.targets > 0 && <> — <span className="font-semibold text-gold">{done.targets} at your target companies</span></>}.
            She's now monitoring all of them for BD signals.
          </p>
          <button onClick={() => navigate('/dashboard')} className="btn-primary w-full">Go to my dashboard</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-navy flex flex-col items-center justify-center px-4 py-12">
      <div className="flex items-center gap-3 mb-8">
        <svg width="40" height="40" viewBox="0 0 68 68" fill="none">
          <rect width="68" height="68" rx="16" fill="#c9a84c"/>
          <path d="M34 14 L50 54 H44 L40 44 H28 L24 54 H18 L34 14Z M34 24 L30 38 H38 L34 24Z" fill="#0d1b3e"/>
        </svg>
        <div>
          <div className="text-white font-bold text-xl leading-none">annie</div>
          <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-8 shadow-2xl w-full max-w-2xl">
        <h2 className="text-2xl font-bold text-navy mb-1">Import your LinkedIn connections</h2>
        <p className="text-gray-500 text-sm mb-6">
          Annie will only import contacts that match your BD focus — then monitor every one of them for signals that create a reason to reach out.
        </p>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>}

        {!rawContacts && (
          <div className="border-2 border-dashed border-gray-200 rounded-xl p-6 mb-6 text-center">
            <p className="text-sm text-gray-500 mb-3">
              Export your connections from LinkedIn: <span className="font-medium text-navy">Settings → Data privacy → Get a copy of your data → Connections</span>
            </p>
            <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} className="btn-primary">Upload Connections.csv</button>
            {fileName && <p className="text-xs text-gray-400 mt-2">{fileName}</p>}
          </div>
        )}

        {rawContacts && (
          <>
            <div className="mb-1">
              <div className="label mb-2">Sectors</div>
              <div className="flex flex-wrap gap-1.5">
                {SECTOR_OPTIONS.map(s => (
                  <button key={s} onClick={() => toggle(sectors, setSectors, s)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all
                      ${sectors.includes(s) ? 'border-gold bg-yellow-50 text-navy' : 'border-gray-200 text-gray-500'}`}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 mb-1">
              <div className="label mb-2">Markets</div>
              <div className="flex flex-wrap gap-1.5">
                {MARKET_OPTIONS.map(m => (
                  <button key={m} onClick={() => toggle(markets, setMarkets, m)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all
                      ${markets.includes(m) ? 'border-gold bg-yellow-50 text-navy' : 'border-gray-200 text-gray-500'}`}>
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 mb-1">
              <div className="label mb-2">Functions</div>
              <div className="flex flex-wrap gap-1.5">
                {FUNCTION_OPTIONS.map(f => (
                  <button key={f.label} onClick={() => toggle(functions, setFunctions, f.label)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all
                      ${functions.includes(f.label) ? 'border-gold bg-yellow-50 text-navy' : 'border-gray-200 text-gray-500'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 mb-1">
              <div className="label mb-2">Seniority</div>
              <div className="flex flex-wrap gap-1.5">
                {SENIORITY_OPTIONS.map(s => (
                  <button key={s.label} onClick={() => toggle(seniority, setSeniority, s.label)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all
                      ${seniority.includes(s.label) ? 'border-gold bg-yellow-50 text-navy' : 'border-gray-200 text-gray-500'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 mt-5">
              <label className="text-sm text-gray-700 min-w-[130px]">Connected in last</label>
              <input type="range" min="1" max="10" value={years} onChange={e => setYears(Number(e.target.value))} className="flex-1 accent-gold" />
              <span className="text-sm font-semibold text-navy min-w-[70px] text-right">{years} year{years === 1 ? '' : 's'}</span>
            </div>

            <div className="bg-page-bg rounded-lg px-4 py-3 mt-5">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-500">Your total connections</span>
                <span className="font-semibold text-navy">{rawContacts.length.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Matching your filters</span>
                <span className="font-semibold text-gold">{filtered.length.toLocaleString()}</span>
              </div>
            </div>

            <div className="bg-navy rounded-lg px-5 py-4 mt-4">
              <div className="text-gold text-xs font-semibold uppercase tracking-wider mb-3">Annie will monitor all imported contacts for</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {SIGNAL_TYPES.map(s => (
                  <div key={s} className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-gold mt-1.5 flex-shrink-0" />
                    <span className="text-xs text-gray-300">{s}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-3">When a signal fires, Annie drafts a personalised outreach so you always have a reason to reach out at the right moment.</p>
            </div>

            <button onClick={handleImport} disabled={importing || !filtered.length} className="btn-primary w-full mt-5">
              {importing ? 'Importing...' : `Import ${filtered.length.toLocaleString()} contacts into Annie`}
            </button>
          </>
        )}

        <button onClick={handleSkip} className="w-full mt-2 text-xs text-gray-400 hover:text-gray-600 py-1">
          Skip for now — I'll add contacts manually
        </button>
      </div>
    </div>
  )
}

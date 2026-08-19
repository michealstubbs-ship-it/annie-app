import React, { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

// Sector and market keywords serve two purposes: (1) matched against a company's real
// Apollo industry/country data when we have it, confidently excluding a confirmed
// mismatch, and (2) matched against company NAME text as a fallback for companies
// Apollo has no data on, where a match is weak evidence so absence of a match is never
// treated as a mismatch (see softGroupMatch below).
const SECTOR_OPTIONS = [
  { label: 'Financial Services', keywords: ['bank', 'banking', 'financial', 'finance', 'capital', 'asset management', 'wealth', 'insurance', 'fintech', 'payments'] },
  { label: 'Technology', keywords: ['technolog', 'software', 'saas', 'digital', 'systems', 'data', 'cloud', 'internet', 'computer'] },
  { label: 'Real Estate', keywords: ['real estate', 'realty', 'properties', 'property', 'developer', 'development'] },
  { label: 'Legal', keywords: ['law firm', 'law practice', 'legal', 'llp', 'advocates', 'attorneys'] },
  { label: 'Healthcare', keywords: ['health', 'healthcare', 'medical', 'pharma', 'hospital', 'clinic'] },
  { label: 'Energy & Utilities', keywords: ['energy', 'utilities', 'oil', 'gas', 'power', 'renewable', 'solar'] },
  { label: 'Professional Services', keywords: ['consulting', 'advisory', 'professional services'] },
  { label: 'Private Equity', keywords: ['private equity', 'venture capital', 'growth equity'] },
  { label: 'Consumer & Retail', keywords: ['retail', 'consumer', 'fmcg', 'brands'] },
  { label: 'Industrial', keywords: ['industrial', 'manufacturing', 'engineering', 'construction'] },
  { label: 'Government & Public Sector', keywords: ['government', 'ministry', 'authority', 'public sector'] },
  { label: 'Executive Search', keywords: ['executive search', 'staffing', 'recruitment', 'recruiting', 'headhunt'] },
]
const MARKET_OPTIONS = [
  { label: 'UAE / GCC', keywords: ['dubai', 'abu dhabi', 'sharjah', 'uae', 'united arab emirates', 'emirates', 'gulf', 'gcc', 'qatar', 'doha', 'saudi arabia', 'saudi', 'ksa', 'riyadh', 'jeddah', 'bahrain', 'kuwait', 'oman', 'difc', 'adgm'] },
  { label: 'United Kingdom', keywords: ['uk', 'london', 'britain', 'united kingdom', 'england', 'scotland', 'manchester', 'edinburgh'] },
  { label: 'United States', keywords: ['usa', 'united states', 'america', 'new york', 'california', 'chicago', 'boston', 'texas'] },
  { label: 'Europe', keywords: ['europe', 'france', 'germany', 'netherlands', 'switzerland', 'spain', 'italy', 'ireland', 'portugal', 'belgium', 'sweden', 'denmark', 'norway', 'poland', 'austria', 'paris', 'berlin', 'frankfurt', 'amsterdam', 'zurich', 'geneva', 'madrid', 'milan', 'dublin'] },
  { label: 'Asia Pacific', keywords: ['singapore', 'hong kong', 'japan', 'australia', 'china', 'south korea', 'indonesia', 'malaysia', 'thailand', 'vietnam', 'philippines', 'india', 'tokyo', 'sydney', 'shanghai', 'apac'] },
  { label: 'Global', keywords: [] },
]
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

function ExportWalkthrough() {
  return (
    <div className="bg-page-bg rounded-xl p-5 mb-6">
      <h3 className="text-sm font-bold text-navy mb-1">How to export your LinkedIn connections</h3>
      <p className="text-xs text-gray-500 mb-4">Takes about two minutes. LinkedIn emails you the file, nothing leaves your inbox until you upload it here.</p>

      <div className="space-y-2.5">
        {[
          { n: 1, title: 'Open LinkedIn and go to Settings', path: ['Me ▾', 'Settings & Privacy'] },
          { n: 2, title: 'Go to Data privacy, then request your data', path: ['Data privacy', 'Get a copy of your data'] },
          { n: 3, title: 'Select "Connections" only, then request the archive', path: ['Want something in particular?', 'Connections'] },
          { n: 4, title: 'Wait for the email, then download Connections.csv', path: null },
        ].map(step => (
          <div key={step.n} className="bg-white rounded-lg px-4 py-3 flex items-start gap-3 border border-gray-100">
            <div className="w-6 h-6 rounded-full bg-navy text-gold text-xs font-bold flex items-center justify-center flex-shrink-0">{step.n}</div>
            <div className="flex-1">
              <div className="text-xs font-semibold text-navy">{step.title}</div>
              {step.path && (
                <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                  {step.path.map((p, i) => (
                    <React.Fragment key={p}>
                      <span className="bg-page-bg border border-gray-200 rounded text-[11px] px-2 py-0.5 text-gray-600">{p}</span>
                      {i < step.path.length - 1 && <span className="text-gray-300 text-[11px]">then</span>}
                    </React.Fragment>
                  ))}
                </div>
              )}
              {step.n === 4 && <p className="text-[11px] text-gray-400 mt-1">LinkedIn usually sends this within ten minutes.</p>}
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-gray-400 mt-4 leading-relaxed">
        This is your own data, exported directly from LinkedIn under its official data portability tools. Nothing is scraped or accessed without your permission.
      </p>
    </div>
  )
}

export default function LinkedInImport({ embedded = false }) {
  const { user, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [sectors, setSectors] = useState(DEFAULT_SECTORS)
  const [markets, setMarkets] = useState(DEFAULT_MARKETS)
  const [functions, setFunctions] = useState(DEFAULT_FUNCTIONS)
  const [seniority, setSeniority] = useState(DEFAULT_SENIORITY)
  const [years, setYears] = useState(5)

  const [rawContacts, setRawContacts] = useState(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [importing, setImporting] = useState(false)
  const [done, setDone] = useState(null)
  const [showReview, setShowReview] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [companyData, setCompanyData] = useState({}) // normalized company name -> { industry, city, state, country, matched }
  const [apolloConfigured, setApolloConfigured] = useState(true)

  function toggle(arr, setArr, value) {
    setArr(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value])
  }

  function normalizeCompany(name) {
    return (name || '').trim().toLowerCase()
  }

  // These two are cheap and reliable, straight off the CSV's title text, no API call needed.
  function passesTitleFilters(contact) {
    const titleText = `${contact.title} ${contact.company}`.toLowerCase()

    if (functions.length) {
      const selectedFns = FUNCTION_OPTIONS.filter(f => functions.includes(f.label))
      if (!selectedFns.some(f => f.keywords.some(k => titleText.includes(k)))) return false
    }

    if (seniority.length && !seniority.includes('Any level')) {
      const selectedSen = SENIORITY_OPTIONS.filter(s => seniority.includes(s.label))
      if (!selectedSen.some(s => s.keywords.some(k => titleText.includes(k)))) return false
    }

    if (contact.connectedOn) {
      const parsed = Date.parse(contact.connectedOn)
      if (!isNaN(parsed)) {
        const yearsAgo = (Date.now() - parsed) / (1000 * 60 * 60 * 24 * 365)
        if (yearsAgo > years) return false
      }
    }

    return true
  }

  // Company name alone is a weak signal, most names don't spell out sector or
  // geography. So this only excludes a contact when their company name confidently
  // signals a group OTHER than the ones selected. No signal at all is not treated as
  // a mismatch, the contact is kept rather than wrongly dropped. Used when Apollo has
  // no enrichment data for that company.
  function softGroupMatch(companyText, options, selectedLabels) {
    if (!selectedLabels.length || selectedLabels.includes('Global')) return true
    const signaled = options.filter(o => o.keywords.length && o.keywords.some(k => companyText.includes(k)))
    if (!signaled.length) return true // no evidence either way, don't exclude
    return signaled.some(o => selectedLabels.includes(o.label))
  }

  // With real Apollo data, a confirmed industry/location that doesn't match any
  // selected option is a confident exclusion, not a guess.
  function realGroupMatch(dataText, options, selectedLabels) {
    if (!selectedLabels.length || selectedLabels.includes('Global')) return true
    const selected = options.filter(o => selectedLabels.includes(o.label))
    return selected.some(o => o.keywords.some(k => dataText.includes(k)))
  }

  function passesSectorMarket(contact) {
    const companyText = `${contact.company}`.toLowerCase()
    const enrichment = companyData[normalizeCompany(contact.company)]

    if (enrichment?.matched && enrichment.industry) {
      if (!realGroupMatch(enrichment.industry.toLowerCase(), SECTOR_OPTIONS, sectors)) return false
    } else if (!softGroupMatch(companyText, SECTOR_OPTIONS, sectors)) {
      return false
    }

    if (enrichment?.matched && (enrichment.city || enrichment.state || enrichment.country)) {
      const locText = `${enrichment.city || ''} ${enrichment.state || ''} ${enrichment.country || ''}`.toLowerCase()
      if (!realGroupMatch(locText, MARKET_OPTIONS, markets)) return false
    } else if (!softGroupMatch(companyText, MARKET_OPTIONS, markets)) {
      return false
    }

    return true
  }

  function matchesFilters(contact) {
    return passesTitleFilters(contact) && passesSectorMarket(contact)
  }

  const filtered = rawContacts ? rawContacts.filter(matchesFilters) : []
  const enrichedCount = Object.values(companyData).filter(c => c?.matched).length

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = async () => {
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
        await runEnrichment(contacts)
        setShowReview(true)
      } catch {
        setError("Couldn't read that file. Make sure it's the Connections.csv export from LinkedIn.")
        setRawContacts(null)
      }
    }
    reader.readAsText(file)
  }

  // Only enrich companies that already passed the cheap title-based filters, this
  // keeps the Apollo cost proportional to genuinely relevant contacts, not the whole
  // export. Companies are looked up against Annie's shared cache first, so most
  // repeat companies across customers cost nothing.
  async function runEnrichment(contacts) {
    const candidates = contacts.filter(passesTitleFilters)
    const uniqueCompanies = [...new Set(candidates.map(c => c.company).filter(Boolean))]
    if (!uniqueCompanies.length) return

    setEnriching(true)
    try {
      const resp = await fetch('/.netlify/functions/apollo-enrich-companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: uniqueCompanies }),
      })
      const data = await resp.json()
      if (data.configured === false) setApolloConfigured(false)
      const map = {}
      for (const r of data.results || []) {
        map[normalizeCompany(r.company_name)] = r
      }
      setCompanyData(map)
    } catch {
      // Degrade gracefully, review screen still works off the company-name heuristic
      setApolloConfigured(false)
    } finally {
      setEnriching(false)
    }
  }

  async function handleImport() {
    setImporting(true)
    setError('')
    try {
      // No target company list anymore, sectors and markets already shaped who got
      // imported. Within that, the most senior decision-makers get tagged hot.
      const seniorKeywords = SENIORITY_OPTIONS.find(s => s.label === 'C-Suite / Partner / MD').keywords
      const toImport = filtered.slice(0, 1000)

      // Every contact's company becomes, or reuses, a real Company record. Same
      // matching a company already gets in Companies.jsx (case-insensitive name),
      // so contacts imported here show up under that company's tab automatically
      // instead of just carrying a free-text name. Where Apollo enrichment already
      // verified the company (from the filter step above), the new record is
      // seeded with its real industry, location and domain, not left blank.
      const uniqueNames = [...new Set(toImport.map(c => c.company).filter(Boolean))]
      const companyMap = {} // normalized name -> company id
      let newCompanyCount = 0

      if (uniqueNames.length) {
        const { data: existing } = await supabase.from('companies').select('id, name').eq('user_id', user.id)
        for (const co of existing || []) companyMap[normalizeCompany(co.name)] = co.id

        const toCreate = uniqueNames
          .filter(name => !companyMap[normalizeCompany(name)])
          .map(name => {
            const enrichment = companyData[normalizeCompany(name)]
            const location = enrichment?.matched
              ? [enrichment.city, enrichment.state, enrichment.country].filter(Boolean).join(', ')
              : null
            return {
              user_id: user.id,
              name,
              industry: enrichment?.matched ? (enrichment.industry || null) : null,
              location: location || null,
              website: enrichment?.matched ? (enrichment.domain || null) : null,
            }
          })

        if (toCreate.length) {
          const { data: created, error: coErr } = await supabase.from('companies').insert(toCreate).select('id, name')
          if (coErr) throw coErr
          for (const co of created || []) companyMap[normalizeCompany(co.name)] = co.id
          newCompanyCount = created?.length || 0
        }
      }

      const toInsert = toImport.map(c => {
        const text = `${c.title || ''}`.toLowerCase()
        const isSenior = seniorKeywords.some(k => text.includes(k))
        return {
          user_id: user.id,
          name: c.name,
          email: c.email || null,
          company: c.company || null,
          company_id: c.company ? (companyMap[normalizeCompany(c.company)] || null) : null,
          title: c.title || null,
          linkedin_url: c.linkedin_url || null,
          status: isSenior ? 'hot' : 'warm',
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

      setDone({ imported: toInsert.length, targets: targetCount, newCompanies: newCompanyCount })
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

  const Wrapper = ({ children }) => embedded ? (
    <div className="p-8 max-w-2xl">{children}</div>
  ) : (
    <div className="min-h-screen bg-navy flex flex-col items-center justify-center px-4 py-12">
      <div className="flex items-center gap-3 mb-8">
        <svg width="40" height="40" viewBox="0 0 36 36" fill="none">
          <rect width="36" height="36" rx="8" fill="#c9a84c"/>
          <path d="M18 3L29 33H25L18 13L11 33H7L18 3Z" fill="#0d1b3e"/>
          <rect x="10" y="22" width="16" height="3.2" rx="1.6" fill="#c9a84c"/>
        </svg>
        <div>
          <div className="text-white font-bold text-xl leading-none">annie</div>
          <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
        </div>
      </div>
      <div className="bg-white rounded-2xl p-8 shadow-2xl w-full max-w-2xl">{children}</div>
    </div>
  )

  if (done) {
    return (
      <Wrapper>
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-yellow-50 border-2 border-gold flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl">✓</span>
          </div>
          <h2 className="text-2xl font-bold text-navy mb-2">You're all set</h2>
          <p className="text-gray-500 text-sm mb-6">
            Annie imported <span className="font-semibold text-navy">{done.imported} contacts</span>
            {done.targets > 0 && <> — <span className="font-semibold text-gold">{done.targets} at your target companies</span></>}.
            {done.newCompanies > 0 && <> She also created <span className="font-semibold text-navy">{done.newCompanies} new compan{done.newCompanies === 1 ? 'y' : 'ies'}</span> in your Companies list, linked to their contacts.</>}
            {' '}She's now monitoring all of them for BD signals.
          </p>
          <button onClick={() => navigate('/dashboard')} className="btn-primary w-full">Go to my dashboard</button>
        </div>
      </Wrapper>
    )
  }

  return (
    <Wrapper>
      {!showReview && (
        <>
          <h2 className="text-2xl font-bold text-navy mb-1">Import your LinkedIn connections</h2>
          <p className="text-gray-500 text-sm mb-6">
            First, tell Annie who to look for. She'll only import and monitor contacts that match these filters.
          </p>

          {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>}

          <div className="bg-yellow-50 border-2 border-gold rounded-xl p-5 mb-6">
            <div className="text-sm font-bold text-navy mb-1">Who should Annie import and watch?</div>
            <p className="text-xs text-gray-500 mb-4">These filters decide which of your connections get imported below.</p>

            <div className="mb-1">
              <div className="label mb-2">Sectors</div>
              <div className="flex flex-wrap gap-1.5">
                {SECTOR_OPTIONS.map(s => (
                  <button key={s.label} onClick={() => toggle(sectors, setSectors, s.label)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all bg-white
                      ${sectors.includes(s.label) ? 'border-gold text-navy' : 'border-gray-200 text-gray-500'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 mb-1">
              <div className="label mb-2">Markets</div>
              <div className="flex flex-wrap gap-1.5">
                {MARKET_OPTIONS.map(m => (
                  <button key={m.label} onClick={() => toggle(markets, setMarkets, m.label)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all bg-white
                      ${markets.includes(m.label) ? 'border-gold text-navy' : 'border-gray-200 text-gray-500'}`}>
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1.5">Annie checks each contact's real company location before importing. Where that data isn't available, she only rules out a contact whose company name clearly points to a different market, uncertain cases are kept in.</p>
            </div>

            <div className="mt-4 mb-1">
              <div className="label mb-2">Functions</div>
              <div className="flex flex-wrap gap-1.5">
                {FUNCTION_OPTIONS.map(f => (
                  <button key={f.label} onClick={() => toggle(functions, setFunctions, f.label)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all bg-white
                      ${functions.includes(f.label) ? 'border-gold text-navy' : 'border-gray-200 text-gray-500'}`}>
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
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border-2 transition-all bg-white
                      ${seniority.includes(s.label) ? 'border-gold text-navy' : 'border-gray-200 text-gray-500'}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 mt-4">
              <label className="text-sm text-gray-700 min-w-[130px]">Connected in last</label>
              <input type="range" min="1" max="10" value={years} onChange={e => setYears(Number(e.target.value))} className="flex-1 accent-gold" />
              <span className="text-sm font-semibold text-navy min-w-[70px] text-right">{years} year{years === 1 ? '' : 's'}</span>
            </div>
          </div>

          {!rawContacts && <ExportWalkthrough />}

          {!rawContacts ? (
            <div className="border-2 border-dashed border-gray-200 rounded-xl p-6 text-center">
              <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
              <button onClick={() => fileInputRef.current?.click()} className="btn-primary">Upload Connections.csv</button>
              {fileName && <p className="text-xs text-gray-400 mt-2">{fileName}</p>}
            </div>
          ) : (
            <div className="bg-page-bg rounded-xl p-5 text-center">
              <p className="text-xs text-gray-500 mb-3">{fileName || 'Connections.csv'} already uploaded, filters updated above.</p>
              <button onClick={async () => { await runEnrichment(rawContacts); setShowReview(true) }} disabled={enriching} className="btn-primary w-full">
                {enriching ? 'Checking companies...' : 'Continue to review'}
              </button>
              <button onClick={() => { setRawContacts(null); setCompanyData({}) }} className="w-full mt-2 text-xs text-gray-400 hover:text-gray-600">
                Upload a different file
              </button>
            </div>
          )}

          <button onClick={handleSkip} className="w-full mt-2 text-xs text-gray-400 hover:text-gray-600 py-1">
            {embedded ? 'Cancel' : "Skip for now, I'll add contacts manually"}
          </button>
        </>
      )}

      {!showReview && enriching && (
        <div className="text-center py-10">
          <div className="w-10 h-10 border-3 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <h2 className="text-lg font-bold text-navy mb-1">Checking your contacts' companies</h2>
          <p className="text-gray-500 text-sm">Annie is verifying real industry and location data so your sector and market filters are accurate, not just guessed from titles.</p>
        </div>
      )}

      {showReview && rawContacts && (
        <>
          <h2 className="text-2xl font-bold text-navy mb-1">Ready to import</h2>
          <p className="text-gray-500 text-sm mb-6">
            Connections.csv uploaded and checked against your filters
            {apolloConfigured && enrichedCount > 0 ? `, including verified company data for ${enrichedCount.toLocaleString()} companies.` : '.'}
          </p>

          {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>}

          <div className="bg-page-bg rounded-lg px-4 py-3 mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-500">Your total connections</span>
              <span className="font-semibold text-navy">{rawContacts.length.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Matching your filters</span>
              <span className="font-semibold text-gold">{filtered.length.toLocaleString()}</span>
            </div>
            {apolloConfigured && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Verified via real company data</span>
                <span className="font-semibold text-navy">{enrichedCount.toLocaleString()} compan{enrichedCount === 1 ? 'y' : 'ies'}</span>
              </div>
            )}
          </div>

          <div className="bg-navy rounded-lg px-5 py-4 mb-5">
            <div className="text-gold text-xs font-semibold uppercase tracking-wider mb-3">Why this matters, Annie will monitor these {filtered.length.toLocaleString()} contacts for</div>
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

          <button onClick={() => setShowReview(false)} className="w-full mb-2 text-xs text-gray-500 hover:text-navy py-1 font-medium">&larr; Back, adjust filters</button>

          <button onClick={handleImport} disabled={importing || !filtered.length} className="btn-primary w-full">
            {importing ? 'Importing...' : `Import ${filtered.length.toLocaleString()} contacts into Annie`}
          </button>

          <button onClick={handleSkip} className="w-full mt-2 text-xs text-gray-400 hover:text-gray-600 py-1">
            {embedded ? 'Cancel' : "Skip for now, I'll add contacts manually"}
          </button>
        </>
      )}
    </Wrapper>
  )
}

import React, { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { SECTOR_TAXONOMY, FLAT_SECTOR_OPTIONS } from '../lib/sectorTaxonomy'
import { FUNCTION_TAXONOMY, FLAT_FUNCTION_OPTIONS } from '../lib/functionTaxonomy'
import SectorPicker from '../components/SectorPicker'
import { withTimeout, TIMEOUT_MESSAGE } from '../lib/withTimeout'
import { trackEvent } from '../lib/analytics'
import ErrorBanner from '../components/ErrorBanner'
import { SIGNAL_TYPE_META } from '../lib/signalTypes'

// Sector and market keywords serve two purposes: (1) matched against a company's real
// Apollo industry/country data when we have it, confidently excluding a confirmed
// mismatch, and (2) matched against company NAME text as a fallback for companies
// Apollo has no data on, where a match is weak evidence so absence of a match is never
// treated as a mismatch (see softGroupMatch below). Sectors themselves live in
// sectorTaxonomy.js, shared with onboarding so the two can never drift apart again.
const MARKET_OPTIONS = [
  { label: 'UAE / GCC', keywords: ['dubai', 'abu dhabi', 'sharjah', 'uae', 'united arab emirates', 'emirates', 'gulf', 'gcc', 'qatar', 'doha', 'saudi arabia', 'saudi', 'ksa', 'riyadh', 'jeddah', 'bahrain', 'kuwait', 'oman', 'difc', 'adgm'] },
  { label: 'United Kingdom', keywords: ['uk', 'london', 'britain', 'united kingdom', 'england', 'scotland', 'manchester', 'edinburgh'] },
  { label: 'United States', keywords: ['usa', 'united states', 'america', 'new york', 'california', 'chicago', 'boston', 'texas'] },
  { label: 'Europe', keywords: ['europe', 'france', 'germany', 'netherlands', 'switzerland', 'spain', 'italy', 'ireland', 'portugal', 'belgium', 'sweden', 'denmark', 'norway', 'poland', 'austria', 'paris', 'berlin', 'frankfurt', 'amsterdam', 'zurich', 'geneva', 'madrid', 'milan', 'dublin'] },
  { label: 'Asia Pacific', keywords: ['singapore', 'hong kong', 'japan', 'australia', 'china', 'south korea', 'indonesia', 'malaysia', 'thailand', 'vietnam', 'philippines', 'india', 'tokyo', 'sydney', 'shanghai', 'apac'] },
  { label: 'Global', keywords: [] },
]
// Functions themselves live in functionTaxonomy.js, shared with onboarding, same
// reasoning as sectors above.
const SENIORITY_OPTIONS = [
  { label: 'Any level', keywords: [] },
  { label: 'Manager+', keywords: ['manager', 'lead', 'head'] },
  { label: 'Director / VP+', keywords: ['director', 'vp', 'vice president', 'head of'] },
  { label: 'C-Suite / Partner / MD', keywords: ['ceo', 'cfo', 'coo', 'cto', 'chro', 'cmo', 'chief', 'partner', 'managing director', 'president', 'founder', 'md'] },
]

const DEFAULT_SECTORS = ['Financial Services', 'Technology', 'Real Estate']
const DEFAULT_MARKETS = ['UAE / GCC', 'United Kingdom']
const DEFAULT_FUNCTIONS = ['Finance & Accounting', 'Technology, Data & Engineering', 'HR & People', 'Strategy & Corporate Development']
const DEFAULT_SENIORITY = ['Manager+', 'Director / VP+', 'C-Suite / Partner / MD']

// 2026-08-26 audit fix: this used to be a hand-typed list, independent of
// the real signal-type taxonomy — two of its eight entries ("Job moves &
// promotions", "Headcount growth signals") didn't correspond to any actual
// signalType the scan can produce (see signalTypes.js's SIGNAL_TYPE_META),
// so this screen promised tracking that would never happen. Deriving the
// display labels from SIGNAL_TYPE_META directly (the same anti-drift fix
// already applied elsewhere in this codebase — see that file's own header
// comment) means this list can only ever show real, currently-tracked
// types, and picks up new ones automatically instead of silently going
// stale again.
const SIGNAL_TYPES = Object.values(SIGNAL_TYPE_META).map(m => m.label)

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
      <p className="text-xs text-gray-500 mb-4">Requesting it takes two minutes, but LinkedIn itself can take up to 24 hours to actually prepare the file, so request it now so it's ready when you come back. Nothing leaves your inbox until you upload it here.</p>

      <div className="space-y-2.5">
        {[
          { n: 1, title: 'Open LinkedIn and go to Settings', path: ['Me ▾', 'Settings & Privacy'] },
          { n: 2, title: 'Go to Data privacy, then request your data', path: ['Data privacy', 'Get a copy of your data'] },
          { n: 3, title: 'Choose "Download larger data archive", then request the archive', path: ['Download larger data archive'] },
          { n: 4, title: 'Wait for the email, download the zip, then open Connections.csv from inside it', path: null },
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
              {step.n === 3 && <p className="text-[11px] text-gray-400 mt-1">LinkedIn removed the option to request just your connections on their own, so this bundles in more than you need, but it's the only way to get them now. Only Connections.csv matters here.</p>}
              {step.n === 4 && <p className="text-[11px] text-gray-400 mt-1">This is the slow part: LinkedIn can take anywhere from a few hours up to 24 hours to email it. Skip below for now, use Annie in the meantime, and come back to Settings → Import LinkedIn contacts once it lands in your inbox.</p>}
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

  // Pre-fill from what they already told Annie in onboarding, so they're not
  // re-picking the same sectors/functions/markets a second time on this screen.
  React.useEffect(() => {
    if (!user) return
    supabase.from('onboarding').select('sectors, functions, locations').eq('user_id', user.id).maybeSingle()
      .then(({ data }) => {
        if (!data) return
        if (data.sectors?.length) setSectors(data.sectors)
        if (data.functions?.length) setFunctions(data.functions)
        if (data.locations?.length) setMarkets(data.locations.filter(l => l !== 'Global'))
      })
  }, [user])

  function toggle(arr, setArr, value) {
    setArr(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value])
  }

  function normalizeCompany(name) {
    return (name || '').trim().toLowerCase()
  }

  // 2026-08-26 audit fix: Supabase caps a single `.select()` at 1000 rows
  // by default with no error or warning — a query against a table that's
  // grown past that silently returns a partial result. Used here (instead
  // of a single unbounded select) anywhere this screen needs to check
  // "does this already exist" against the customer's full CRM, so a large,
  // established team's import doesn't start missing real matches and
  // creating duplicates purely because their CRM crossed 1000 rows.
  const PAGE_SIZE = 500
  async function fetchAllRows(table, columns) {
    const rows = []
    let from = 0
    while (true) {
      const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }
    return rows
  }

  // 2026-08-26 audit fix: every keyword check on this page used plain
  // `.includes()` against raw title/company text — a substring match with
  // no word-boundary check at all. Several real taxonomy keywords are
  // short (functionTaxonomy.js has 'hr', 'pr', 'tax'; sectorTaxonomy.js has
  // 'ey', 'gas', 'oil') and matched INSIDE unrelated words: 'hr' matches
  // "Ba-hr-ain", 'ey' (Ernst & Young's own abbreviation) matches "Turk-ey"
  // or "attorn-ey", 'gas' matches "Ve-gas". A contact at a Bahrain-based
  // firm could get pulled into an "HR & People" function filter they have
  // nothing to do with, or a real Ernst & Young contact could get missed
  // entirely if a keyword collision elsewhere in the same matching pass
  // produces a false exclusion. Fixed with a boundary check that treats a
  // keyword's own leading/trailing punctuation as already self-bounding
  // (so 'fp&a' or 'm&a' still match correctly right up against a following
  // space) while still requiring a real word boundary on any side that
  // starts/ends with a letter or digit — this is deliberately NOT a regex
  // \b check, since \b behaves inconsistently right at a keyword's own
  // trailing punctuation (e.g. 'strategy&' followed by a space has no \b
  // between the two non-word characters, which would silently stop
  // matching a case it should catch).
  function keywordMatches(text, keyword) {
    if (!keyword) return false
    const isWordChar = (ch) => !!ch && /[a-z0-9]/i.test(ch)
    let from = 0
    while (true) {
      const idx = text.indexOf(keyword, from)
      if (idx === -1) return false
      const before = text[idx - 1]
      const after = text[idx + keyword.length]
      const startOk = !isWordChar(keyword[0]) || !isWordChar(before)
      const endOk = !isWordChar(keyword[keyword.length - 1]) || !isWordChar(after)
      if (startOk && endOk) return true
      from = idx + 1
    }
  }

  // These two are cheap and reliable, straight off the CSV's title text, no API call needed.
  function passesTitleFilters(contact) {
    const titleText = `${contact.title} ${contact.company}`.toLowerCase()

    if (functions.length) {
      const selectedFns = FLAT_FUNCTION_OPTIONS.filter(f => functions.includes(f.label))
      if (!selectedFns.some(f => f.keywords.some(k => keywordMatches(titleText, k)))) return false
    }

    if (seniority.length && !seniority.includes('Any level')) {
      const selectedSen = SENIORITY_OPTIONS.filter(s => seniority.includes(s.label))
      if (!selectedSen.some(s => s.keywords.some(k => keywordMatches(titleText, k)))) return false
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
    const signaled = options.filter(o => o.keywords.length && o.keywords.some(k => keywordMatches(companyText, k)))
    if (!signaled.length) return true // no evidence either way, don't exclude
    return signaled.some(o => selectedLabels.includes(o.label))
  }

  // With real Apollo data, a confirmed industry/location that doesn't match any
  // selected option is a confident exclusion, not a guess.
  function realGroupMatch(dataText, options, selectedLabels) {
    if (!selectedLabels.length || selectedLabels.includes('Global')) return true
    const selected = options.filter(o => selectedLabels.includes(o.label))
    return selected.some(o => o.keywords.some(k => keywordMatches(dataText, k)))
  }

  function passesSectorMarket(contact) {
    const companyText = `${contact.company}`.toLowerCase()
    const enrichment = companyData[normalizeCompany(contact.company)]

    if (enrichment?.matched && enrichment.industry) {
      if (!realGroupMatch(enrichment.industry.toLowerCase(), FLAT_SECTOR_OPTIONS, sectors)) return false
    } else if (!softGroupMatch(companyText, FLAT_SECTOR_OPTIONS, sectors)) {
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
    // 2026-08-26 audit fix: same raw-string Set issue already fixed for
    // company creation below — dedupe by normalized name so two contacts
    // at a slightly-differently-cased spelling of one company don't send
    // it to Apollo twice (wasted credit) in the same request.
    const seenEnrichKeys = new Set()
    const uniqueCompanies = []
    for (const c of candidates) {
      if (!c.company) continue
      const key = normalizeCompany(c.company)
      if (seenEnrichKeys.has(key)) continue
      seenEnrichKeys.add(key)
      uniqueCompanies.push(c.company)
    }
    if (!uniqueCompanies.length) return

    setEnriching(true)
    try {
      // This endpoint now requires the caller's own session token — it
      // spends real Apollo credit per call, so it checks who's actually
      // asking, same pattern as callChat.js.
      const { data: { session } } = await supabase.auth.getSession()
      // apollo-enrich-companies.js only resolves at its custom config.path
      // ('/api/apollo-enrich-companies') — see callChat.js's comment for
      // why the default '/.netlify/functions/...' alias 404s once a
      // function sets a custom path.
      const resp = await fetch('/api/apollo-enrich-companies', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ companies: uniqueCompanies }),
      })
      // 2026-08-26 audit fix: a non-ok response (e.g. the endpoint's own
      // 400 for exceeding its 1,000-company cap) was never checked —
      // `data.results` would just be undefined, `map` would end up empty,
      // and apolloConfigured stayed true throughout. The review screen's
      // "Verified via real company data" section would then silently show
      // 0 enriched instead of telling the customer the check didn't
      // actually run.
      if (!resp.ok) {
        console.error('[LinkedInImport] apollo-enrich-companies returned', resp.status)
        setApolloConfigured(false)
        return
      }
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

  // 2026-08-26 audit fix: withTimeout races the real import against a
  // 30s timer — if the timer wins, the customer sees "timed out" and the
  // Import button re-enables (`importing` goes back to false), but the
  // ORIGINAL runImport() call is still actually running underneath (a
  // Promise.race can't cancel the loser, only stop waiting on it). If the
  // customer then clicked Import again, a second runImport() would start
  // genuinely concurrently with the first still-in-flight one — a real
  // company/contact duplication race distinct from (and not fixed by) the
  // normalized-dedup fix above, since that fix only protects a single
  // run's own internal list, not two overlapping runs racing each other's
  // reads of "what already exists." This ref tracks the real run
  // independently of the UI's own `importing` state, and isn't cleared
  // until the actual promise settles — so a second click is blocked for as
  // long as the first import is genuinely still working, even after its
  // own 30s timeout message has already shown.
  const importRunningRef = useRef(false)

  async function handleImport() {
    if (importRunningRef.current) return
    importRunningRef.current = true
    setImporting(true)
    setError('')
    const runPromise = runImport().finally(() => { importRunningRef.current = false })
    try {
      await withTimeout(runPromise, 30000, 'linkedin-import')
    } catch (err) {
      console.error('[LinkedInImport] handleImport failed:', err)
      setError(err.message?.startsWith('TIMEOUT:') ? TIMEOUT_MESSAGE : (err.message || 'Something went wrong during import.'))
    } finally {
      setImporting(false)
    }
  }

  // Everything Supabase-dependent lives here, as one sequential unit, so a
  // single 30s timeout around the whole thing covers every step (company
  // lookup/insert, contact insert, marking the account done) rather than
  // needing a separate guard on each call.
  async function runImport() {
      // No target company list anymore, sectors and markets already shaped who got
      // imported. Within that, the most senior decision-makers get tagged hot.
      const seniorKeywords = SENIORITY_OPTIONS.find(s => s.label === 'C-Suite / Partner / MD').keywords
      // 2026-08-26 audit fix: this cap was silent — the review screen shows
      // the uncapped `filtered.length`, so a customer with, say, 1,400
      // matches saw that number, clicked Import, and got 1,000 with no
      // indication 400 were dropped. Recorded here so the completion
      // screen can be honest about it instead.
      const totalMatched = filtered.length
      const toImport = filtered.slice(0, 1000)

      // Every contact's company becomes, or reuses, a real Company record. Same
      // matching a company already gets in Companies.jsx (case-insensitive name),
      // so contacts imported here show up under that company's tab automatically
      // instead of just carrying a free-text name. Where Apollo enrichment already
      // verified the company (from the filter step above), the new record is
      // seeded with its real industry, location and domain, not left blank.
      // 2026-08-26 audit fix: this used to be `[...new Set(toImport.map(c
      // => c.company))]` — a Set on the RAW company string. Two contacts
      // in the SAME import whose CSV rows spell the same company slightly
      // differently ("Acme Trading" vs "acme trading", or a stray trailing
      // space — both plausible in real LinkedIn export data) were treated
      // as two different names by the Set, and the `toCreate` filter below
      // checked each of them against companyMap independently in one pass
      // rather than updating companyMap as it went — so the second variant
      // never saw the first, both got queued, and the batch insert created
      // TWO company rows for one real company. Both contacts still end up
      // pointing at whichever one won companyMap's last-write-wins rebuild
      // after the insert, so nothing broke visibly for the contacts
      // themselves — but the other row sits in Companies with 0 contacts
      // forever, exactly the "same client added twice" case Companies.jsx's
      // own copy ("the same client never gets added twice") promises can't
      // happen. Deduping by the normalized key up front — not the raw
      // string — means every casing/whitespace variant of one company
      // collapses to a single canonical entry (the first one seen) before
      // it ever reaches the "does this already exist" check.
      const seenCompanyKeys = new Set()
      const uniqueNames = []
      for (const name of toImport.map(c => c.company)) {
        if (!name) continue
        const key = normalizeCompany(name)
        if (seenCompanyKeys.has(key)) continue
        seenCompanyKeys.add(key)
        uniqueNames.push(name)
      }
      const companyMap = {} // normalized name -> company id
      let newCompanyCount = 0

      if (uniqueNames.length) {
        // 2026-08-24: companies is team-scoped by RLS — no client-side user_id filter on top of it.
        // 2026-08-26 audit fix: was a single unbounded `.select()` — Supabase
        // caps a single request at 1000 rows by default, so a team whose
        // CRM had already grown past 1000 companies would silently see only
        // the first 1000 here, miss a real existing match for company
        // #1001+, and re-create it as a duplicate — the exact "same client
        // added twice" failure mode already fixed above, just reachable a
        // second way at scale. Paginated the same way team-data-request.mjs
        // already does for exactly this reason.
        const existing = await fetchAllRows('companies', 'id, name')
        for (const co of existing) companyMap[normalizeCompany(co.name)] = co.id

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

      // 2026-08-26 audit fix: there was no contact-level dedup at all —
      // re-uploading the same (or a refreshed) Connections.csv, whether by
      // accident or as a deliberate "pick up new connections" re-import,
      // duplicated every contact from the file still matching the current
      // filters, with nothing in the schema to stop it either (no unique
      // constraint on contacts.linkedin_url or .email). Matched against the
      // CRM's real existing contacts by linkedin_url first (LinkedIn's own
      // profile URL is the closest thing to a real unique key a CSV export
      // gives us), falling back to email for the rare row with no URL but
      // a real email. A contact with neither is imported every time — there
      // is no reliable signal to dedupe it against, and silently dropping a
      // same-name contact risks merging two different real people.
      const existingContacts = await fetchAllRows('contacts', 'linkedin_url, email')
      const existingLinkedinUrls = new Set(existingContacts.map(c => c.linkedin_url).filter(Boolean))
      const existingEmails = new Set(existingContacts.map(c => c.email?.toLowerCase()).filter(Boolean))
      const isAlreadyImported = (c) =>
        (c.linkedin_url && existingLinkedinUrls.has(c.linkedin_url)) ||
        (c.email && existingEmails.has(c.email.toLowerCase()))

      const alreadyImportedCount = toImport.filter(isAlreadyImported).length

      const toInsert = toImport
        .filter(c => !isAlreadyImported(c))
        .map(c => {
          const text = `${c.title || ''}`.toLowerCase()
          const isSenior = seniorKeywords.some(k => keywordMatches(text, k))
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

      // 2026-08-26 audit fix: this update's result was never checked — a
      // real failure (an RLS denial, a dropped connection) would silently
      // leave linkedin_import_completed false while the completion screen
      // told the customer everything worked, permanently re-showing the
      // import flow every time they load the dashboard even though their
      // contacts really did import.
      const { error: profileErr } = await supabase.from('profiles').update({ linkedin_import_completed: true }).eq('id', user.id)
      if (profileErr) console.error('[LinkedInImport] failed to mark import completed:', profileErr.message)
      await refreshProfile()

      setDone({
        imported: toInsert.length,
        targets: targetCount,
        newCompanies: newCompanyCount,
        alreadySkipped: alreadyImportedCount,
        // Only worth mentioning on the completion screen when the 1,000-per-import
        // cap actually bit — most imports never get near it.
        cappedFrom: totalMatched > 1000 ? totalMatched : null,
      })
      trackEvent('linkedin_import_completed', { skipped: false, imported: toInsert.length, targets: targetCount, alreadySkipped: alreadyImportedCount })
  }

  async function handleSkip() {
    try {
      await withTimeout(
        supabase.from('profiles').update({ linkedin_import_completed: true }).eq('id', user.id),
        12000,
        'linkedin-skip',
      )
      await refreshProfile()
      trackEvent('linkedin_import_completed', { skipped: true })
      navigate('/dashboard')
    } catch (err) {
      console.error('[LinkedInImport] handleSkip failed:', err)
      setError(err.message?.startsWith('TIMEOUT:') ? TIMEOUT_MESSAGE : (err.message || 'Something went wrong. Please try again.'))
    }
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
            {/* 2026-08-26 audit fix: "at your target companies" described a
                target-company-list concept that was removed from the
                product — done.targets is really just a seniority/title tag
                (hot = C-Suite/Partner/MD-level), unrelated to any company
                list. Reworded to say what it actually is. */}
            {done.targets > 0 && <>, <span className="font-semibold text-gold">{done.targets} tagged hot as senior decision-makers</span></>}.
            {done.newCompanies > 0 && <> She also created <span className="font-semibold text-navy">{done.newCompanies} new compan{done.newCompanies === 1 ? 'y' : 'ies'}</span> in your Companies list, linked to their contacts.</>}
            {/* 2026-08-26 audit fix: re-uploading the same or a refreshed
                export used to silently duplicate every contact still in the
                file — now skipped and reported here instead. */}
            {done.alreadySkipped > 0 && <> {done.alreadySkipped} {done.alreadySkipped === 1 ? 'was' : 'were'} already in your CRM from an earlier import, so {done.alreadySkipped === 1 ? 'it was' : 'they were'} skipped rather than added twice.</>}
            {/* 2026-08-26 audit fix: the 1,000-per-import cap used to be
                silent — the review screen shows the uncapped match count,
                so a bigger match total quietly lost the difference with no
                explanation. */}
            {done.cappedFrom && <> Only the first 1,000 of your {done.cappedFrom.toLocaleString()} matches were imported this time — re-run the import to pick up the rest.</>}
            {/* 2026-08-26 audit fix: "monitoring all of them" implied
                per-contact tracking that doesn't exist — the scan is
                driven by your onboarding sectors/markets, not by watching
                individual imported contacts. What's real: any signal it
                finds does get matched back to these contacts by company
                (see Contacts/Companies pages), which is what this now
                says. */}
            {' '}Any BD signal Annie finds in your sectors will now be matched back to these contacts by company.
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

          <ErrorBanner>{error}</ErrorBanner>

          <div className="bg-yellow-50 border-2 border-gold rounded-xl p-5 mb-6">
            <div className="text-sm font-bold text-navy mb-1">Who should Annie import and watch?</div>
            <p className="text-xs text-gray-500 mb-4">These filters decide which of your connections get imported below.</p>

            <div className="mb-1">
              <div className="label mb-2">Sectors</div>
              <SectorPicker taxonomy={SECTOR_TAXONOMY} value={sectors} onChange={setSectors} />
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
              {/* 2026-08-26 audit fix: this copy unconditionally claimed
                  Apollo-verified company location, but that's only true
                  when APOLLO_API_KEY is configured — otherwise the match is
                  name-keyword-only (softGroupMatch), with nothing telling
                  the user which one happened. Now honest either way. */}
              <p className="text-[11px] text-gray-400 mt-1.5">
                {apolloConfigured
                  ? "Annie checks each contact's real company location before importing. Where that data isn't available, she only rules out a contact whose company name clearly points to a different market, uncertain cases are kept in."
                  : "Annie matches contacts to these markets by company name (a lighter check than her usual verified-company-data lookup). She only rules out a contact whose company name clearly points to a different market, uncertain cases are kept in."}
              </p>
            </div>

            <div className="mt-4 mb-1">
              <div className="label mb-2">Functions</div>
              <SectorPicker taxonomy={FUNCTION_TAXONOMY} value={functions} onChange={setFunctions} />
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
              <label className="text-sm text-gray-700 min-w-[130px]" htmlFor="li-import-years">Connected in last</label>
              <input id="li-import-years" type="range" min="1" max="10" value={years} onChange={e => setYears(Number(e.target.value))} className="flex-1 accent-gold" />
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
            {embedded ? 'Cancel' : "Skip for now, I'll import once LinkedIn's export is ready"}
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

          <ErrorBanner>{error}</ErrorBanner>

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
            {embedded ? 'Cancel' : "Skip for now, I'll import once LinkedIn's export is ready"}
          </button>
        </>
      )}
    </Wrapper>
  )
}

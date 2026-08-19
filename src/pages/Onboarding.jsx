import React, { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

const SECTORS = [
  'Executive Search', 'Technology', 'Financial Services', 'Legal',
  'Healthcare', 'Energy & Utilities', 'Real Estate', 'Consumer & Retail',
  'Industrial', 'Professional Services', 'Private Equity', 'Government & Public Sector',
]
const LOCATIONS = ['United Kingdom', 'UAE / GCC', 'Europe', 'United States', 'Asia Pacific', 'Global']
const TONES = [
  { id: 'professional', label: 'Professional', desc: 'Polished and formal' },
  { id: 'warm', label: 'Warm', desc: 'Friendly and personable' },
  { id: 'direct', label: 'Direct', desc: 'Straight to the point' },
  { id: 'consultative', label: 'Consultative', desc: 'Advisory and thoughtful' },
]

// ─────────────────────────────────────────────
// INTELLIGENT TARGET SUGGESTION MATRIX
// Each block has: category, applicable sectors, applicable locations, items
// Annie filters these based on what the user selected in steps 2 & 3
// ─────────────────────────────────────────────
const SUGGESTION_BLOCKS = [
  // ── UAE / GCC ──────────────────────────────
  {
    category: 'Sovereign Wealth Funds',
    locations: ['UAE / GCC'],
    sectors: ['Financial Services', 'Private Equity', 'Executive Search', 'Professional Services'],
    items: [
      { name: 'Mubadala Investment Company', desc: 'Abu Dhabi SWF — $300B+ AUM, active across sectors' },
      { name: 'ADIA', desc: 'Abu Dhabi Investment Authority — one of the world\'s largest SWFs' },
      { name: 'ADQ', desc: 'Abu Dhabi Developmental Holding — fast-growing, diversified mandate' },
      { name: 'PIF', desc: 'Saudi Arabia\'s $700B+ Public Investment Fund' },
      { name: 'QIA', desc: 'Qatar Investment Authority — global and regional mandate' },
      { name: 'ICD', desc: 'Investment Corporation of Dubai — government investment arm' },
    ],
  },
  {
    category: 'Regional Banks',
    locations: ['UAE / GCC'],
    sectors: ['Financial Services', 'Executive Search', 'Technology', 'Professional Services'],
    items: [
      { name: 'First Abu Dhabi Bank (FAB)', desc: 'Largest bank in UAE by assets' },
      { name: 'Emirates NBD', desc: 'Dubai\'s flagship state-owned bank' },
      { name: 'ADCB', desc: 'Abu Dhabi Commercial Bank — major retail & corporate' },
      { name: 'Mashreq Bank', desc: 'Oldest privately-owned bank in UAE' },
      { name: 'Dubai Islamic Bank', desc: 'World\'s largest Islamic bank' },
      { name: 'Al Rajhi Bank', desc: 'Saudi Arabia\'s largest Islamic bank' },
      { name: 'Saudi National Bank (SNB)', desc: 'Saudi Arabia\'s largest bank' },
      { name: 'National Bank of Kuwait (NBK)', desc: 'GCC\'s oldest commercial bank' },
    ],
  },
  {
    category: 'International Banks in DIFC',
    locations: ['UAE / GCC'],
    sectors: ['Financial Services', 'Executive Search'],
    items: [
      { name: 'HSBC MENA', desc: 'Major regional hub in DIFC' },
      { name: 'Standard Chartered MENA', desc: 'Strong emerging markets presence' },
      { name: 'Citi UAE', desc: 'Corporate & investment banking hub' },
      { name: 'Goldman Sachs Gulf', desc: 'IBD and asset management in DIFC' },
      { name: 'JPMorgan Middle East', desc: 'Investment banking & markets in DIFC' },
    ],
  },
  {
    category: 'Asset Managers & Private Equity',
    locations: ['UAE / GCC'],
    sectors: ['Financial Services', 'Private Equity', 'Executive Search'],
    items: [
      { name: 'Gulf Capital', desc: 'Leading regional PE and credit firm' },
      { name: 'Investcorp', desc: 'Global alternative investment manager, Bahrain HQ' },
      { name: 'Waha Capital', desc: 'Abu Dhabi-based diversified investment company' },
      { name: 'Shuaa Capital', desc: 'Dubai-based investment bank & asset manager' },
      { name: 'NBK Capital Partners', desc: 'Kuwait-based PE and investment management' },
      { name: 'GFH Financial Group', desc: 'Bahrain-based Islamic investment bank' },
    ],
  },
  {
    category: 'Fintechs & Digital Finance',
    locations: ['UAE / GCC'],
    sectors: ['Technology', 'Financial Services', 'Executive Search'],
    items: [
      { name: 'Wio Bank', desc: 'Abu Dhabi\'s first digital business bank' },
      { name: 'Zand Bank', desc: 'UAE\'s first licensed digital bank' },
      { name: 'Tabby', desc: 'BNPL leader — Series D, expanding across GCC' },
      { name: 'Tamara', desc: 'Saudi BNPL unicorn — $1B+ valuation' },
      { name: 'Lean Technologies', desc: 'Open banking infrastructure, SAMA-licensed' },
      { name: 'Network International', desc: 'Leading payment technology company in MENA' },
      { name: 'Magnati', desc: 'Abu Dhabi-based payment solutions (FAB spin-out)' },
      { name: 'Checkout.com MENA', desc: 'Global payment platform, strong GCC presence' },
      { name: 'STC Pay', desc: 'Saudi digital wallet — one of MENA\'s largest' },
      { name: 'DIFC Fintech Hive graduates', desc: 'Cohort companies scaling across GCC' },
    ],
  },
  {
    category: 'Fintechs — Recently Funded (MENA)',
    locations: ['UAE / GCC'],
    sectors: ['Technology', 'Financial Services', 'Executive Search'],
    items: [
      { name: 'Fintechs with Series A/B in past 12 months', desc: 'Actively hiring as they scale — DFSA & ADGM licensed' },
      { name: 'New DIFC-licensed financial services entities', desc: 'Entrants to DIFC ecosystem — immediate hiring need' },
      { name: 'SAMA-licensed Saudi fintechs', desc: 'Saudi digital finance companies post-Vision 2030 push' },
    ],
  },
  {
    category: 'Real Estate Developers',
    locations: ['UAE / GCC'],
    sectors: ['Real Estate', 'Executive Search'],
    items: [
      { name: 'Emaar Properties', desc: 'Dubai\'s largest developer — Burj Khalifa, Dubai Mall' },
      { name: 'Aldar Properties', desc: 'Abu Dhabi\'s leading listed developer' },
      { name: 'DAMAC Properties', desc: 'Luxury residential developer, Dubai' },
      { name: 'Sobha Realty', desc: 'Premium developer expanding across GCC' },
      { name: 'Meraas', desc: 'Dubai Holding subsidiary — lifestyle & mixed-use' },
      { name: 'NEOM', desc: 'Saudi Arabia\'s $500B giga-project — massive hiring programme' },
      { name: 'Diriyah Company', desc: 'Saudi cultural & heritage mega-development' },
      { name: 'Red Sea Global', desc: 'Saudi luxury tourism & real estate giga-project' },
      { name: 'Roshn', desc: 'PIF-owned residential developer — hiring across Saudi' },
      { name: 'Meydan Group', desc: 'Dubai mixed-use developer and events group' },
    ],
  },
  {
    category: 'PropTech & Real Estate Investment',
    locations: ['UAE / GCC'],
    sectors: ['Real Estate', 'Technology', 'Financial Services'],
    items: [
      { name: 'Huspy', desc: 'UAE mortgage & real estate marketplace' },
      { name: 'Stake', desc: 'Fractional real estate investment platform, Dubai' },
      { name: 'Emirates REIT', desc: 'First listed Islamic REIT in UAE' },
      { name: 'ENBD REIT', desc: 'Emirates NBD-backed real estate investment trust' },
      { name: 'Large Real Estate developers raising capital', desc: 'Developers structuring investment vehicles in DIFC/ADGM' },
    ],
  },
  {
    category: 'Energy & Infrastructure',
    locations: ['UAE / GCC'],
    sectors: ['Energy & Utilities', 'Executive Search', 'Industrial'],
    items: [
      { name: 'ADNOC', desc: 'Abu Dhabi National Oil Company — major senior hiring' },
      { name: 'Saudi Aramco', desc: 'World\'s largest oil company by production' },
      { name: 'QatarEnergy', desc: 'Qatar\'s national energy company' },
      { name: 'DEWA', desc: 'Dubai Electricity & Water Authority' },
      { name: 'Masdar', desc: 'Abu Dhabi\'s clean energy company — major renewable expansion' },
      { name: 'ACWA Power', desc: 'Saudi-listed renewable energy & water developer' },
      { name: 'NEOM Energy', desc: 'Green hydrogen and sustainable energy for giga-project' },
    ],
  },
  {
    category: 'Technology & Telecoms',
    locations: ['UAE / GCC'],
    sectors: ['Technology', 'Executive Search'],
    items: [
      { name: 'e& (Etisalat)', desc: 'UAE\'s leading telecom — expanding into tech & fintech at speed' },
      { name: 'du (EITC)', desc: 'UAE telecom & enterprise tech services' },
      { name: 'STC Group', desc: 'Saudi Arabia\'s largest telecom — major digital transformation' },
      { name: 'Microsoft Gulf', desc: 'Regional HQ in Dubai Internet City' },
      { name: 'Google Cloud MENA', desc: 'Expanding data centre and cloud presence in UAE & KSA' },
      { name: 'SAP MENA', desc: 'Enterprise software — large regional footprint' },
      { name: 'Oracle MENA', desc: 'Cloud & enterprise solutions hub' },
      { name: 'Careem', desc: 'Uber-owned super app — continuing to expand UAE team' },
    ],
  },
  {
    category: 'Healthcare',
    locations: ['UAE / GCC'],
    sectors: ['Healthcare', 'Executive Search'],
    items: [
      { name: 'Mediclinic Middle East', desc: 'Swiss-owned hospital group, major UAE presence' },
      { name: 'Cleveland Clinic Abu Dhabi', desc: 'World-class hospital — leadership & specialist roles' },
      { name: 'Aster DM Healthcare', desc: 'Listed UAE healthcare group with GCC hospitals' },
      { name: 'VPS Healthcare', desc: 'Large private hospital group in UAE' },
      { name: 'Dr. Sulaiman Al Habib Medical Group', desc: 'Saudi Arabia\'s leading private healthcare provider' },
      { name: 'Saudi Vision 2030 healthcare entities', desc: 'Privatised hospital groups and health clusters' },
    ],
  },
  {
    category: 'Professional Services & Consulting',
    locations: ['UAE / GCC'],
    sectors: ['Professional Services', 'Executive Search', 'Financial Services'],
    items: [
      { name: 'McKinsey & Company (Dubai/Riyadh)', desc: 'Strategy consulting — active across GCC sovereign clients' },
      { name: 'BCG Middle East', desc: 'Boston Consulting Group — Dubai & Riyadh offices growing' },
      { name: 'Bain & Company MENA', desc: 'PE advisory and strategy, growing GCC team' },
      { name: 'Deloitte Middle East', desc: 'Big 4 — largest professional services firm in region' },
      { name: 'PwC Middle East', desc: 'Big 4 — strong government & SWF advisory' },
      { name: 'EY MENA', desc: 'Big 4 — assurance, tax, transactions' },
      { name: 'KPMG Lower Gulf', desc: 'Big 4 — audit, advisory, risk' },
    ],
  },
  {
    category: 'Law Firms in DIFC',
    locations: ['UAE / GCC'],
    sectors: ['Legal', 'Executive Search'],
    items: [
      { name: 'Clifford Chance DIFC', desc: 'Magic Circle — flagship MENA office' },
      { name: 'Linklaters DIFC', desc: 'Magic Circle — finance and capital markets focus' },
      { name: 'A&O Shearman', desc: 'Merged global firm, strong DIFC presence' },
      { name: 'Herbert Smith Freehills', desc: 'Disputes, energy and finance focus in UAE' },
      { name: 'White & Case', desc: 'US firm — strong project finance and PE in GCC' },
      { name: 'Baker McKenzie MENA', desc: 'Global firm with strong UAE corporate practice' },
      { name: 'Freshfields', desc: 'Magic Circle — M&A and restructuring in UAE' },
    ],
  },
  {
    category: 'Consumer & Retail — GCC',
    locations: ['UAE / GCC'],
    sectors: ['Consumer & Retail', 'Executive Search'],
    items: [
      { name: 'Majid Al Futtaim', desc: 'UAE\'s largest retail & leisure developer (Carrefour, VOX)' },
      { name: 'Alshaya Group', desc: 'Kuwait-based retail franchisee — 70+ brands in GCC' },
      { name: 'Chalhoub Group', desc: 'Luxury goods distribution across GCC' },
      { name: 'Landmark Group', desc: 'UAE retail and hospitality conglomerate' },
      { name: 'LVMH Middle East', desc: 'Luxury goods — expanding regional presence' },
    ],
  },
  {
    category: 'Government & Public Sector — GCC',
    locations: ['UAE / GCC'],
    sectors: ['Government & Public Sector', 'Executive Search'],
    items: [
      { name: 'Dubai Government entities', desc: 'DIFC, Dubai Future Foundation, Smart Dubai, RTA, DTCM' },
      { name: 'Abu Dhabi Government entities', desc: 'DOF, DED Abu Dhabi, ADIO, ADEK, DoH' },
      { name: 'Saudi Vision 2030 entities', desc: 'NDF, Giga-projects, MCIT, SAUDIA Group' },
      { name: 'DIFC Authority', desc: 'Dubai International Financial Centre — regulator & operator' },
      { name: 'ADGM', desc: 'Abu Dhabi Global Market — growing financial free zone' },
    ],
  },

  // ── United Kingdom ──────────────────────────
  {
    category: 'UK Banks & Financial Institutions',
    locations: ['United Kingdom'],
    sectors: ['Financial Services', 'Executive Search'],
    items: [
      { name: 'Barclays', desc: 'FTSE 100 — retail, corporate & investment banking' },
      { name: 'HSBC UK', desc: 'Global bank with major UK operations' },
      { name: 'Lloyds Banking Group', desc: 'UK\'s largest retail bank by customers' },
      { name: 'NatWest Group', desc: 'Major UK commercial and retail bank' },
      { name: 'Standard Chartered', desc: 'Emerging markets bank, London-listed' },
      { name: 'Schroders', desc: 'FTSE 100 asset manager, £700B+ AUM' },
      { name: 'Legal & General Investment Management', desc: 'UK\'s largest asset manager' },
    ],
  },
  {
    category: 'UK Private Equity',
    locations: ['United Kingdom'],
    sectors: ['Private Equity', 'Financial Services', 'Executive Search'],
    items: [
      { name: 'CVC Capital Partners', desc: 'One of Europe\'s largest PE firms, London HQ' },
      { name: 'Apax Partners', desc: 'Global PE with strong UK mid-market focus' },
      { name: 'Bridgepoint', desc: 'UK-listed PE — mid-market European buyouts' },
      { name: '3i Group', desc: 'FTSE 100 PE & infrastructure' },
      { name: 'Permira', desc: 'Global PE firm, London HQ' },
      { name: 'Man Group', desc: 'Largest publicly-listed hedge fund globally' },
      { name: 'Brevan Howard', desc: 'London-based macro hedge fund' },
    ],
  },
  {
    category: 'UK Fintechs',
    locations: ['United Kingdom'],
    sectors: ['Technology', 'Financial Services', 'Executive Search'],
    items: [
      { name: 'Revolut', desc: 'UK neobank unicorn — 35M+ customers, hiring rapidly' },
      { name: 'Monzo', desc: 'Leading UK digital bank' },
      { name: 'Wise', desc: 'Global money transfer — London-listed, profitable' },
      { name: 'Starling Bank', desc: 'Award-winning UK digital bank' },
      { name: 'Checkout.com', desc: 'London-based payment infrastructure, $40B valuation' },
      { name: 'OakNorth Bank', desc: 'UK challenger bank focused on growth businesses' },
    ],
  },
  {
    category: 'UK Professional Services & Law',
    locations: ['United Kingdom'],
    sectors: ['Professional Services', 'Legal', 'Executive Search'],
    items: [
      { name: 'Deloitte UK', desc: 'Big 4 — UK\'s largest professional services firm' },
      { name: 'PwC UK', desc: 'Big 4 — audit, tax, deals advisory' },
      { name: 'McKinsey UK', desc: 'Strategy consulting — public sector and financial services' },
      { name: 'BCG UK', desc: 'Strategy and transformation consulting' },
      { name: 'Oliver Wyman', desc: 'Financial services consulting — City of London focus' },
      { name: 'Clifford Chance', desc: 'Magic Circle — finance and capital markets' },
      { name: 'Linklaters', desc: 'Magic Circle — M&A and corporate' },
      { name: 'Freshfields', desc: 'Magic Circle — restructuring and disputes' },
    ],
  },
  {
    category: 'UK Healthcare & Life Sciences',
    locations: ['United Kingdom'],
    sectors: ['Healthcare', 'Executive Search'],
    items: [
      { name: 'NHS Foundation Trusts', desc: 'NHS — large-scale leadership and C-suite hiring' },
      { name: 'Bupa UK', desc: 'Private healthcare — hospitals and dental' },
      { name: 'Spire Healthcare', desc: 'Listed private hospital group' },
      { name: 'GSK', desc: 'FTSE 100 pharmaceutical company' },
      { name: 'AstraZeneca', desc: 'FTSE 100 — major life sciences employer' },
    ],
  },

  // ── United States ───────────────────────────
  {
    category: 'US Investment Banks',
    locations: ['United States'],
    sectors: ['Financial Services', 'Executive Search'],
    items: [
      { name: 'Goldman Sachs', desc: 'Global investment bank, NY HQ' },
      { name: 'JPMorgan Chase', desc: 'World\'s largest bank by market cap' },
      { name: 'Morgan Stanley', desc: 'Global investment bank & wealth management' },
      { name: 'Citi', desc: 'Global banking giant, NY HQ' },
      { name: 'Bank of America', desc: 'Major US commercial and investment bank' },
    ],
  },
  {
    category: 'US Private Equity & Alternatives',
    locations: ['United States'],
    sectors: ['Private Equity', 'Financial Services', 'Executive Search'],
    items: [
      { name: 'Blackstone', desc: 'World\'s largest alternative asset manager' },
      { name: 'KKR', desc: 'Global PE and infrastructure — $550B+ AUM' },
      { name: 'Apollo Global Management', desc: 'Alternative asset manager, $650B+ AUM' },
      { name: 'The Carlyle Group', desc: 'Global PE — strong public sector exposure' },
      { name: 'Ares Management', desc: 'Alternative credit and PE — fast-growing' },
    ],
  },
  {
    category: 'US Technology',
    locations: ['United States'],
    sectors: ['Technology', 'Executive Search'],
    items: [
      { name: 'Microsoft', desc: 'Global tech leader — AI and cloud transformation' },
      { name: 'Google / Alphabet', desc: 'Search, cloud, AI — massive exec team' },
      { name: 'Amazon / AWS', desc: 'E-commerce and cloud infrastructure' },
      { name: 'Meta', desc: 'Social media and AI research' },
      { name: 'Apple', desc: 'Consumer tech and services giant' },
      { name: 'US tech scale-ups expanding to MENA', desc: 'Series B/C companies entering UAE & KSA markets' },
    ],
  },

  // ── Europe ──────────────────────────────────
  {
    category: 'European Banks & Financial Institutions',
    locations: ['Europe'],
    sectors: ['Financial Services', 'Executive Search'],
    items: [
      { name: 'Deutsche Bank', desc: 'Germany\'s largest bank' },
      { name: 'BNP Paribas', desc: 'France\'s largest bank' },
      { name: 'UBS Group', desc: 'Swiss global wealth management leader' },
      { name: 'ING Group', desc: 'Dutch bank — strong corporate banking' },
      { name: 'Société Générale', desc: 'French universal bank — restructuring' },
    ],
  },
  {
    category: 'European Private Equity',
    locations: ['Europe'],
    sectors: ['Private Equity', 'Executive Search'],
    items: [
      { name: 'EQT AB', desc: 'Swedish PE — €200B+ AUM' },
      { name: 'Cinven', desc: 'European buyout specialist' },
      { name: 'BC Partners', desc: 'Pan-European PE' },
      { name: 'Ardian', desc: 'French PE and infrastructure giant' },
    ],
  },

  // ── Asia Pacific ────────────────────────────
  {
    category: 'Asia Pacific Sovereign & Institutional',
    locations: ['Asia Pacific'],
    sectors: ['Financial Services', 'Private Equity', 'Executive Search'],
    items: [
      { name: 'Temasek Holdings', desc: 'Singapore state investment company — $380B+ AUM' },
      { name: 'GIC', desc: 'Government of Singapore Investment Corporation' },
      { name: 'DBS Bank', desc: 'Singapore\'s largest bank — digital leader' },
      { name: 'OCBC', desc: 'Singapore-listed bank with regional reach' },
      { name: 'Macquarie Group', desc: 'Australian infrastructure and investment bank' },
    ],
  },
  {
    category: 'Asia Pacific Private Equity',
    locations: ['Asia Pacific'],
    sectors: ['Private Equity', 'Executive Search'],
    items: [
      { name: 'PAG Asia Capital', desc: 'Hong Kong-based PE and hedge fund' },
      { name: 'MBK Partners', desc: 'North Asia buyout fund' },
      { name: 'Warburg Pincus Asia', desc: 'Global PE with strong Asia presence' },
    ],
  },

  // ── Global ──────────────────────────────────
  {
    category: 'Global Consulting & Professional Services',
    locations: ['Global'],
    sectors: ['Professional Services', 'Executive Search'],
    items: [
      { name: 'McKinsey & Company', desc: 'World\'s largest strategy consulting firm' },
      { name: 'Boston Consulting Group', desc: 'Global strategy and transformation' },
      { name: 'Bain & Company', desc: 'Strategy, PE advisory and growth' },
      { name: 'Oliver Wyman', desc: 'Financial services and risk consulting' },
      { name: 'Korn Ferry', desc: 'Global executive search and talent' },
    ],
  },
  {
    category: 'Global Consumer & Retail',
    locations: ['Global'],
    sectors: ['Consumer & Retail', 'Executive Search'],
    items: [
      { name: 'Unilever', desc: 'FTSE 100 consumer goods giant' },
      { name: 'Procter & Gamble', desc: 'Global consumer products leader' },
      { name: 'LVMH', desc: 'World\'s largest luxury group' },
      { name: 'Richemont', desc: 'Swiss luxury conglomerate — Cartier, IWC' },
    ],
  },
]

function getTargetSuggestions(sectors, locations) {
  // If nothing selected, show a broad cross-section
  if (!sectors.length && !locations.length) return SUGGESTION_BLOCKS.slice(0, 5)
  return SUGGESTION_BLOCKS.filter(block => {
    const sectorMatch = !sectors.length || block.sectors.some(s => sectors.includes(s))
    const locationMatch = !locations.length || block.locations.some(l => locations.includes(l))
    return sectorMatch && locationMatch
  })
}

export default function Onboarding() {
  const { user, profile, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const step4Initialized = useRef(false)

  const [form, setForm] = useState({
    firmName: profile?.firm_name || '',
    sectors: [],
    locations: [],
    selectedTargets: [],
    customTargets: '',
    bdGoals: '',
    tone: 'professional',
  })

  const suggestions = useMemo(
    () => getTargetSuggestions(form.sectors, form.locations),
    [form.sectors, form.locations]
  )

  // Pre-select all suggestions the first time user reaches step 4
  useEffect(() => {
    if (step === 4 && !step4Initialized.current) {
      step4Initialized.current = true
      const all = suggestions.flatMap(g => g.items.map(i => i.name))
      setForm(prev => ({ ...prev, selectedTargets: all }))
    }
  }, [step, suggestions])

  function toggleItem(field, value) {
    setForm(prev => ({
      ...prev,
      [field]: prev[field].includes(value)
        ? prev[field].filter(v => v !== value)
        : [...prev[field], value],
    }))
  }

  function toggleTarget(name) {
    setForm(prev => ({
      ...prev,
      selectedTargets: prev.selectedTargets.includes(name)
        ? prev.selectedTargets.filter(n => n !== name)
        : [...prev.selectedTargets, name],
    }))
  }

  function update(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
    setError('')
  }

  async function handleFinish() {
    setLoading(true)
    setError('')
    try {
      const customArr = form.customTargets.split('\n').map(s => s.trim()).filter(Boolean)
      const allTargets = [...new Set([...form.selectedTargets, ...customArr])]

      const { error: onboardErr } = await supabase.from('onboarding').upsert({
        user_id: user.id,
        firm_name: form.firmName,
        sectors: form.sectors,
        locations: form.locations,
        target_companies: allTargets,
        bd_goals: form.bdGoals,
        tone: form.tone,
      }, { onConflict: 'user_id' })
      if (onboardErr) throw onboardErr

      const { error: profileErr } = await supabase
        .from('profiles')
        .update({ onboarding_completed: true, firm_name: form.firmName })
        .eq('id', user.id)
      if (profileErr) throw profileErr

      await refreshProfile()
      navigate('/import')
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const steps = [
    { num: 1, label: 'Your Firm' },
    { num: 2, label: 'Sectors' },
    { num: 3, label: 'Markets' },
    { num: 4, label: 'Targets' },
    { num: 5, label: 'Your Style' },
  ]

  return (
    <div className="min-h-screen bg-navy flex flex-col items-center justify-center px-4 py-12">

      {/* Logo */}
      <div className="flex items-center gap-3 mb-10">
        <svg width="40" height="40" viewBox="0 0 68 68" fill="none">
          <rect width="68" height="68" rx="16" fill="#c9a84c"/>
          <path d="M34 14 L50 54 H44 L40 44 H28 L24 54 H18 L34 14Z M34 24 L30 38 H38 L34 24Z" fill="#0d1b3e"/>
        </svg>
        <div>
          <div className="text-white font-bold text-xl leading-none">annie</div>
          <div className="text-gold text-xs font-semibold tracking-widest uppercase">BD Intelligence</div>
        </div>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {steps.map((s, i) => (
          <React.Fragment key={s.num}>
            <div className={`flex items-center gap-1.5 ${step >= s.num ? 'text-gold' : 'text-gray-600'}`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all
                ${step > s.num ? 'bg-gold border-gold text-navy' : step === s.num ? 'border-gold text-gold' : 'border-gray-600 text-gray-600'}`}>
                {step > s.num ? '✓' : s.num}
              </div>
              <span className="text-xs font-medium hidden sm:block">{s.label}</span>
            </div>
            {i < steps.length - 1 && <div className={`w-8 h-px ${step > s.num ? 'bg-gold' : 'bg-gray-700'}`} />}
          </React.Fragment>
        ))}
      </div>

      {/* Card — wider on step 4 to fit more content */}
      <div className={`bg-white rounded-2xl p-8 shadow-2xl w-full ${step === 4 ? 'max-w-2xl' : 'max-w-lg'}`}>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4">{error}</div>
        )}

        {/* ── Step 1: Firm ── */}
        {step === 1 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Tell us about your firm</h2>
            <p className="text-gray-500 text-sm mb-6">Annie uses this to personalise everything for you.</p>
            <div className="space-y-4">
              <div>
                <label className="label">Firm name</label>
                <input className="input" placeholder="e.g. Vantage Search Group" value={form.firmName} onChange={e => update('firmName', e.target.value)} />
              </div>
              <div>
                <label className="label">Your BD goals</label>
                <textarea className="input resize-none" rows={4}
                  placeholder="e.g. Win 3 new retained clients this quarter in financial services. Focus on CFO and CEO roles..."
                  value={form.bdGoals} onChange={e => update('bdGoals', e.target.value)} />
                <p className="text-xs text-gray-400 mt-1">Be specific — Annie will use this to prioritise your daily actions.</p>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Sectors ── */}
        {step === 2 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Which sectors do you recruit in?</h2>
            <p className="text-gray-500 text-sm mb-6">Select all that apply.</p>
            <div className="grid grid-cols-2 gap-2">
              {SECTORS.map(s => (
                <button key={s} onClick={() => toggleItem('sectors', s)}
                  className={`px-3 py-2.5 rounded-lg text-sm font-medium border-2 text-left transition-all
                    ${form.sectors.includes(s) ? 'border-gold bg-yellow-50 text-navy' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 3: Markets ── */}
        {step === 3 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Where are your target markets?</h2>
            <p className="text-gray-500 text-sm mb-6">Select all that apply.</p>
            <div className="grid grid-cols-2 gap-2">
              {LOCATIONS.map(l => (
                <button key={l} onClick={() => toggleItem('locations', l)}
                  className={`px-3 py-2.5 rounded-lg text-sm font-medium border-2 text-left transition-all
                    ${form.locations.includes(l) ? 'border-gold bg-yellow-50 text-navy' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 4: Intelligent Target Suggestions ── */}
        {step === 4 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">Your target clients</h2>
            <p className="text-gray-500 text-sm mb-1">
              Annie has suggested <span className="font-semibold text-navy">{form.selectedTargets.length} targets</span> based on your sectors and markets.
              Deselect anything that doesn't fit, and add specific companies below.
            </p>
            <p className="text-xs text-gold font-semibold mb-5">Annie will monitor all selected targets for hiring signals, leadership changes, and BD triggers.</p>

            <div className="space-y-5 max-h-[420px] overflow-y-auto pr-2 mb-5">
              {suggestions.length === 0 && (
                <p className="text-gray-400 text-sm">Go back and select your sectors and markets to see intelligent suggestions.</p>
              )}
              {suggestions.map(group => (
                <div key={group.category}>
                  <div className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                    {group.category}
                    <span className="text-gray-300 font-normal normal-case">
                      · {group.items.filter(i => form.selectedTargets.includes(i.name)).length}/{group.items.length} selected
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {group.items.map(item => {
                      const selected = form.selectedTargets.includes(item.name)
                      return (
                        <button
                          key={item.name}
                          onClick={() => toggleTarget(item.name)}
                          className={`w-full text-left px-3 py-2.5 rounded-lg border-2 transition-all ${
                            selected
                              ? 'border-gold bg-yellow-50'
                              : 'border-gray-100 bg-gray-50 hover:border-gray-200'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className={`text-sm font-semibold ${selected ? 'text-navy' : 'text-gray-400'}`}>{item.name}</div>
                              <div className={`text-xs mt-0.5 ${selected ? 'text-gray-500' : 'text-gray-300'}`}>{item.desc}</div>
                            </div>
                            <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 mt-0.5 flex items-center justify-center ${selected ? 'border-gold bg-gold' : 'border-gray-300'}`}>
                              {selected && <span className="text-white text-xs leading-none">✓</span>}
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div>
              <label className="label">Add specific companies not listed above</label>
              <textarea
                className="input resize-none"
                rows={3}
                placeholder={"e.g. Al-Akaria\nRiyad Capital\nSamba Financial Group"}
                value={form.customTargets}
                onChange={e => setForm(prev => ({ ...prev, customTargets: e.target.value }))}
              />
              <p className="text-xs text-gray-400 mt-1">One per line. Annie will add these to your monitoring list.</p>
            </div>
          </div>
        )}

        {/* ── Step 5: Tone ── */}
        {step === 5 && (
          <div>
            <h2 className="text-2xl font-bold text-navy mb-1">How do you communicate?</h2>
            <p className="text-gray-500 text-sm mb-6">Annie will match your outreach style.</p>
            <div className="space-y-3">
              {TONES.map(t => (
                <button key={t.id} onClick={() => update('tone', t.id)}
                  className={`w-full px-4 py-3.5 rounded-lg border-2 text-left transition-all
                    ${form.tone === t.id ? 'border-gold bg-yellow-50' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className={`font-semibold text-sm ${form.tone === t.id ? 'text-navy' : 'text-gray-700'}`}>{t.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{t.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between items-center mt-8">
          {step > 1 ? (
            <button onClick={() => setStep(s => s - 1)} className="btn-ghost">Back</button>
          ) : <div />}

          {step < 5 ? (
            <button onClick={() => setStep(s => s + 1)} className="btn-primary">Continue</button>
          ) : (
            <button onClick={handleFinish} disabled={loading} className="btn-primary">
              {loading ? 'Setting up Annie...' : 'Launch Annie'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

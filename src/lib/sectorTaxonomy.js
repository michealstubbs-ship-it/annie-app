// Single source of truth for sectors, used by both onboarding and the LinkedIn
// import filter, so the two can never drift out of sync again. Each category has
// its own broad keyword set (used when a customer selects the whole category) and
// a list of sub-sectors with tighter keyword sets (used when they narrow down).
// "Executive Search" was removed, it's the customer's own profession, not a market
// they place candidates into, and it never matched anything real anyway.

export const SECTOR_TAXONOMY = [
  {
    label: 'Financial Services',
    keywords: ['bank', 'banking', 'financial', 'finance', 'insurance', 'fintech', 'payments'],
    subSectors: [
      { label: 'Retail & Commercial Banking', keywords: ['retail bank', 'commercial bank', 'banking group', 'bank plc'] },
      { label: 'Investment Banking', keywords: ['investment bank', 'corporate finance', 'capital markets', 'm&a advisory'] },
      { label: 'Wealth & Asset Management', keywords: ['wealth management', 'asset management', 'fund management', 'private banking'] },
      { label: 'Insurance', keywords: ['insurance', 'reinsurance', 'underwriting', 'assurance'] },
      { label: 'Fintech & Payments', keywords: ['fintech', 'payments', 'payment processing', 'digital banking', 'neobank'] },
    ],
  },
  {
    label: 'Technology',
    keywords: ['technolog', 'software', 'digital', 'systems', 'internet', 'computer'],
    subSectors: [
      { label: 'Software & SaaS', keywords: ['software', 'saas', 'cloud', 'platform'] },
      { label: 'AI & Data', keywords: ['artificial intelligence', 'machine learning', 'data science', 'analytics'] },
      { label: 'Cybersecurity', keywords: ['cyber security', 'cybersecurity', 'infosec', 'security software'] },
      { label: 'Telecom', keywords: ['telecom', 'telecommunications', 'wireless', 'network operator'] },
      { label: 'Hardware & Semiconductors', keywords: ['semiconductor', 'hardware', 'chip manufactur', 'electronics manufactur'] },
      { label: 'E-commerce & Consumer Tech', keywords: ['e-commerce', 'ecommerce', 'marketplace', 'consumer app'] },
    ],
  },
  {
    label: 'Law',
    // Renamed from "Legal" (25 Aug 2026, Michael): this is now paired with a named
    // firm-tier directory (TARGET_FIRM_DIRECTORY below) so Annie checks specific
    // law firms' own career pages directly, not just generic legal-industry news.
    keywords: ['law firm', 'law practice', 'legal', 'llp', 'advocates', 'attorneys'],
    subSectors: [
      { label: 'Corporate & M&A', keywords: ['corporate law', 'm&a', 'mergers', 'acquisitions law'] },
      { label: 'Litigation & Disputes', keywords: ['litigation', 'disputes', 'arbitration'] },
      { label: 'Regulatory & Compliance', keywords: ['regulatory', 'compliance', 'financial crime'] },
      { label: 'IP & Technology Law', keywords: ['intellectual property', 'ip law', 'technology law'] },
    ],
  },
  {
    label: 'Healthcare',
    keywords: ['health', 'healthcare', 'medical', 'pharma', 'hospital', 'clinic'],
    subSectors: [
      { label: 'Hospitals & Providers', keywords: ['hospital', 'clinic', 'healthcare provider', 'medical centre'] },
      { label: 'Pharma & Biotech', keywords: ['pharma', 'pharmaceutical', 'biotech', 'life sciences'] },
      { label: 'Medtech & Devices', keywords: ['medical device', 'medtech', 'diagnostics'] },
      { label: 'Digital Health', keywords: ['digital health', 'telehealth', 'health tech'] },
    ],
  },
  {
    label: 'Energy & Utilities',
    keywords: ['energy', 'utilities', 'oil', 'gas', 'power', 'renewable', 'solar'],
    subSectors: [
      { label: 'Oil & Gas', keywords: ['oil', 'gas', 'petroleum', 'upstream', 'downstream'] },
      { label: 'Renewables & Clean Energy', keywords: ['renewable', 'solar', 'wind energy', 'clean energy'] },
      { label: 'Power & Utilities', keywords: ['power', 'utilities', 'electricity', 'grid'] },
      { label: 'Mining & Metals', keywords: ['mining', 'metals', 'minerals'] },
    ],
  },
  {
    label: 'Real Estate',
    keywords: ['real estate', 'realty', 'properties', 'property', 'developer', 'development'],
    subSectors: [
      { label: 'Development', keywords: ['developer', 'development', 'master developer'] },
      { label: 'Investment & Asset Management', keywords: ['real estate investment', 'reit', 'property fund'] },
      { label: 'Property Management', keywords: ['property management', 'facilities management', 'estate management'] },
      { label: 'Proptech', keywords: ['proptech', 'real estate technology', 'real estate platform'] },
    ],
  },
  {
    label: 'Consumer & Retail',
    keywords: ['retail', 'consumer', 'fmcg', 'brands'],
    subSectors: [
      { label: 'Retail & E-commerce', keywords: ['retail', 'e-commerce', 'ecommerce', 'stores'] },
      { label: 'FMCG', keywords: ['fmcg', 'consumer goods', 'packaged goods'] },
      { label: 'Hospitality & Leisure', keywords: ['hospitality', 'hotel', 'leisure', 'travel'] },
      { label: 'Luxury & Fashion', keywords: ['luxury', 'fashion', 'apparel'] },
    ],
  },
  {
    label: 'Industrial',
    keywords: ['industrial', 'manufacturing', 'engineering', 'construction'],
    subSectors: [
      { label: 'Manufacturing', keywords: ['manufacturing', 'factory', 'production'] },
      { label: 'Engineering & Construction', keywords: ['engineering', 'construction', 'contractor', 'epc'] },
      { label: 'Logistics & Supply Chain', keywords: ['logistics', 'supply chain', 'freight', 'shipping'] },
      { label: 'Automotive', keywords: ['automotive', 'vehicle manufactur', 'auto parts'] },
    ],
  },
  {
    label: 'Management Consulting',
    // Renamed/narrowed from "Professional Services" (25 Aug 2026, Michael): the old
    // catch-all label covered accounting, marketing agencies and HR tech alongside
    // consulting, which was too broad to name real target firms against. This is now
    // paired with a named firm-tier directory (TARGET_FIRM_DIRECTORY below) so Annie
    // checks Big 4 / Tier 1-2 / boutique consulting firms' career pages directly.
    keywords: ['management consulting', 'strategy consulting', 'consulting', 'advisory', 'big 4', 'tier 1 consulting', 'boutique consulting'],
    subSectors: [
      { label: 'Big 4 & Global Advisory', keywords: ['deloitte', 'pwc', 'ey', 'ernst & young', 'kpmg', 'accenture', 'big 4'] },
      { label: 'Strategy Consulting (Tier 1/2)', keywords: ['mckinsey', 'bcg', 'boston consulting', 'bain', 'oliver wyman', 'kearney', 'strategy&', 'roland berger', 'l.e.k.', 'strategy consulting'] },
      { label: 'Boutique & Specialist Consulting', keywords: ['boutique consulting', 'specialist advisory', 'independent consultancy'] },
    ],
  },
  {
    label: 'Private Equity',
    keywords: ['private equity', 'venture capital', 'growth equity'],
    subSectors: [
      { label: 'Private Equity', keywords: ['private equity', 'buyout', 'pe firm'] },
      { label: 'Venture Capital', keywords: ['venture capital', 'venture fund'] },
      { label: 'Growth Equity', keywords: ['growth equity', 'growth capital'] },
      { label: 'Hedge Funds', keywords: ['hedge fund'] },
      { label: 'Family Offices', keywords: ['family office'] },
    ],
  },
  {
    label: 'Government & Public Sector',
    keywords: ['government', 'ministry', 'authority', 'public sector'],
    subSectors: [
      { label: 'Central Government', keywords: ['ministry', 'government department', 'federal government'] },
      { label: 'Public Health', keywords: ['public health', 'ministry of health'] },
      { label: 'Education', keywords: ['university', 'education authority', 'ministry of education'] },
      { label: 'Non-profit / NGO', keywords: ['ngo', 'non-profit', 'nonprofit', 'foundation'] },
      { label: 'Defense & Security', keywords: ['defense', 'defence', 'security agency'] },
    ],
  },
]

// Flat list, one entry per whole category (keywords = union of its sub-sectors)
// plus one entry per individual sub-sector ("Parent > Sub"). This is what the
// LinkedIn import matching logic reads, a selection can reference either kind of
// label and this always has a matching keyword set for it.
export const FLAT_SECTOR_OPTIONS = SECTOR_TAXONOMY.flatMap(cat => [
  {
    label: cat.label,
    keywords: [...new Set([...cat.keywords, ...cat.subSectors.flatMap(s => s.keywords)])],
  },
  ...cat.subSectors.map(s => ({ label: `${cat.label} > ${s.label}`, keywords: s.keywords })),
])

export const SECTOR_PARENT_LABELS = SECTOR_TAXONOMY.map(c => c.label)

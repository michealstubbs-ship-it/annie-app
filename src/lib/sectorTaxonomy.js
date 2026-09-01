// Single source of truth for sectors, used by both onboarding and the LinkedIn
// import filter, so the two can never drift out of sync again. Each category has
// its own broad keyword set (used when a customer selects the whole category) and
// a list of sub-sectors with tighter keyword sets (used when they narrow down).
// "Executive Search" was removed, it's the customer's own profession, not a market
// they place candidates into, and it never matched anything real anyway.
//
// 2026-09-01: promoted 4 sub-sectors to their own top-level sector, approved by
// Michael ("Yes you can do that for these 4") after researching how top job
// boards (LinkedIn's own industry taxonomy, both the classic ~150-value list and
// the newer NAICS-aligned ~400-value list) and Crunchbase/NAICS classify these
// markets — each is large and distinct enough on its own that bundling it inside
// a broader category buried it from being separately targetable: Construction
// (was Industrial > Engineering & Construction), Manufacturing (was Industrial >
// Manufacturing), Education (was Government & Public Sector > Education), and
// Marketing, Media & Advertising (new — wasn't represented at all before).
// Removed from their old homes rather than left duplicated, so selecting the
// old parent category (Industrial / Government & Public Sector) no longer
// silently also matches what is now its own independent sector — that would
// have defeated the point of separating them out. Industrial is narrower now
// (Logistics & Supply Chain, Automotive); Government & Public Sector no longer
// carries Education. NOTE for anyone with an existing saved sector selection of
// "Industrial > Manufacturing", "Industrial > Engineering & Construction", or
// "Government & Public Sector > Education": that exact sub-sector label no
// longer exists in this list — re-pick the new standalone sector instead.

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
    keywords: ['industrial', 'logistics', 'supply chain', 'automotive'],
    subSectors: [
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
      { label: 'Non-profit / NGO', keywords: ['ngo', 'non-profit', 'nonprofit', 'foundation'] },
      { label: 'Defense & Security', keywords: ['defense', 'defence', 'security agency'] },
    ],
  },
  {
    label: 'Construction',
    keywords: ['construction', 'contractor', 'built environment', 'infrastructure', 'epc'],
    subSectors: [
      { label: 'General & Commercial Contracting', keywords: ['general contractor', 'commercial construction', 'main contractor', 'building contractor'] },
      { label: 'Civil & Infrastructure', keywords: ['civil engineering', 'infrastructure', 'highways', 'rail infrastructure', 'heavy civil'] },
      { label: 'Residential & Housebuilding', keywords: ['residential construction', 'housebuilder', 'homebuilder', 'house building'] },
      { label: 'Specialist & MEP Contracting', keywords: ['mep contractor', 'specialist contractor', 'mechanical electrical plumbing', 'fit-out'] },
      { label: 'Construction Technology', keywords: ['contech', 'construction technology', 'bim software'] },
    ],
  },
  {
    label: 'Manufacturing',
    keywords: ['manufacturing', 'factory', 'production', 'industrial manufactur'],
    subSectors: [
      { label: 'Industrial & Heavy Manufacturing', keywords: ['heavy manufacturing', 'industrial manufacturing', 'machinery manufactur', 'metals manufactur'] },
      { label: 'Consumer Goods Manufacturing', keywords: ['consumer goods manufactur', 'fmcg manufactur', 'packaged goods manufactur'] },
      { label: 'Automotive Manufacturing', keywords: ['automotive manufactur', 'vehicle manufactur', 'auto parts manufactur', 'oem'] },
      { label: 'Electronics & Semiconductor Manufacturing', keywords: ['electronics manufactur', 'semiconductor manufactur', 'contract manufactur', 'pcb manufactur'] },
      { label: 'Aerospace & Defense Manufacturing', keywords: ['aerospace manufactur', 'defense manufactur', 'defence manufactur', 'aviation manufactur'] },
    ],
  },
  {
    label: 'Education',
    keywords: ['education', 'school', 'university', 'academy', 'edtech'],
    subSectors: [
      { label: 'Higher Education', keywords: ['university', 'college', 'higher education'] },
      { label: 'K-12 & Schools', keywords: ['school', 'k-12', 'primary school', 'secondary school', 'academy trust', 'independent school'] },
      { label: 'EdTech', keywords: ['edtech', 'education technology', 'e-learning platform', 'learning platform'] },
      { label: 'Vocational & Training Providers', keywords: ['vocational training', 'apprenticeship provider', 'training provider', 'further education'] },
    ],
  },
  {
    label: 'Marketing, Media & Advertising',
    keywords: ['marketing', 'advertising', 'media', 'agency', 'publishing'],
    subSectors: [
      { label: 'Advertising & Creative Agencies', keywords: ['advertising agency', 'creative agency', 'ad agency'] },
      { label: 'Digital & Marketing Agencies', keywords: ['digital agency', 'marketing agency', 'performance marketing agency', 'growth agency'] },
      { label: 'Media & Broadcasting', keywords: ['broadcasting', 'television network', 'radio network', 'media company', 'streaming service'] },
      { label: 'Publishing', keywords: ['publishing', 'publisher', 'magazine publisher', 'newspaper'] },
      { label: 'PR & Communications Agencies', keywords: ['pr agency', 'public relations agency', 'communications agency'] },
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

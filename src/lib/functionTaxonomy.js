// Single source of truth for job FUNCTIONS (the discipline a candidate works in,
// e.g. Finance, HSE, Construction) as distinct from sectorTaxonomy.js which covers
// the INDUSTRY a company sits in. A recruiter is usually defined by both axes at
// once (e.g. "Finance leaders in Financial Services", "HSE managers in Construction").
// Same shape as sectorTaxonomy.js on purpose, so SectorPicker.jsx works unchanged
// against either taxonomy, and matching logic (realGroupMatch/softGroupMatch) reads
// FLAT_FUNCTION_OPTIONS the same way it reads FLAT_SECTOR_OPTIONS.

export const FUNCTION_TAXONOMY = [
  {
    label: 'Strategy & Corporate Development',
    keywords: ['strategy', 'corporate development', 'chief of staff', 'business planning', 'm&a'],
    subSectors: [
      { label: 'Corporate Strategy', keywords: ['corporate strategy', 'head of strategy', 'strategy director'] },
      { label: 'M&A & Corporate Development', keywords: ['m&a', 'mergers and acquisitions', 'corporate development'] },
      { label: 'Chief of Staff', keywords: ['chief of staff'] },
      { label: 'Business Planning & Transformation', keywords: ['business planning', 'transformation', 'change management'] },
    ],
  },
  {
    label: 'Policy & Government Affairs',
    keywords: ['policy', 'government affairs', 'public affairs', 'regulatory affairs', 'government relations'],
    subSectors: [
      { label: 'Public Policy', keywords: ['public policy', 'policy advisor', 'policy analyst'] },
      { label: 'Government Relations', keywords: ['government relations', 'government affairs'] },
      { label: 'Regulatory Affairs', keywords: ['regulatory affairs', 'regulatory strategy'] },
      { label: 'Public Affairs & Advocacy', keywords: ['public affairs', 'advocacy', 'lobbying'] },
    ],
  },
  {
    label: 'HSE, Sustainability & Quality',
    keywords: ['hse', 'health and safety', 'ehs', 'qhse', 'environmental', 'sustainability', 'esg', 'quality assurance'],
    subSectors: [
      { label: 'Health & Safety', keywords: ['health and safety', 'hse manager', 'safety officer', 'ehs'] },
      { label: 'Environmental Management', keywords: ['environmental manager', 'environmental compliance'] },
      { label: 'Sustainability & ESG', keywords: ['sustainability', 'esg', 'climate', 'net zero'] },
      { label: 'Quality Assurance & Control', keywords: ['quality assurance', 'quality control', 'qa manager', 'qhse'] },
    ],
  },
  {
    label: 'Construction & Built Environment',
    keywords: ['construction', 'civil engineer', 'site manager', 'quantity surveyor', 'mep', 'architect'],
    subSectors: [
      { label: 'Civil & Structural Engineering', keywords: ['civil engineer', 'structural engineer'] },
      { label: 'Project & Programme Management', keywords: ['project manager', 'programme manager', 'project director'] },
      { label: 'Architecture & Design', keywords: ['architect', 'architectural designer'] },
      { label: 'MEP Engineering', keywords: ['mep engineer', 'mechanical electrical plumbing'] },
      { label: 'Site Management & Quantity Surveying', keywords: ['site manager', 'quantity surveyor', 'site engineer'] },
    ],
  },
  {
    label: 'Healthcare & Clinical',
    keywords: ['doctor', 'physician', 'clinical', 'nurse', 'healthcare', 'medical', 'pharma', 'life sciences'],
    subSectors: [
      { label: 'Clinical & Medical', keywords: ['physician', 'doctor', 'clinician', 'medical director'] },
      { label: 'Nursing', keywords: ['nurse', 'nursing', 'matron'] },
      { label: 'Allied Health', keywords: ['physiotherapist', 'radiographer', 'allied health'] },
      { label: 'Healthcare Administration', keywords: ['healthcare administrator', 'hospital administrator'] },
      { label: 'Pharma & Life Sciences', keywords: ['pharma', 'pharmaceutical', 'life sciences', 'biotech'] },
    ],
  },
  {
    label: 'Finance & Accounting',
    keywords: ['finance', 'accounting', 'cfo', 'controller', 'treasury', 'fp&a', 'tax'],
    subSectors: [
      { label: 'Financial Planning & Analysis', keywords: ['fp&a', 'financial planning and analysis', 'financial analyst'] },
      { label: 'Accounting & Controllership', keywords: ['accountant', 'controller', 'financial controller'] },
      { label: 'Treasury', keywords: ['treasury', 'treasurer'] },
      { label: 'Tax', keywords: ['tax manager', 'tax director', 'tax advisor'] },
    ],
  },
  {
    label: 'HR & People',
    keywords: ['hr', 'human resources', 'people', 'talent', 'chro', 'recruit', 'compensation', 'benefits'],
    subSectors: [
      { label: 'Talent Acquisition', keywords: ['talent acquisition', 'recruiter', 'recruitment manager'] },
      { label: 'HR Business Partnering', keywords: ['hr business partner', 'hrbp'] },
      { label: 'Compensation & Benefits', keywords: ['compensation', 'benefits', 'total rewards'] },
      { label: 'Learning & Development', keywords: ['learning and development', 'l&d', 'talent development'] },
      { label: 'People Operations', keywords: ['people operations', 'hr operations'] },
    ],
  },
  {
    label: 'Legal & Compliance',
    keywords: ['legal', 'counsel', 'compliance', 'regulatory'],
    subSectors: [
      { label: 'In-house Counsel', keywords: ['general counsel', 'in-house counsel', 'legal counsel'] },
      { label: 'Compliance', keywords: ['compliance officer', 'compliance manager', 'mlro'] },
      { label: 'Regulatory', keywords: ['regulatory counsel', 'regulatory affairs'] },
      { label: 'Contracts', keywords: ['contracts manager', 'contract counsel'] },
    ],
  },
  {
    label: 'Sales & Business Development',
    keywords: ['sales', 'business development', 'revenue', 'account executive', 'partnerships'],
    subSectors: [
      { label: 'Sales', keywords: ['sales director', 'sales manager', 'account executive', 'vp sales'] },
      { label: 'Business Development', keywords: ['business development manager', 'bd director'] },
      { label: 'Account Management', keywords: ['account manager', 'key account manager'] },
      { label: 'Partnerships & Alliances', keywords: ['partnerships', 'alliances manager'] },
    ],
  },
  {
    label: 'Marketing, Communications & Creative',
    keywords: ['marketing', 'cmo', 'brand', 'communications', 'pr', 'creative', 'content'],
    subSectors: [
      { label: 'Brand & Marketing', keywords: ['brand manager', 'marketing director', 'cmo'] },
      { label: 'Digital Marketing', keywords: ['digital marketing', 'growth marketing', 'performance marketing'] },
      { label: 'PR & Communications', keywords: ['public relations', 'communications director', 'pr manager'] },
      { label: 'Content & Creative', keywords: ['content manager', 'creative director', 'designer', 'copywriter'] },
    ],
  },
  {
    label: 'Operations & Supply Chain',
    keywords: ['operations', 'coo', 'supply chain', 'logistics', 'procurement', 'sourcing'],
    subSectors: [
      { label: 'Operations Management', keywords: ['operations manager', 'operations director', 'coo'] },
      { label: 'Supply Chain', keywords: ['supply chain manager', 'supply chain director'] },
      { label: 'Logistics', keywords: ['logistics manager', 'freight', 'distribution manager'] },
      { label: 'Procurement & Sourcing', keywords: ['procurement manager', 'sourcing manager', 'buyer'] },
    ],
  },
  {
    label: 'Technology, Data & Engineering',
    keywords: ['engineer', 'developer', 'cto', 'technology', 'software', 'it director', 'data', 'cybersecurity'],
    subSectors: [
      { label: 'Software Engineering', keywords: ['software engineer', 'developer', 'engineering manager'] },
      { label: 'IT Infrastructure', keywords: ['it director', 'it manager', 'infrastructure engineer'] },
      { label: 'Cybersecurity', keywords: ['cybersecurity', 'security engineer', 'ciso'] },
      { label: 'Product Management', keywords: ['product manager', 'head of product', 'cpo'] },
      { label: 'Data & Analytics', keywords: ['data scientist', 'data analyst', 'data engineer', 'analytics'] },
    ],
  },
  {
    label: 'Investment & Asset Management',
    keywords: ['investment', 'portfolio manager', 'asset management', 'fund manager', 'private equity', 'venture capital', 'wealth management'],
    subSectors: [
      { label: 'Portfolio Management', keywords: ['portfolio manager', 'fund manager'] },
      { label: 'Private Equity & Venture Capital', keywords: ['private equity', 'venture capital', 'investment associate'] },
      { label: 'Investment Research & Analysis', keywords: ['investment analyst', 'research analyst'] },
      { label: 'Wealth Management', keywords: ['wealth manager', 'private banker', 'relationship manager'] },
    ],
  },
  {
    label: 'Risk & Audit',
    keywords: ['risk', 'audit', 'internal audit', 'credit risk', 'financial crime', 'aml'],
    subSectors: [
      { label: 'Risk Management', keywords: ['risk manager', 'chief risk officer', 'cro'] },
      { label: 'Internal Audit', keywords: ['internal audit', 'internal auditor'] },
      { label: 'Credit Risk', keywords: ['credit risk', 'credit analyst'] },
      { label: 'Financial Crime & AML', keywords: ['financial crime', 'aml', 'fraud'] },
    ],
  },
  {
    label: 'Manufacturing & Production',
    keywords: ['manufacturing', 'production', 'plant manager', 'factory', 'quality control'],
    subSectors: [
      { label: 'Production Management', keywords: ['production manager', 'production supervisor'] },
      { label: 'Manufacturing Engineering', keywords: ['manufacturing engineer', 'process engineer'] },
      { label: 'Plant Management', keywords: ['plant manager', 'factory manager'] },
    ],
  },
  {
    label: 'Real Estate, Facilities & Hospitality',
    keywords: ['property', 'real estate', 'facilities', 'leasing', 'hospitality', 'hotel'],
    subSectors: [
      { label: 'Property & Real Estate Management', keywords: ['property manager', 'real estate manager', 'leasing manager'] },
      { label: 'Facilities Management', keywords: ['facilities manager', 'facilities director'] },
      { label: 'Hospitality & Hotel Management', keywords: ['hotel manager', 'hospitality manager', 'general manager hotel'] },
      { label: 'Events', keywords: ['events manager', 'events director'] },
    ],
  },
  {
    label: 'General Management / Executive Leadership',
    keywords: ['ceo', 'managing director', 'general manager', 'president', 'founder', 'board', 'non-executive'],
    subSectors: [
      { label: 'C-Suite', keywords: ['ceo', 'cfo', 'coo', 'cto', 'chief executive'] },
      { label: 'Managing Director / General Manager', keywords: ['managing director', 'general manager'] },
      { label: 'Board & Non-Executive', keywords: ['board member', 'non-executive director', 'chairman'] },
    ],
  },
  {
    label: 'Administration & Office Support',
    keywords: ['executive assistant', 'office manager', 'administration', 'admin'],
    subSectors: [
      { label: 'Executive & Personal Assistant', keywords: ['executive assistant', 'personal assistant', 'ea to'] },
      { label: 'Office Management', keywords: ['office manager', 'office administrator'] },
    ],
  },
  {
    label: 'Customer Service & Success',
    keywords: ['customer success', 'customer support', 'client services'],
    subSectors: [
      { label: 'Customer Success', keywords: ['customer success manager', 'customer success director'] },
      { label: 'Customer Support', keywords: ['customer support', 'support manager'] },
      { label: 'Client Services', keywords: ['client services', 'client relationship manager'] },
    ],
  },
  {
    label: 'Education & Training',
    keywords: ['teacher', 'professor', 'academia', 'training', 'instructional design'],
    subSectors: [
      { label: 'Teaching & Academia', keywords: ['teacher', 'professor', 'lecturer', 'academic'] },
      { label: 'Corporate Training', keywords: ['corporate trainer', 'training manager'] },
      { label: 'Instructional Design', keywords: ['instructional designer', 'curriculum designer'] },
    ],
  },
]

// Flat list, one entry per whole category (keywords = union of its sub-functions)
// plus one entry per individual sub-function ("Parent > Sub"). This is what the
// LinkedIn import matching logic reads, mirroring FLAT_SECTOR_OPTIONS exactly.
export const FLAT_FUNCTION_OPTIONS = FUNCTION_TAXONOMY.flatMap(cat => [
  {
    label: cat.label,
    keywords: [...new Set([...cat.keywords, ...cat.subSectors.flatMap(s => s.keywords)])],
  },
  ...cat.subSectors.map(s => ({ label: `${cat.label} > ${s.label}`, keywords: s.keywords })),
])

export const FUNCTION_PARENT_LABELS = FUNCTION_TAXONOMY.map(c => c.label)

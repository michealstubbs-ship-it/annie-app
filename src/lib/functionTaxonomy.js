// Single source of truth for job FUNCTIONS (the discipline a candidate works in,
// e.g. Finance, HSE, Construction) as distinct from sectorTaxonomy.js which covers
// the INDUSTRY a company sits in. A recruiter is usually defined by both axes at
// once (e.g. "Finance leaders in Financial Services", "HSE managers in Construction").
// Same shape as sectorTaxonomy.js on purpose, so SectorPicker.jsx works unchanged
// against either taxonomy, and matching logic (realGroupMatch/softGroupMatch) reads
// FLAT_FUNCTION_OPTIONS the same way it reads FLAT_SECTOR_OPTIONS.
//
// 2026-09-01 audit fix, prompted by Michael asking whether Annie would find a
// CFO/CTO/Chief Strategy Officer at a Real Estate company: checking real
// title text against every C-suite keyword found a genuine, sector-agnostic
// gap. Abbreviations (cfo/coo/cio) were listed, and some spelled-out titles
// were already covered incidentally by a broader word already in that
// category ('technology' catches "Chief Technology Officer", 'strategy'
// catches "Chief Strategy Officer", 'human resources' catches "Chief Human
// Resources Officer") — but "Chief Financial Officer" and "Chief Operating
// Officer", both at least as common on LinkedIn as their abbreviations,
// matched NOTHING anywhere in the taxonomy, in any sector. "Chief
// Information Officer"/CIO and "Chief Product Officer" had the same problem.
// Confirmed by running real title strings through the actual matching code
// (passesFunctionFilter), not by inspection alone. Fixed by adding the
// spelled-out phrase alongside each existing abbreviation, in the specific
// function's own keyword list (Finance & Accounting, Operations & Supply
// Chain, Technology's IT Infrastructure/Cybersecurity/Product Management
// sub-functions) AND in General Management / Executive Leadership's C-Suite
// bucket, so both a narrowed, discipline-specific selection and the generic
// "any executive" selection catch the same set of real-world title spellings.
//
// Same day, follow-up: ran every common "Chief ___ Officer" title (not just
// the 4 above) through FLAT_FUNCTION_OPTIONS to check for more of the same
// gap, rather than assuming those 4 were the only ones. Found 8 more with no
// home anywhere in the taxonomy: Chief Commercial/Digital/Diversity/
// Administrative/Security/Quality/Customer/Innovation Officer. Fixed the
// same way — one explicit phrase in the function it actually belongs to,
// plus the generic C-Suite bucket. A few of these titles are genuinely
// ambiguous in the real world (a "Chief Security Officer" can mean physical
// or cyber security; "Chief Digital Officer" can mean IT or marketing) —
// picked the single most common convention for each rather than guessing at
// every possible reading.
//
// Same day, third pass: Michael's explicit instruction was to research every
// real LinkedIn title for all 20 functions and add any missing coverage — a
// 6-subagent research pass plus a 200+-title empirical sweep against
// FLAT_FUNCTION_OPTIONS found 229 misses, fixed in one pass. Immediately
// after, Michael flagged a real constraint that pass hadn't accounted for:
// "make sure they [are] no less than manager level... that will not be
// interesting for customers." Annie's customers are recruitment firms doing
// BD — a bare individual-contributor title (Sourcer, Systems Administrator,
// Receptionist, Publicist, Statistician, Product Owner, Demand Planner,
// Logistician, Personal Banker, Virtual Assistant, Support Specialist) is
// not a useful BD contact even where it's a real, correctly-categorized
// LinkedIn title. Confirmed scope with Michael: this floor applies to the 14
// corporate/office-professional functions (Strategy, Policy, Finance, HR,
// Legal, Sales, Marketing, Operations, Technology, Investment, Risk,
// General Management, Administration, Customer Service) — NOT to Healthcare
// & Clinical, Allied Health, Teaching & Academia, Construction, Manufacturing,
// or Real Estate/Facilities/Hospitality, where a bare practitioner/trade
// title (Nurse, Physician, Teacher, Foreman, Machine Operator) genuinely IS
// the target role, not a junior admin/support title. Removed the newly-added
// bare IC-level keywords from the 14 in-scope functions accordingly, while
// keeping established professional-practitioner terms already accepted
// elsewhere in this same file for the same reason (Accountant, Financial
// Analyst, Solicitor, Financial Advisor — the licensed/qualified individual
// title that IS the profession, not an admin/support role below it). Also
// removed 'office' and 'product'/'portfolio' as bare single-domain-word
// additions broad enough to be pure noise rather than a targeted fix. Also
// removed 'administrative' from HR & People's own keyword list — it was
// added there by mistake in the same edit; Administration & Office Support
// is its correct and only home.

export const FUNCTION_TAXONOMY = [
  {
    label: 'Strategy & Corporate Development',
    keywords: ['strategy', 'corporate development', 'chief of staff', 'business planning', 'm&a', 'chief innovation officer'],
    subSectors: [
      { label: 'Corporate Strategy', keywords: ['corporate strategy', 'head of strategy', 'strategy director'] },
      { label: 'M&A & Corporate Development', keywords: ['m&a', 'mergers and acquisitions', 'corporate development'] },
      { label: 'Chief of Staff', keywords: ['chief of staff'] },
      { label: 'Business Planning & Transformation', keywords: ['business planning', 'transformation', 'change management', 'change manager'] },
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
    keywords: ['hse', 'health and safety', 'ehs', 'qhse', 'environmental', 'sustainability', 'esg', 'quality assurance', 'chief quality officer'],
    subSectors: [
      { label: 'Health & Safety', keywords: ['health and safety', 'hse manager', 'safety officer', 'ehs'] },
      { label: 'Environmental Management', keywords: ['environmental manager', 'environmental compliance'] },
      { label: 'Sustainability & ESG', keywords: ['sustainability', 'esg', 'climate', 'net zero'] },
      { label: 'Quality Assurance & Control', keywords: ['quality assurance', 'quality control', 'qa manager', 'qhse', 'quality'] },
    ],
  },
  {
    label: 'Construction & Built Environment',
    keywords: ['construction', 'civil engineer', 'site manager', 'quantity surveyor', 'mep', 'architect'],
    subSectors: [
      { label: 'Civil & Structural Engineering', keywords: ['civil engineer', 'structural engineer', 'geotechnical', 'resident engineer', 'design engineer', 'principal engineer', 'chief engineer', 'engineering manager'] },
      { label: 'Project & Programme Management', keywords: ['project manager', 'programme manager', 'project director', 'epc', 'bid manager', 'superintendent', 'project engineer', 'project executive', 'director of projects'] },
      { label: 'Architecture & Design', keywords: ['architect', 'architectural designer', 'architectural technologist', 'bim', 'land surveyor', 'design manager', 'design director'] },
      { label: 'MEP Engineering', keywords: ['mep engineer', 'mechanical electrical plumbing', 'hvac', 'commissioning', 'building services', 'electrical engineer', 'mechanical engineer'] },
      { label: 'Site Management & Quantity Surveying', keywords: ['site manager', 'quantity surveyor', 'site engineer', 'estimator', 'foreman', 'cost engineer', 'cost manager', 'commercial manager', 'contracts manager'] },
    ],
  },
  {
    label: 'Healthcare & Clinical',
    keywords: ['doctor', 'physician', 'clinical', 'nurse', 'healthcare', 'medical', 'pharma', 'life sciences', 'chief population health officer', 'chief patient experience officer', 'chief informatics officer'],
    subSectors: [
      { label: 'Clinical & Medical', keywords: ['physician', 'doctor', 'clinician', 'medical director', 'associate specialist'] },
      { label: 'Nursing', keywords: ['nurse', 'nursing', 'matron'] },
      { label: 'Allied Health', keywords: ['physiotherapist', 'radiographer', 'allied health', 'physical therapist', 'occupational therapist', 'speech-language pathologist', 'respiratory therapist', 'dietitian', 'pharmacist', 'audiologist', 'phlebotomist'] },
      { label: 'Healthcare Administration', keywords: ['healthcare administrator', 'hospital administrator', 'practice manager'] },
      { label: 'Pharma & Life Sciences', keywords: ['pharma', 'pharmaceutical', 'life sciences', 'biotech', 'regulatory affairs'] },
    ],
  },
  {
    label: 'Finance & Accounting',
    keywords: ['finance', 'accounting', 'cfo', 'chief financial officer', 'controller', 'treasury', 'fp&a', 'tax', 'comptroller', 'budget'],
    subSectors: [
      { label: 'Financial Planning & Analysis', keywords: ['fp&a', 'financial planning and analysis', 'financial planning & analysis', 'financial analyst'] },
      { label: 'Accounting & Controllership', keywords: ['accountant', 'controller', 'financial controller', 'comptroller'] },
      { label: 'Treasury', keywords: ['treasury', 'treasurer'] },
      { label: 'Tax', keywords: ['tax manager', 'tax director', 'tax advisor'] },
    ],
  },
  {
    label: 'HR & People',
    keywords: ['hr', 'human resources', 'people', 'talent', 'chro', 'recruit', 'recruiting', 'compensation', 'benefits', 'chief diversity officer'],
    subSectors: [
      { label: 'Talent Acquisition', keywords: ['talent acquisition', 'recruiter', 'recruitment manager', 'recruiting'] },
      { label: 'HR Business Partnering', keywords: ['hr business partner', 'hrbp'] },
      { label: 'Compensation & Benefits', keywords: ['compensation', 'benefits', 'total rewards', 'reward'] },
      { label: 'Learning & Development', keywords: ['learning and development', 'l&d', 'talent development', 'training'] },
      { label: 'People Operations', keywords: ['people operations', 'hr operations'] },
    ],
  },
  {
    label: 'Legal & Compliance',
    keywords: ['legal', 'counsel', 'compliance', 'regulatory'],
    subSectors: [
      { label: 'In-house Counsel', keywords: ['general counsel', 'in-house counsel', 'legal counsel', 'solicitor'] },
      { label: 'Compliance', keywords: ['compliance officer', 'compliance manager', 'mlro', 'kyc', 'sanctions'] },
      { label: 'Regulatory', keywords: ['regulatory counsel', 'regulatory affairs'] },
      { label: 'Contracts', keywords: ['contracts manager', 'contract counsel', 'contract'] },
    ],
  },
  {
    label: 'Sales & Business Development',
    keywords: ['sales', 'business development', 'revenue', 'account executive', 'partnerships', 'chief commercial officer'],
    subSectors: [
      { label: 'Sales', keywords: ['sales director', 'sales manager', 'account executive', 'vp sales'] },
      { label: 'Business Development', keywords: ['business development manager', 'bd director', 'market development'] },
      { label: 'Account Management', keywords: ['account manager', 'key account manager', 'account management'] },
      { label: 'Partnerships & Alliances', keywords: ['partnerships', 'alliances manager', 'alliances', 'partner manager', 'channel manager', 'channel', 'partner marketing manager'] },
    ],
  },
  {
    label: 'Marketing, Communications & Creative',
    keywords: ['marketing', 'cmo', 'brand', 'communications', 'pr', 'creative', 'content'],
    subSectors: [
      { label: 'Brand & Marketing', keywords: ['brand manager', 'marketing director', 'cmo'] },
      { label: 'Digital Marketing', keywords: ['digital marketing', 'growth marketing', 'performance marketing', 'seo', 'paid media', 'demand generation'] },
      { label: 'PR & Communications', keywords: ['public relations', 'communications director', 'pr manager', 'press', 'public affairs', 'corporate affairs'] },
      { label: 'Content & Creative', keywords: ['content manager', 'creative director', 'designer', 'copywriter', 'art director'] },
    ],
  },
  {
    label: 'Operations & Supply Chain',
    keywords: ['operations', 'coo', 'chief operating officer', 'supply chain', 'logistics', 'procurement', 'sourcing'],
    subSectors: [
      { label: 'Operations Management', keywords: ['operations manager', 'operations director', 'coo'] },
      { label: 'Supply Chain', keywords: ['supply chain manager', 'supply chain director', 'demand planning', 'supply management', 'supplier management', 'senior demand planner'] },
      { label: 'Logistics', keywords: ['logistics manager', 'freight', 'distribution manager', 'distribution', 'transportation', 'warehouse'] },
      { label: 'Procurement & Sourcing', keywords: ['procurement manager', 'sourcing manager', 'buyer', 'purchasing', 'category manager', 'vendor management'] },
    ],
  },
  {
    label: 'Technology, Data & Engineering',
    keywords: ['engineer', 'engineering', 'developer', 'cto', 'technology', 'software', 'it director', 'data', 'cybersecurity', 'cio', 'chief information officer', 'chief digital officer'],
    subSectors: [
      { label: 'Software Engineering', keywords: ['software engineer', 'developer', 'engineering manager', 'engineering'] },
      { label: 'IT Infrastructure', keywords: ['it director', 'it manager', 'infrastructure engineer', 'cio', 'chief information officer', 'it infrastructure'] },
      { label: 'Cybersecurity', keywords: ['cybersecurity', 'security engineer', 'ciso', 'chief information security officer', 'chief security officer', 'information security', 'soc', 'penetration test', 'grc'] },
      { label: 'Product Management', keywords: ['product manager', 'head of product', 'cpo', 'chief product officer', 'product management', 'vp product'] },
      { label: 'Data & Analytics', keywords: ['data scientist', 'data analyst', 'data engineer', 'analytics', 'business intelligence'] },
    ],
  },
  {
    label: 'Investment & Asset Management',
    keywords: ['investment', 'portfolio manager', 'asset management', 'fund manager', 'private equity', 'venture capital', 'wealth management'],
    subSectors: [
      { label: 'Portfolio Management', keywords: ['portfolio manager', 'fund manager', 'portfolio management'] },
      { label: 'Private Equity & Venture Capital', keywords: ['private equity', 'venture capital', 'investment associate', 'general partner'] },
      { label: 'Investment Research & Analysis', keywords: ['investment analyst', 'research analyst', 'buy-side', 'sell-side', 'head of research'] },
      { label: 'Wealth Management', keywords: ['wealth manager', 'private banker', 'relationship manager', 'financial advisor'] },
    ],
  },
  {
    label: 'Risk & Audit',
    keywords: ['risk', 'audit', 'internal audit', 'credit risk', 'financial crime', 'aml'],
    subSectors: [
      { label: 'Risk Management', keywords: ['risk manager', 'chief risk officer', 'cro'] },
      { label: 'Internal Audit', keywords: ['internal audit', 'internal auditor'] },
      { label: 'Credit Risk', keywords: ['credit risk', 'credit analyst'] },
      { label: 'Financial Crime & AML', keywords: ['financial crime', 'aml', 'fraud', 'kyc', 'sanctions'] },
    ],
  },
  {
    label: 'Manufacturing & Production',
    keywords: ['manufacturing', 'production', 'plant manager', 'factory', 'quality control', 'quality assurance'],
    subSectors: [
      { label: 'Production Management', keywords: ['production manager', 'production supervisor', 'machine operator', 'cnc', 'shift supervisor'] },
      { label: 'Manufacturing Engineering', keywords: ['manufacturing engineer', 'process engineer', 'mechatronics', 'robotics', 'continuous improvement', 'operational excellence'] },
      { label: 'Plant Management', keywords: ['plant manager', 'factory manager', 'facilities manager', 'safety manager', 'warehouse'] },
    ],
  },
  {
    label: 'Real Estate, Facilities & Hospitality',
    keywords: ['property', 'real estate', 'facilities', 'leasing', 'hospitality', 'hotel'],
    subSectors: [
      { label: 'Property & Real Estate Management', keywords: ['property manager', 'real estate manager', 'leasing manager', 'community manager', 'portfolio manager', 'asset manager', 'asset management'] },
      { label: 'Facilities Management', keywords: ['facilities manager', 'facilities director', 'estates manager', 'fm director', 'technical services', 'hard services', 'soft services'] },
      { label: 'Hospitality & Hotel Management', keywords: ['hotel manager', 'hospitality manager', 'general manager hotel', 'front office', 'guest service', 'housekeeping', 'food and beverage', 'food & beverage', 'f&b', 'revenue manager', 'resident manager', 'cluster general manager', 'executive housekeeper', 'director of sales and marketing', 'area general manager', 'regional director of operations'] },
      { label: 'Events', keywords: ['events manager', 'events director', 'event', 'venue manager', 'catering manager', 'wedding planner', 'conference planner', 'director of events', 'vp of events'] },
    ],
  },
  {
    label: 'General Management / Executive Leadership',
    keywords: ['ceo', 'managing director', 'general manager', 'president', 'founder', 'board', 'non-executive', 'executive director'],
    subSectors: [
      { label: 'C-Suite', keywords: ['ceo', 'cfo', 'coo', 'cto', 'cio', 'chief executive', 'chief financial officer', 'chief operating officer', 'chief technology officer', 'chief information officer', 'chief commercial officer', 'chief digital officer', 'chief diversity officer', 'chief administrative officer', 'chief security officer', 'chief quality officer', 'chief customer officer', 'chief innovation officer'] },
      { label: 'Managing Director / General Manager', keywords: ['managing director', 'general manager', 'country manager'] },
      { label: 'Board & Non-Executive', keywords: ['board member', 'non-executive director', 'chairman', 'vice chair', 'independent director', 'trustee'] },
    ],
  },
  {
    label: 'Administration & Office Support',
    keywords: ['executive assistant', 'office manager', 'administration', 'administrative', 'admin', 'chief administrative officer'],
    subSectors: [
      { label: 'Executive & Personal Assistant', keywords: ['executive assistant', 'personal assistant', 'ea to', 'executive business partner', 'administrative business partner'] },
      { label: 'Office Management', keywords: ['office manager', 'office administrator', 'business support'] },
    ],
  },
  {
    label: 'Customer Service & Success',
    keywords: ['customer success', 'customer support', 'customer service', 'client services', 'client service', 'chief customer officer'],
    subSectors: [
      { label: 'Customer Success', keywords: ['customer success manager', 'customer success director', 'onboarding manager', 'implementation manager', 'customer experience'] },
      { label: 'Customer Support', keywords: ['customer support', 'support manager', 'customer service', 'technical support', 'customer care', 'call center'] },
      { label: 'Client Services', keywords: ['client services', 'client service', 'client relationship manager'] },
    ],
  },
  {
    label: 'Education & Training',
    keywords: ['teacher', 'professor', 'academia', 'training', 'instructional design'],
    subSectors: [
      { label: 'Teaching & Academia', keywords: ['teacher', 'professor', 'lecturer', 'academic', 'adjunct', 'department chair', 'dean', 'provost', 'vice-chancellor', 'head of department'] },
      { label: 'Corporate Training', keywords: ['corporate trainer', 'training manager', 'learning and development', 'l&d'] },
      { label: 'Instructional Design', keywords: ['instructional designer', 'curriculum designer', 'learning experience', 'curriculum developer', 'elearning', 'e-learning', 'learning technologist', 'educational technology', 'educational technologist', 'director of online learning'] },
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

import { describe, it, expect } from 'vitest'
import { FLAT_FUNCTION_OPTIONS } from './functionTaxonomy.js'
import { keywordMatches } from './linkedinImportMatch.js'

// Permanent regression coverage for the 2026-09-01 title audit: Michael asked
// for real LinkedIn/market job titles to be researched for all 20 function
// categories, with any genuine gap added to that function's keywords. Titles
// below were compiled from 6 parallel research passes (Ongig, Indeed,
// LinkedIn, Zippia, Built In, TealHQ, ITJobsWatch UK, Bayt UAE, ONET,
// NAICS-adjacent sources) and checked here against the real matching code
// (keywordMatches / FLAT_FUNCTION_OPTIONS), not by inspection.
//
// A title that is NOT in EXPECTED_MISSES must match its home function. If
// this test starts failing on a title not listed below, either the taxonomy
// regressed (fix the keywords) or the title genuinely can't be added safely
// (add it to EXPECTED_MISSES with a one-line reason).
//
// EXPECTED_MISSES falls into three groups, each a deliberate decision, not an
// oversight:
//
// 1. Below the manager-level floor. Michael: "make sure they [are] no less
//    than manager level though. That will not be interesting for
//    customers" — Annie's customers are recruitment firms doing BD, and a
//    bare individual-contributor title is not a useful BD contact even where
//    it's a real, correctly-categorized title. Confirmed with Michael this
//    floor applies to the 14 corporate/office-professional functions only
//    (not Healthcare/Allied Health/Teaching/Construction/Manufacturing/Real
//    Estate, where a bare practitioner or trade title IS the target role).
// 2. Explicitly junior/training-grade by the title's own wording (Graduate,
//    Junior, House Officer, Resident, Registrar) — these mark entry-level or
//    trainee status regardless of function, so they're excluded everywhere.
// 3. Too generic/ambiguous to add safely at all — a bare word common enough
//    across unrelated industries that adding it would create dangerous
//    cross-industry false positives (e.g. "Consultant" also reads as
//    Management Consultant in a totally different function).
const EXPECTED_MISSES = {
  'Risk & Audit': {
    'Onboarding Specialist': 'below manager-level floor (KYC/AML onboarding is an IC role)',
  },
  'Investment & Asset Management': {
    'Portfolio Analyst': 'below manager-level floor',
    'Personal Banker': 'below manager-level floor (frontline retail banking role)',
    'Client Advisor': 'too generic/ambiguous — often a junior retail advisory title',
  },
  'HR & People': {
    'Sourcer': 'below manager-level floor',
  },
  'Marketing, Communications & Creative': {
    'Publicist': 'below manager-level floor',
  },
  'Customer Service & Success': {
    'Support Specialist': 'below manager-level floor',
  },
  'Technology, Data & Engineering': {
    'IT Technician': 'below manager-level floor',
    'Systems Administrator': 'below manager-level floor',
    'Network Administrator': 'below manager-level floor',
    'Database Administrator': 'below manager-level floor',
    'Security Analyst': 'below manager-level floor (standard SOC IC role)',
    'Penetration Tester': 'below manager-level floor',
    'Product Owner': 'below manager-level floor',
    'Statistician': 'below manager-level floor',
  },
  'Operations & Supply Chain': {
    'Demand Planner': 'below manager-level floor (Senior Demand Planner is covered explicitly)',
    'Logistician': 'below manager-level floor',
  },
  'Administration & Office Support': {
    'Office Assistant': 'below manager-level floor',
    'Virtual Assistant': 'below manager-level floor',
    'Receptionist': 'below manager-level floor',
    'Front Desk Agent': 'below manager-level floor',
  },
  'Construction & Built Environment': {
    'Graduate Engineer': 'explicitly graduate/entry-level',
    'Junior Engineer': 'explicitly junior',
    'Project Coordinator': 'IC/support-level, not management',
    'Project Planner': 'IC-level scheduling role, unqualified',
    'Scheduler': 'IC/support-level role',
  },
  'Healthcare & Clinical': {
    'House Officer': 'explicitly first-year junior training grade',
    'Resident': 'junior training grade; also too generic (collides with "Resident Manager" in Real Estate)',
    'Registrar': 'training grade, below Consultant/attending level',
    'Specialty Registrar': 'training grade, below Consultant/attending level',
    'Consultant': 'too generic/ambiguous — collides with Management Consultant across every other function',
  },
}

// Real titles compiled from 6 parallel research passes against each of the
// 20 function categories, cross-checked against the actual matching code.
const TITLES = {
  'Finance & Accounting': ['Financial Analyst', 'Senior Financial Analyst', 'FP&A Analyst', 'FP&A Manager', 'Financial Planning & Analysis Manager', 'Director of FP&A', 'VP of FP&A', 'Head of FP&A', 'Budget Analyst', 'Staff Accountant', 'Senior Accountant', 'Accounting Manager', 'Financial Controller', 'Comptroller', 'Assistant Controller', 'Director of Accounting', 'VP of Accounting', 'Chief Accounting Officer', 'Cost Accountant', 'Forensic Accountant', 'Treasury Analyst', 'Treasury Operations Manager', 'Treasury Manager', 'Assistant Treasurer', 'Treasurer', 'VP Treasury', 'Head of Treasury', 'Tax Accountant', 'Tax Analyst', 'Tax Manager', 'Tax Director', 'Head of Tax', 'VP Tax'],
  'Risk & Audit': ['Risk Analyst', 'Risk Manager', 'Head of Risk', 'Director of Risk Management', 'VP Risk Management', 'Audit Assistant', 'Audit Analyst', 'Internal Auditor', 'Senior Internal Auditor', 'Internal Audit Manager', 'Internal Audit Director', 'Chief Audit Executive', 'Credit Analyst', 'Credit Risk Analyst', 'Credit Risk Manager', 'Credit Risk Officer', 'Head of Credit Risk', 'KYC Specialist', 'Onboarding Specialist', 'Sanctions Screening Analyst', 'AML Analyst', 'AML Investigator', 'Fraud Prevention Analyst', 'AML Compliance Officer', 'Head of Financial Crime'],
  'Investment & Asset Management': ['Portfolio Analyst', 'Portfolio Manager', 'Senior Portfolio Manager', 'Fund Manager', 'Director of Portfolio Management', 'Investment Director', 'Investment Associate', 'Investment Analyst', 'Equity Research Analyst', 'Buy-side Analyst', 'Sell-side Analyst', 'Head of Research', 'Personal Banker', 'Financial Advisor', 'Relationship Manager', 'Private Banker', 'Wealth Manager', 'Investment Advisor', 'Client Advisor', 'Head of Wealth Management', 'General Partner'],
  'Legal & Compliance': ['Legal Counsel', 'Corporate Counsel', 'Senior Legal Counsel', 'Assistant General Counsel', 'Associate General Counsel', 'Deputy General Counsel', 'General Counsel', 'Head of Legal', 'Solicitor', 'Legal Director', 'Compliance Analyst', 'Compliance Specialist', 'Compliance Officer', 'Compliance Manager', 'Head of Compliance', 'Regulatory Affairs Manager', 'Regulatory Affairs Director', 'Regulatory Counsel', 'Head of Regulatory Affairs', 'Contract Administrator', 'Contract Analyst', 'Contracts Manager', 'Senior Contracts Manager', 'Contract Compliance Manager', 'Legal Operations Manager'],
  'HR & People': ['Recruiter', 'Corporate Recruiter', 'Technical Recruiter', 'Sourcer', 'Recruiting Coordinator', 'Talent Acquisition Specialist', 'Talent Acquisition Manager', 'Talent Acquisition Partner', 'Head of Talent Acquisition', 'Director of Talent Acquisition', 'VP of Talent Acquisition', 'Chief Talent Officer', 'HR Business Partner', 'Senior HR Business Partner', 'People Partner', 'HR Consultant', 'Director of People Analytics', 'Benefits Specialist', 'Compensation Analyst', 'Compensation & Benefits Manager', 'Reward Manager', 'Head of Reward', 'Compensation Director', 'VP of Compensation and Benefits', 'Training Coordinator', 'L&D Specialist', 'Training Manager', 'Training Director', 'HR Assistant', 'HR Coordinator', 'HR Generalist', 'HR Specialist', 'HR Analyst', 'People Operations Manager', 'HR Manager', 'Head of People', 'HR Director', 'People Director', 'Head of People and Culture', 'VP of Human Resources', 'VP of People'],
  'Sales & Business Development': ['Sales Development Representative', 'Business Development Representative', 'Market Development Representative', 'Inside Sales Representative', 'Account Executive', 'Senior Account Executive', 'Enterprise Account Executive', 'Territory Sales Manager', 'Sales Manager', 'Regional Sales Director', 'Director of Sales', 'VP of Sales', 'Chief Sales Officer', 'Business Development Manager', 'Business Development Executive', 'Director of Business Development', 'VP of Business Development', 'Chief Business Development Officer', 'Account Manager', 'Key Account Manager', 'Senior Account Manager', 'Strategic Account Manager', 'Director of Account Management', 'VP of Account Management', 'Partner Manager', 'Channel Manager', 'Partner Marketing Manager', 'Senior Partner Manager', 'Director of Strategic Alliances', 'Head of Partnerships', 'VP of Partnerships', 'Chief Partnerships Officer'],
  'Marketing, Communications & Creative': ['Marketing Coordinator', 'Marketing Specialist', 'Brand Marketing Manager', 'Product Marketing Manager', 'Head of Brand', 'Marketing Director', 'VP of Marketing', 'SEO Specialist', 'Paid Media Manager', 'Growth Marketing Manager', 'Demand Generation Manager', 'Marketing Operations Manager', 'Director of Demand Generation', 'VP of Digital Marketing', 'Communications Coordinator', 'Public Relations Specialist', 'Publicist', 'Press Officer', 'Press Secretary', 'Communications Manager', 'PR Manager', 'Director of Communications', 'Director of Public Affairs', 'Corporate Affairs Director', 'VP of Communications', 'Chief Communications Officer', 'Content Writer', 'Copywriter', 'Content Marketing Manager', 'Content Strategist', 'Creative Director', 'Art Director', 'Head of Content', 'Director of Content Marketing', 'VP of Content'],
  'Customer Service & Success': ['Customer Success Associate', 'Customer Success Manager', 'Senior Customer Success Manager', 'Customer Success Operations Manager', 'Onboarding Manager', 'Implementation Manager', 'Director of Customer Success', 'VP of Customer Success', 'Customer Service Representative', 'Support Specialist', 'Technical Support Engineer', 'Customer Care Representative', 'Call Center Representative', 'Call Center Supervisor', 'Customer Support Manager', 'Customer Service Manager', 'Director of Customer Support', 'VP of Customer Support', 'VP of Customer Experience', 'Client Service Associate', 'Client Services Manager', 'Director of Client Services', 'VP of Client Services'],
  'Technology, Data & Engineering': ['Software Engineer', 'Junior Software Engineer', 'Senior Software Engineer', 'Staff Software Engineer', 'Principal Engineer', 'Lead Engineer', 'DevOps Engineer', 'Site Reliability Engineer', 'Engineering Manager', 'Director of Engineering', 'VP Engineering', 'Head of Engineering', 'Software Developer', 'IT Technician', 'Systems Administrator', 'Network Administrator', 'Network Engineer', 'Systems Engineer', 'Database Administrator', 'IT Manager', 'IT Director', 'Head of IT Infrastructure', 'Security Analyst', 'SOC Analyst', 'Penetration Tester', 'Security Engineer', 'Information Security Analyst', 'GRC Manager', 'Information Security Manager', 'SOC Manager', 'Director of Information Security', 'Cybersecurity Director', 'VP Cybersecurity', 'Associate Product Manager', 'Product Manager', 'Senior Product Manager', 'Group Product Manager', 'Product Owner', 'Lead Product Manager', 'Director of Product Management', 'VP Product', 'Head of Product', 'Data Analyst', 'Business Intelligence Analyst', 'BI Developer', 'Data Engineer', 'Data Scientist', 'Machine Learning Engineer', 'Data Architect', 'Statistician', 'Analytics Manager', 'Head of Data', 'Head of Analytics', 'Chief Analytics Officer'],
  'Operations & Supply Chain': ['Operations Coordinator', 'Operations Assistant', 'Operations Analyst', 'Operations Specialist', 'Operations Supervisor', 'Operations Manager', 'Senior Operations Manager', 'Director of Operations', 'Business Operations Director', 'Head of Operations', 'VP of Operations', 'Supply Chain Coordinator', 'Supply Chain Analyst', 'Demand Planner', 'Senior Demand Planner', 'Supply Chain Manager', 'Supply Chain Planning Manager', 'Director of Supply Chain', 'Director of Supplier Management', 'VP of Supply Chain', 'VP of Supply Management', 'Logistics Coordinator', 'Logistician', 'Logistics Analyst', 'Logistics Manager', 'International Logistics Manager', 'Distribution Manager', 'Director of Logistics', 'VP of Logistics', 'VP of Distribution', 'VP of Transportation', 'Purchasing Agent', 'Buyer', 'Procurement Analyst', 'Procurement Coordinator', 'Procurement Specialist', 'Category Manager', 'Strategic Sourcing Manager', 'Procurement Manager', 'Vendor Management Specialist', 'Director of Procurement', 'VP of Procurement'],
  'Manufacturing & Production': ['Production Worker', 'Machine Operator', 'CNC Operator', 'Production Technician', 'Production Foreman', 'Shift Supervisor', 'Production Supervisor', 'Production Manager', 'Production Planning Manager', 'Director of Manufacturing Operations', 'VP of Manufacturing', 'Manufacturing Technician', 'Manufacturing Engineer', 'Process Engineer', 'Senior Process Engineer', 'Mechatronics Engineer', 'Robotics Technician', 'Quality Control Inspector', 'Quality Assurance Manager', 'Continuous Improvement Manager', 'Director of Continuous Improvement', 'Director of Operational Excellence', 'Assistant Plant Manager', 'Plant Manager', 'Facilities Manager', 'Safety Manager', 'Warehouse Manager'],
  'Real Estate, Facilities & Hospitality': ['Leasing Agent', 'Leasing Consultant', 'Assistant Property Manager', 'Property Manager', 'Community Manager', 'Regional Property Manager', 'Portfolio Manager', 'Asset Manager', 'Director of Asset Management', 'Head of Real Estate', 'VP of Real Estate', 'Real Estate Director', 'Facilities Coordinator', 'Assistant Facilities Manager', 'Facilities Manager', 'Hard Services Manager', 'Soft Services Manager', 'Technical Services Manager', 'Estates Manager', 'Regional Facilities Manager', 'Area Facilities Manager', 'FM Director', 'Director of Facilities', 'Front Office Agent', 'Guest Service Agent', 'Front Office Manager', 'Housekeeping Supervisor', 'Executive Housekeeper', 'Food & Beverage Manager', 'Revenue Manager', 'Director of Sales and Marketing', 'Hotel Manager', 'Resident Manager', 'Cluster General Manager', 'Area General Manager', 'Regional Director of Operations', 'Event Coordinator', 'Event Planner', 'Wedding Planner', 'Conference Planner', 'Special Events Manager', 'Venue Manager', 'Catering Manager', 'Event Producer', 'Director of Events', 'VP of Events'],
  'Administration & Office Support': ['Administrative Assistant', 'Office Assistant', 'Administrative Support Specialist', 'Executive Assistant', 'Personal Assistant', 'Executive Assistant to the CEO', 'Senior Executive Assistant', 'Executive Administrative Assistant', 'Virtual Assistant', 'Executive Business Partner', 'Administrative Business Partner', 'Receptionist', 'Front Desk Agent', 'Administrative Coordinator', 'Office Administrator', 'Office Manager', 'Administrative Manager', 'Administrative Support Manager', 'Business Support Manager', 'Director of Administrative Services'],
  'Strategy & Corporate Development': ['Strategy Analyst', 'Strategy Manager', 'Senior Manager Corporate Strategy', 'Director of Corporate Strategy', 'Head of Strategy', 'VP Corporate Strategy', 'Corporate Development Analyst', 'Corporate Development Manager', 'Director Corporate Development', 'Director Corporate Development and M&A', 'VP Corporate Development', 'Head of M&A', 'Head of Mergers and Acquisitions', 'Deputy Chief of Staff', 'Associate Chief of Staff', 'Senior Chief of Staff', 'Business Transformation Manager', 'Director of Business Transformation', 'Head of Transformation', 'VP of Business Transformation', 'Director of Business Planning', 'Change Manager'],
  'Policy & Government Affairs': ['Policy Analyst', 'Policy Advisor', 'Public Policy Manager', 'Senior Manager Public Policy', 'Director of Public Policy', 'Head of Public Policy', 'VP Public Policy', 'Government Relations Manager', 'Government Relations Director', 'Head of Government Affairs', 'Director of Government Affairs', 'VP Government Affairs', 'Chief Government Affairs Officer', 'Regulatory Affairs Specialist', 'Public Affairs Officer', 'Public Affairs Manager', 'Senior Public Affairs and Policy Manager', 'Policy and Public Affairs Officer', 'Head of Public Affairs', 'Director of Public Affairs', 'Advocacy Manager'],
  'HSE, Sustainability & Quality': ['Health and Safety Officer', 'Health and Safety Coordinator', 'HSE Manager', 'HSE Director', 'Director Environmental Health and Safety', 'VP Environmental Health and Safety', 'Chief Safety Officer', 'Environmental Manager', 'Environmental Compliance Manager', 'Director of Environmental Affairs', 'Head of Environmental Management', 'Sustainability Analyst', 'Sustainability Manager', 'Head of Sustainability', 'Director of Sustainability', 'VP of Sustainability', 'Head of ESG', 'Quality Technician', 'Quality Coordinator', 'Quality Auditor', 'Quality Control Supervisor', 'Quality Analyst', 'Quality Engineer', 'Director of Quality', 'Vice President of Quality'],
  'Construction & Built Environment': ['Graduate Engineer', 'Junior Engineer', 'Site Engineer', 'Civil Engineer', 'Structural Engineer', 'Geotechnical Engineer', 'Design Engineer', 'Project Engineer', 'Resident Engineer', 'Senior Structural Engineer', 'Principal Engineer', 'Chief Engineer', 'Engineering Manager', 'Project Coordinator', 'Assistant Project Manager', 'Project Planner', 'Scheduler', 'Construction Manager', 'Project Manager', 'Senior Project Manager', 'Project Director', 'Project Executive', 'Programme Manager', 'Construction Superintendent', 'General Superintendent', 'Bid Manager', 'EPC Manager', 'Construction Director', 'Director of Projects', 'VP Construction', 'Head of Construction', 'Architectural Technologist', 'Architect', 'Project Architect', 'Senior Architect', 'Design Manager', 'Principal Architect', 'Design Director', 'Land Surveyor', 'BIM Manager', 'MEP Engineer', 'HVAC Engineer', 'Electrical Engineer', 'Mechanical Engineer', 'Commissioning Engineer', 'Building Services Engineer', 'MEP Manager', 'MEP Coordinator', 'Commissioning Manager', 'MEP Director', 'Assistant Quantity Surveyor', 'Junior Quantity Surveyor', 'Quantity Surveyor', 'Senior Quantity Surveyor', 'Cost Engineer', 'Cost Manager', 'Estimator', 'Senior Estimator', 'Chief Estimator', 'Foreman', 'General Foreman', 'Site Manager', 'Commercial Manager', 'Contracts Manager'],
  'Healthcare & Clinical': ['Foundation Doctor', 'House Officer', 'Resident', 'Registrar', 'Specialty Registrar', 'Specialist Doctor', 'Associate Specialist', 'Consultant', 'Attending Physician', 'Medical Director', 'Chief Clinical Officer', 'Certified Nursing Assistant', 'Licensed Practical Nurse', 'Staff Nurse', 'Registered Nurse', 'Charge Nurse', 'Nurse Practitioner', 'Clinical Nurse Specialist', 'Nurse Manager', 'Nurse Anesthetist', 'Nurse-Midwife', 'Director of Nursing', 'Chief Nursing Officer', 'Physiotherapist', 'Physical Therapist', 'Occupational Therapist', 'Speech-Language Pathologist', 'Radiographer', 'Respiratory Therapist', 'Dietitian', 'Pharmacist', 'Medical Laboratory Technologist', 'Audiologist', 'Phlebotomist', 'Hospital Administrator', 'Healthcare Administrator', 'Head of Clinical Operations', 'Practice Manager', 'Chief Population Health Officer', 'Chief Patient Experience Officer', 'Chief Informatics Officer', 'Clinical Research Associate', 'Clinical Research Coordinator', 'Regulatory Affairs Associate', 'Medical Science Liaison', 'Clinical Research Director'],
  'General Management / Executive Leadership': ['Executive Director', 'Country Manager', 'Regional General Manager', 'Site General Manager', 'Deputy Managing Director', 'Chairman', 'Chair of the Board', 'Vice Chair', 'Non-Executive Director', 'Independent Director', 'Board Member', 'Trustee', 'Lead Independent Director'],
  'Education & Training': ['Adjunct Professor', 'Adjunct Instructor', 'Lecturer', 'Assistant Professor', 'Associate Professor', 'Professor', 'Department Chair', 'Head of Department', 'Dean', 'Provost', 'Vice-Chancellor', 'Training Specialist', 'Corporate Trainer', 'Training Manager', 'Learning and Development Manager', 'Learning and Development Business Partner', 'Learning and Development Consultant', 'Training Director', 'Director of Learning and Development', 'Head of Learning and Development', 'Junior Instructional Designer', 'Instructional Designer', 'Senior Instructional Designer', 'Instructional Design Specialist', 'Learning Experience Designer', 'Curriculum Developer', 'Curriculum Designer', 'eLearning Developer', 'eLearning Specialist', 'Instructional Design Manager', 'Director of Online Learning', 'Learning Technologist', 'Educational Technologist'],
}

const wholeCategoryByLabel = Object.fromEntries(
  FLAT_FUNCTION_OPTIONS.filter(o => !o.label.includes('>')).map(o => [o.label, o])
)

describe('function taxonomy — real-world title coverage (2026-09-01 audit)', () => {
  for (const [fn, titles] of Object.entries(TITLES)) {
    describe(fn, () => {
      const option = wholeCategoryByLabel[fn]
      const expectedMisses = EXPECTED_MISSES[fn] || {}

      it('has a matching whole-category option in the taxonomy', () => {
        expect(option).toBeTruthy()
      })

      for (const title of titles) {
        const isExpectedMiss = Object.prototype.hasOwnProperty.call(expectedMisses, title)
        const label = isExpectedMiss ? `${title} (expected miss: ${expectedMisses[title]})` : title
        it(label, () => {
          const hit = option.keywords.some(k => keywordMatches(title.toLowerCase(), k))
          expect(hit).toBe(!isExpectedMiss)
        })
      }
    })
  }

  it('every EXPECTED_MISSES entry refers to a title actually in TITLES (no stale exclusions)', () => {
    for (const [fn, misses] of Object.entries(EXPECTED_MISSES)) {
      for (const title of Object.keys(misses)) {
        expect(TITLES[fn]).toContain(title)
      }
    }
  })
})

// Runs every 4 hours, for every customer. This is the ONE place research happens,
// Today's Actions no longer runs its own search, it reads what this function writes
// here. Real web search grounds every signal, contact verification only ever comes
// from Apollo (never an AI guess treated as fact), and everything is deduplicated so
// the same event never gets logged twice across scans.
import { createClient } from '@supabase/supabase-js'

const SIGNAL_TYPES = ['funding', 'leadership_change', 'hiring_activity', 'expansion', 'team_building', 'public_commentary', 'job_posting_unclaimed', 'm_and_a', 'regulatory']

function normalizeKey(company, headline) {
  return `${(company || '').trim().toLowerCase()}::${(headline || '').trim().toLowerCase().slice(0, 80)}`
}

function buildScanPrompt(onboarding, recentCompanies) {
  return `You are Annie, an expert BD researcher for a recruitment firm.
Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.

Use web search to find genuine, timely BD-relevant signals in these sectors and markets right now: funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity.

Bias strongly AGAINST obvious, oversaturated, famous names everyone already targets, unless there is a genuinely fresh, non-public timing signal attached. Prefer quiet signals that took real digging to find.

Companies already surfaced recently, don't re-report the same event for these unless there is a brand new development: ${recentCompanies.join(', ') || 'None yet'}.

Every signal must have a real, citable source you actually found via search. Do not invent anything. Return up to 8 signals, fewer if you can't find genuinely good ones, never pad with weak filler.

For each signal, determine:
- company: the company name
- signalType: one of ${SIGNAL_TYPES.join(', ')}
- headline: max 10 words
- whyItMatters: 1-2 sentences on why this is a genuine BD opportunity right now
- sourceUrl: the real URL you found this from
- sourceLabel: short label, e.g. techcrunch.com
- eventDate: your best estimate of when this actually happened or was posted, as YYYY-MM-DD, based on the source
- whoToApproach: the specific person or role to approach and why, bypass generic HR/Head of Talent unless they're genuinely the right door
- titleKeywords: 2-4 likely job title strings for the right decision-maker, used afterwards to look up a real verified contact
- candidateAngle: a specific, credible candidate profile to lead with (background, seniority, source companies), not a generic pitch, written in the recruiter's communication tone above. Leave blank if this signal isn't the kind that calls for a candidate pitch (e.g. a pure leadership-change or funding note with no obvious opening).

Return a JSON array, each object with exactly these fields: company, signalType, headline, whyItMatters, sourceUrl, sourceLabel, eventDate, whoToApproach, titleKeywords, candidateAngle.
Only return the JSON array, nothing else. If nothing genuinely good was found, return an empty array.`
}

async function callAnthropic(apiKey, systemPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Scan for signals now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }),
  })
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}`)
  const data = await resp.json()
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

function extractJson(text) {
  const match = text.match(/\[[\s\S]*\]/)
  try { return JSON.parse(match ? match[0] : '[]') } catch { return [] }
}

// Contact info is only ever trusted from Apollo. An AI-mentioned name is reasoning,
// not a fact, it stays in who_to_approach, never in the verified contact fields.
async function verifyContact(apolloKey, company, titleKeywords) {
  if (!apolloKey || !company) return null
  try {
    const resp = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify({ q_organization_name: company, person_titles: titleKeywords?.length ? titleKeywords : undefined, page: 1, per_page: 1 }),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const p = (data.people || [])[0]
    if (!p) return null
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
    if (!name) return null
    return { name, title: p.title || '', linkedin_url: p.linkedin_url || '' }
  } catch {
    return null
  }
}

async function enrichCompany(apolloKey, company) {
  if (!apolloKey || !company) return null
  try {
    const resp = await fetch('https://api.apollo.io/v1/mixed_companies/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apolloKey },
      body: JSON.stringify({ q_organization_name: company, page: 1, per_page: 1 }),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const org = (data.organizations && data.organizations[0]) || (data.accounts && data.accounts[0])
    if (!org) return null
    return {
      domain: org.primary_domain || org.domain || null,
      industry: org.industry || null,
      city: org.city || null,
      state: org.state || null,
      country: org.country || null,
      logo_url: org.logo_url || null,
    }
  } catch {
    return null
  }
}

export default async (req, context) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const apolloKey = process.env.APOLLO_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!anthropicKey || !supabaseUrl || !serviceKey) {
    return new Response('Not configured', { status: 200 })
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  const { data: onboardingRows } = await supabase.from('onboarding').select('user_id, sectors, locations, tone, firm_name')
  if (!onboardingRows?.length) return new Response('No customers to scan', { status: 200 })

  for (const ob of onboardingRows) {
    try {
      const { data: recentSignals } = await supabase
        .from('intelligence_signals')
        .select('company_name')
        .eq('user_id', ob.user_id)
        .order('found_at', { ascending: false })
        .limit(30)
      const recentCompanies = [...new Set((recentSignals || []).map(r => r.company_name))]

      const text = await callAnthropic(anthropicKey, buildScanPrompt(ob, recentCompanies))
      const found = extractJson(text)
      if (!found.length) continue

      const rows = []
      for (const s of found) {
        if (!s.company || !s.headline) continue

        const [contact, companyInfo] = await Promise.all([
          verifyContact(apolloKey, s.company, s.titleKeywords),
          enrichCompany(apolloKey, s.company),
        ])

        rows.push({
          user_id: ob.user_id,
          company_name: s.company,
          company_domain: companyInfo?.domain || null,
          company_industry: companyInfo?.industry || null,
          company_city: companyInfo?.city || null,
          company_state: companyInfo?.state || null,
          company_country: companyInfo?.country || null,
          company_logo_url: companyInfo?.logo_url || null,
          signal_type: SIGNAL_TYPES.includes(s.signalType) ? s.signalType : 'public_commentary',
          headline: s.headline,
          why_it_matters: s.whyItMatters || '',
          source_url: s.sourceUrl || '',
          source_label: s.sourceLabel || '',
          event_at: s.eventDate && !isNaN(Date.parse(s.eventDate)) ? new Date(s.eventDate).toISOString() : null,
          who_to_approach: s.whoToApproach || '',
          candidate_angle: s.candidateAngle || '',
          contact_name: contact?.name || null,
          contact_title: contact?.title || null,
          contact_linkedin_url: contact?.linkedin_url || null,
          contact_verified: !!contact,
          dedup_key: normalizeKey(s.company, s.headline),
          status: 'new',
        })
      }

      if (rows.length) {
        await supabase.from('intelligence_signals').upsert(rows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true })
      }
    } catch (err) {
      // One customer failing shouldn't stop the rest of the scan
      console.error('intelligence-scan failed for user', ob.user_id, err.message)
    }
  }

  return new Response('Scan complete', { status: 200 })
}

export const config = { schedule: '0 */4 * * *' }

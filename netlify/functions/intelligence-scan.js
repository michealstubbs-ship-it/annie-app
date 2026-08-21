// Runs twice a day (every 12 hours), for every customer. This is the ONE
// place recurring research happens for existing customers, Today's Actions
// no longer runs its own search, it reads what this function writes here.
// Real web search grounds every signal, contact verification only ever comes
// from Apollo (never an AI guess treated as fact), and everything is
// deduplicated BEFORE any Apollo credit is spent on it, not just at the DB
// write, so a signal re-surfaced on a later run never costs credits twice.
//
// Was every 4 hours; dropped to every 12 to cut Apollo/Anthropic spend
// roughly 3x. Existing customers already have a populated dashboard, a
// signal sitting a few extra hours before showing up doesn't cost them
// anything the way an empty first scan would for a brand new signup (see
// scan-now-background.js, which is deliberately the more expensive one).
import { createClient } from '@supabase/supabase-js'

const SIGNAL_TYPES = ['funding', 'leadership_change', 'hiring_activity', 'expansion', 'team_building', 'public_commentary', 'job_posting_unclaimed', 'm_and_a', 'regulatory']

// Hard ceiling on how many NEW (never-seen-before) signals get enriched via
// Apollo per customer per run. The prompt also asks for "up to" this many,
// but this is the real, code-enforced cap, since Apollo credits are a
// limited monthly budget and this cron runs across every customer.
const MAX_SIGNALS_PER_RUN = 5

function normalizeKey(company, headline) {
  return `${(company || '').trim().toLowerCase()}::${(headline || '').trim().toLowerCase().slice(0, 80)}`
}

function buildScanPrompt(onboarding, recentCompanies) {
  const functions = onboarding?.functions?.length ? onboarding.functions.join(', ') : null
  return `You are Annie, an expert BD researcher for a recruitment firm.
Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Functions this recruiter places candidates into: ${functions || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `The recruiter's real writing style, follow this closely when writing the candidateAngle text:\n${onboarding.writing_style}\n` : ''}
Use web search to find genuine, timely BD-relevant signals in these sectors and markets right now: funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity.
Also actively look for layoffs, redundancies, or restructuring news. This cuts both ways and both are worth surfacing: a company doing layoffs sometimes still needs to quietly backfill specific roles (frame the signal around that need), and separately, a real layoff or redundancy event puts a pool of genuinely available, often strong candidates on the market at once, worth surfacing on its own even with no obvious open role at that company, in which case candidateAngle should describe that available talent pool specifically. Classify these as signalType "regulatory" and make the headline clearly say layoffs or redundancy so it's not confused with an ordinary hiring signal.
Search thoroughly before concluding there is nothing. Run multiple distinct searches, try each sector and each function by name, try combinations of sector + "funding" / "hiring" / "appoints" / "expansion" / "acquires", try the specified markets by name, and try recent news generally in these sectors before narrowing. Do not stop after one or two searches, a real, live-news industry genuinely has more happening in it than that.
${functions ? `This recruiter places into the functions listed above. When you find a strong, genuine signal, connect it to whichever of those functions it most plausibly affects, even if the reasoning takes a small logical step (e.g. a funding round signals Finance/Strategy hiring, a safety incident signals HSE hiring, a new market launch signals Government/Regulatory Affairs hiring, an M&A deal signals Corporate Development or Legal hiring). Make your best reasonable case for the closest function rather than discarding a real, well-sourced signal purely because the function match isn't perfect. Only leave a strong signal out entirely if you genuinely cannot connect it to any of the functions listed, even loosely.` : ''}

Bias against obvious, oversaturated, famous names everyone already targets when a quieter, equally strong alternative exists, but do not discard a genuinely strong, well-sourced signal just because the company is well known, a real opportunity is better than an artificially obscure one.

Companies already surfaced recently, don't re-report the same event for these unless there is a brand new development: ${recentCompanies.join(', ') || 'None yet'}.

Every signal must have a real, citable source you actually found via search. Do not invent anything. Return up to 5 signals, fewer if you can't find genuinely good ones after searching thoroughly, never pad with weak filler.

For each signal, determine:
- company: the company name
- signalType: one of ${SIGNAL_TYPES.join(', ')}
- headline: max 10 words
- whyItMatters: 1-2 sentences on why this is a genuine BD opportunity right now
- sourceUrl: the real URL you found this from
- sourceLabel: short label, e.g. techcrunch.com
- eventDate: your best estimate of when this actually happened or was posted, as YYYY-MM-DD, based on the source
- whoToApproach: the specific person or role to approach and why, bypass generic HR/Head of Talent unless they're genuinely the right door, and keep them within this recruiter's target functions above
- titleKeywords: 2-4 likely job title strings for the right decision-maker, used afterwards to look up a real verified contact
- candidateAngle: a specific, credible candidate profile to lead with (background, seniority, source companies), matching the target functions above, not a generic pitch, written in the recruiter's communication tone above. Leave blank if this signal isn't the kind that calls for a candidate pitch (e.g. a pure leadership-change or funding note with no obvious opening).

Return a JSON array, each object with exactly these fields: company, signalType, headline, whyItMatters, sourceUrl, sourceLabel, eventDate, whoToApproach, titleKeywords, candidateAngle.
Only return the JSON array, nothing else. If nothing genuinely good was found, return an empty array.`
}

async function callAnthropic(apiKey, systemPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Scan for signals now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
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

// How far back a Companies House filing can be and still count as
// confirming a leadership_change signal. Filings often lag the real event
// by a few weeks, so this is wider than the AI's own search window.
const LEADERSHIP_VERIFY_WINDOW_DAYS = 45

// Companies House is the UK's own public register, a director appointment
// or resignation here is a verified FACT, not a news article's best guess.
// Only called for leadership_change signals, and only ever upgrades a
// signal's credibility, never blocks one.
async function verifyLeadershipChange(chApiKey, companyName) {
  if (!chApiKey || !companyName) return null
  try {
    const authHeader = 'Basic ' + Buffer.from(`${chApiKey}:`).toString('base64')

    const searchResp = await fetch(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=5`, {
      headers: { Authorization: authHeader },
    })
    if (!searchResp.ok) return null
    const searchData = await searchResp.json()
    const items = searchData.items || []
    const best = items.find(c => c.company_status === 'active') || items[0]
    if (!best?.company_number) return null

    const officersResp = await fetch(`https://api.company-information.service.gov.uk/company/${best.company_number}/officers?items_per_page=50`, {
      headers: { Authorization: authHeader },
    })
    if (!officersResp.ok) return null
    const officersData = await officersResp.json()

    const cutoff = Date.now() - LEADERSHIP_VERIFY_WINDOW_DAYS * 24 * 60 * 60 * 1000
    let mostRecent = null
    let mostRecentTime = 0
    for (const o of officersData.items || []) {
      const dateStr = o.resigned_on || o.appointed_on
      if (!dateStr) continue
      const t = new Date(dateStr).getTime()
      if (isNaN(t) || t < cutoff) continue
      if (t > mostRecentTime) { mostRecent = o; mostRecentTime = t }
    }
    if (!mostRecent) return null

    const changeType = mostRecent.resigned_on ? 'resigned as' : 'appointed as'
    const changeDate = mostRecent.resigned_on || mostRecent.appointed_on
    return {
      detail: `Companies House confirms: ${mostRecent.name} ${changeType} ${mostRecent.officer_role || 'officer'} on ${changeDate}.`,
    }
  } catch (err) {
    console.error('[intelligence-scan] Companies House verification failed:', err.message)
    return null
  }
}

export default async (req, context) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const apolloKey = process.env.APOLLO_API_KEY
  const companiesHouseKey = process.env.COMPANIES_HOUSE_API_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!anthropicKey || !supabaseUrl || !serviceKey) {
    return new Response('Not configured', { status: 200 })
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  const { data: onboardingRows } = await supabase.from('onboarding').select('user_id, sectors, functions, locations, tone, firm_name, writing_style')
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
      if (!found.length) {
        // Same reasoning as scan-now-background.js: log a preview so a
        // zero-result customer is diagnosable from the log, not guessed at.
        const preview = (text || '').trim().slice(0, 400)
        console.log('[intelligence-scan] nothing found for', ob.user_id, '| raw response preview:', preview || '(empty response)')
        continue
      }

      // Dedupe against this customer's full signal history BEFORE spending
      // any Apollo credit, not after. Previously this ran enrichment on
      // every signal the AI returned, including ones that turned out to be
      // duplicates only discarded later at the DB write, quietly burning 2
      // Apollo credits per re-surfaced story on every run it came up again.
      const { data: existingRows } = await supabase
        .from('intelligence_signals')
        .select('dedup_key')
        .eq('user_id', ob.user_id)
      const existingKeys = new Set((existingRows || []).map(r => r.dedup_key))

      const newSignals = found
        .filter(s => s.company && s.headline && !existingKeys.has(normalizeKey(s.company, s.headline)))
        .slice(0, MAX_SIGNALS_PER_RUN)

      if (!newSignals.length) {
        console.log('[intelligence-scan] only duplicates found for', ob.user_id, ', skipping enrichment')
        continue
      }

      const rows = []
      for (const s of newSignals) {
        const [contact, companyInfo, chVerification] = await Promise.all([
          verifyContact(apolloKey, s.company, s.titleKeywords),
          enrichCompany(apolloKey, s.company),
          s.signalType === 'leadership_change' ? verifyLeadershipChange(companiesHouseKey, s.company) : Promise.resolve(null),
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
          title_keywords: Array.isArray(s.titleKeywords) ? s.titleKeywords.slice(0, 6) : [],
          ch_verified: !!chVerification,
          ch_verified_detail: chVerification?.detail || null,
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

export const config = { schedule: '0 */12 * * *' }

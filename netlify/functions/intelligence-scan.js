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
//
// Shares pure logic (dedup keys, JSON extraction, Apollo/Adzuna/Companies
// House calls) with scan-now-background.js via lib/scanShared.js — see that
// file's header for why. This file keeps only what's genuinely different:
// a single AI call per customer instead of parallel sector groups, a hard
// per-run signal cap, and the cheaper model.
import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { reserveAnthropicTokens } from './lib/aiUsage.js'
import {
  SIGNAL_TYPES, SIGNAL_LOOKBACK_DAYS, normalizeKey, extractJson,
  discoverAdzunaJobs, fetchWithRetry, alertIfConfigured,
  dropGenericHiringWhereLiveJobsExist, buildEnrichedSignalRows, createTimeoutFetch,
} from './lib/scanShared.js'

// Hard ceiling on how many NEW (never-seen-before) signals get enriched via
// Apollo per customer per run. The prompt also asks for "up to" this many,
// but this is the real, code-enforced cap, since Apollo credits are a
// limited monthly budget and this cron runs across every customer.
const MAX_SIGNALS_PER_RUN = 5

// The exact shape a real customer confirmed works (2026-08-23 product-copy
// pass): a warm opener, one paragraph that introduces the firm and the
// specific niche this signal calls for (never the recruiter's whole sector
// list), explains the insight in plain language rather than restating
// stats, names relevant regional experience, and positions the recruiter as
// a value-adding partner through their candidate network — then a short
// closing paragraph that just asks for a call. Shared by both the signal
// and live_job field lists below so the two never drift apart. Kept as an
// exact copy of scan-now-background.js's version rather than importing it —
// see this file's own header for why the two scan files deliberately don't
// share orchestration/prompt code.
function introMessageInstruction(onboarding) {
  const firmClause = onboarding?.firm_name
    ? ` by name (their firm is called "${onboarding.firm_name}")`
    : ` — no firm name is on file for this recruiter, so introduce it generically (e.g. "a recruitment firm") rather than inventing a name`
  return `the BODY of a ready-to-send outreach message, written as a short letter in 3 short paragraphs separated by a blank line (a real blank line between paragraphs, not one dense block) — no greeting ("Hi", "Hello") and no sign-off ("Best,", a name) at the very start or end, the app adds a real greeting and a signed sign-off around this automatically using the actual contact's name and this recruiter's own name and firm, so never guess at or invent either of those here. Structure it exactly like this:
  1) A brief, natural warm opening line, e.g. "I hope you are doing well." — nothing about the signal yet.
  2) One paragraph that introduces the recruiter's firm${firmClause}, states specifically what this recruiter specialises in recruiting for — tailored precisely to what THIS signal is actually about (e.g. "project finance, EPC oversight and regulatory mandates" for an infrastructure deal, never a generic list of every sector this recruiter covers), explains in plain natural language what the real insight behind this signal is and why it likely means the company is now hiring to deliver against it (never a recap of stats or numbers), names the recruiter's relevant regional or market experience, and closes by saying the recruiter is confident they can add value as a recruitment partner here through their relevant candidate network in this specific space.
  3) A short closing paragraph that simply asks for a call to discuss further.
  Written in the recruiter's communication tone above, natural prose a person would actually type, no em dashes or en dashes used as sentence connectors, no template brackets, finished sendable text only.
  Special case, leadership_change only: if this entry's signalType is "leadership_change", the opening line instead becomes something like "I hope you are doing well, and congratulations on the new role." (your own natural phrasing of that sentiment, not copied verbatim), and paragraph 2 additionally includes, after the insight, a sentence in your own words to the effect of "I am sure with your new role, you will be looking to add to your team, or perhaps make some key changes" before the regional-experience and value-add close. Every other signal type keeps the plain opening line and paragraph 2 without this addition.`
}

function buildScanPrompt(onboarding, recentCompanies, opts = {}) {
  const functions = onboarding?.functions?.length ? onboarding.functions.join(', ') : null
  const introMessageField = introMessageInstruction(onboarding)
  return `You are Annie, an expert BD researcher for a recruitment firm.
Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Functions this recruiter places candidates into: ${functions || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `The recruiter's real writing style, follow this closely when writing the introMessage, candidateAngle, and benchStrengthAngle text:\n${onboarding.writing_style}\n` : ''}
Use web search to find genuine, timely BD-relevant signals in these sectors and markets right now: funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity.
Also actively look for layoffs, redundancies, or restructuring news. This cuts both ways and both are worth surfacing: a company doing layoffs sometimes still needs to quietly backfill specific roles (frame the signal around that need), and separately, a real layoff or redundancy event puts a pool of genuinely available, often strong candidates on the market at once, worth surfacing on its own even with no obvious open role at that company, in which case candidateAngle should describe that available talent pool. Classify these as signalType "regulatory" and make the headline clearly say layoffs or redundancy so it's not confused with an ordinary hiring signal.
Search thoroughly before concluding there is nothing. Run multiple distinct searches, try each sector and each function by name, try combinations of sector + "funding" / "hiring" / "appoints" / "expansion" / "acquires", try the specified markets by name, and try recent news generally in these sectors before narrowing. Do not stop after one or two searches, a real, live-news industry genuinely has more happening in it than that.
${functions ? `This recruiter places into the functions listed above. When you find a strong, genuine signal, connect it to whichever of those functions it most plausibly affects, even if the reasoning takes a small logical step (e.g. a funding round signals Finance/Strategy hiring, a safety incident signals HSE hiring, a new market launch signals Government/Regulatory Affairs hiring, an M&A deal signals Corporate Development or Legal hiring). Make your best reasonable case for the closest function rather than discarding a real, well-sourced signal purely because the function match isn't perfect. Only leave a strong signal out entirely if you genuinely cannot connect it to any of the functions listed, even loosely.` : ''}

Bias against obvious, oversaturated, famous names everyone already targets when a quieter, equally strong alternative exists, but do not discard a genuinely strong, well-sourced signal just because the company is well known, a real opportunity is better than an artificially obscure one.

${opts.adzunaLeads?.length ? `\nAdzuna's live jobs board shows these real, recent job postings that may match this recruiter's sectors and functions: ${opts.adzunaLeads.map(l => `"${l.title}" at ${l.company}${l.location ? ` (${l.location})` : ''}${l.salary ? `, salary ~${l.salary}` : ''} — ${l.url}`).join(' | ')}. For any of these that reads as posted directly by the company itself (no recruitment agency name, no "on behalf of our client" language, no agency branding) rather than through a recruiter or agency, this is a genuine open role with no recruiter attached — do NOT write this up as a generic "signal" entry. Instead, write it as its own "live_job" entry (see the separate live_job field list below), one per specific role, with the real posting URL as sourceUrl. Skip any that clearly look agency-posted. If a company has one or more of these live_job entries, do not also write a separate hiring_activity or job_posting_unclaimed signal entry about that same company being on a hiring push in general — the specific role entries replace that, they don't sit alongside it.\n` : ''}

Adzuna does not cover every one of this recruiter's markets (notably the GCC/UAE) — for those, also use web search directly to find genuine, specific open roles: search a company's own careers page, recognised regional job boards (Bayt, GulfTalent, NaukriGulf, Dubizzle Jobs), and LinkedIn Jobs postings. Write anything you find this way as its own "live_job" entry the same way as an Adzuna-sourced one — real specific title, sourceUrl pointing at the actual job posting page itself (not a news article merely mentioning that the company is hiring), no agency-posted roles. If you can only find a general "this company is hiring" mention with no specific posting page to cite, write that as an ordinary hiring_activity signal instead, never as a live_job entry — a live_job entry always needs its own real posting URL.

Companies already surfaced recently, don't re-report the same event for these unless there is a brand new development: ${recentCompanies.join(', ') || 'None yet'}.

Every signal must have a real, citable source you actually found via search. Do not invent anything. Return up to 5 entries total (signal and live_job entries combined), fewer if you can't find genuinely good ones after searching thoroughly, never pad with weak filler.

For each signal, determine:
- entryType: "signal"
- company: the company name
- signalType: one of ${SIGNAL_TYPES.join(', ')}
- headline: max 10 words
- whyItMatters: 1-2 sentences, in plain, natural prose, explaining what this news actually means for THIS recruiter's business right now — not a recap of the news and not a list of numbers or stats restated from the source. Say what door it opens (a role likely opening up, a team likely expanding, budget likely freed, a talent pool now available) so the recruiter immediately understands why it's worth their time. Never include citation markup, footnote markers, or any bracketed source references — plain prose only.
- sourceUrl: the real URL you found this from
- sourceLabel: short label, e.g. techcrunch.com
- eventDate: your best estimate of when this actually happened or was posted, as YYYY-MM-DD, based on the source
- whoToApproach: the specific person or role to approach and why, bypass generic HR/Head of Talent unless they're genuinely the right door, and keep them within this recruiter's target functions above
- appointedName: ONLY for signalType "leadership_change" — the full name of the person who was actually appointed/promoted into the new role, exactly as reported by your source (e.g. "Sarah Al Mazrouei"), so the recruiter can be pointed at reaching out to that exact person rather than a generic title. Leave this blank for every other signalType, and leave it blank even for a leadership_change if no source actually names the person.
- titleKeywords: 2-4 likely job title strings for the right decision-maker, used afterwards to look up a real verified contact
- introMessage: ${introMessageField}
- candidateAngle: a specific, credible candidate pitch to lead with — background, seniority, source companies — matching the target functions above. Phrase it as an opening gambit, not an unconditional promise (e.g. "I'm working with a [seniority] who..." rather than "I have the perfect candidate"), so the recruiter still has room to say that exact person has just gone off-market if the hiring manager responds and it doesn't pan out — the point of this angle is opening the conversation, not guaranteeing one specific person. Leave blank if this signal isn't the kind that calls for a candidate pitch (e.g. a pure leadership-change or funding note with no obvious opening).
- benchStrengthAngle: a positioning pitch that does NOT name a single candidate — instead, say the recruiter works with several people who have direct, relevant experience in this exact niche, naming 1-2 real, specific companies that are genuine competitors or close peers to ${'`company`'} in this space (never vague phrasing like "similar companies"), so it reads as informed market knowledge rather than a generic claim. Leave blank if you cannot confidently name genuine, relevant peer companies.
- candidateProfile: a structured, consistent breakdown of the kind of candidate this recruiter would actually go and find for this opportunity, used to render the same "what to look for" box on every signal card regardless of type — an object with exactly these keys: { "yearsMin": <number, low end of a realistic years-of-experience range for this role/seniority>, "yearsMax": <number, high end>, "functionalExperience": "<one short phrase naming the specific functional experience needed, e.g. 'Project finance and EPC contract management', tailored to this exact signal, never generic>", "directCompetitors": [<0-3 real, specific company names that are direct competitors of ${'`company`'} — companies a hiring manager would obviously poach from first>], "similarIndustry": [<0-3 real, specific company names in the same broader industry but not a head-to-head competitor — a wider but still logical pool>], "widerScope": [<0-2 real, specific company names from an adjacent field a sharp hiring manager might also consider, e.g. a relevant consulting firm whose people have done directly applicable work — only include this if it's a genuine, defensible logical stretch, never a random unrelated company>] }. Only name real companies you're confident actually exist and are genuinely relevant, leave an array empty rather than inventing a plausible-sounding name. Leave the whole object with empty arrays and blank functionalExperience if you cannot confidently populate it.
- likelyRoles: ONLY for signalType "funding" or "expansion" — 2-4 specific job titles this company will likely now be hiring for as a direct result of this signal, spanning different functions where genuinely applicable (e.g. for a funding round: "Head of Product", "VP Engineering", "Commercial Director", not three variants of the same role) — these two signal types rarely have one single obvious hiring contact, so this is what lets the recruiter be pointed at several relevant people across functions instead of nobody. Leave blank for every other signalType.

For each genuine, directly-posted open role you found via the Adzuna list above or your own web search for this recruiter's markets, write a SEPARATE entry with these fields instead (do not mix these into a signal entry):
- entryType: "live_job"
- company: the company name, exactly as Adzuna gave it
- headline: the exact, specific role title (e.g. "Senior Finance Manager", not "Hiring across Finance") — this is what makes it a live job entry rather than a company-level narrative
- whyItMatters: 1 sentence, plain natural prose, on why this specific open role is a genuine BD opportunity right now (e.g. posted directly with no recruiter attached, matches this recruiter's placement functions). No citation markup or bracketed references.
- sourceUrl: the real posting URL — the Adzuna posting URL from the list above, or, for a role you found via your own web search, the actual job posting page itself (a company careers page, a job board listing, or a LinkedIn Jobs post) — never a news article that merely mentions the company is hiring
- sourceLabel: short label, e.g. adzuna.com, bayt.com, or the company's own domain
- eventDate: the posting date if you can tell, else your best estimate, as YYYY-MM-DD
- whoToApproach: the specific person or role to approach about this exact opening
- titleKeywords: 2-4 likely job title strings for the right decision-maker, used afterwards to look up a real verified contact
- introMessage: same structure and rules as the signal field above (${introMessageField}), tailored to this exact open role instead of a general company-level signal
- candidateAngle: same as above, tailored to this exact role. Leave blank if it doesn't call for one.
- benchStrengthAngle: same as above, tailored to this exact role's niche. Leave blank if you cannot confidently name genuine peer companies.
- candidateProfile: same structure and rules as the signal field above, tailored to this exact open role's seniority and requirements.

Return a single JSON array mixing both kinds of entries, each tagged with its entryType. Only return the JSON array, nothing else. If nothing genuinely good was found, return an empty array.`
}

const DEFAULT_ANTHROPIC_DAILY_TOKEN_CAP = 2_000_000

async function callAnthropic(apiKey, systemPrompt, supabase) {
  // Anthropic spend had no cap anywhere in this codebase — mirrors the
  // existing Apollo daily-credit-cap pattern (reserveApolloCredits in
  // scanShared.js). Checked before the network call fires, same as Apollo's.
  const dailyTokenCap = parseInt(process.env.ANTHROPIC_DAILY_TOKEN_CAP, 10) || DEFAULT_ANTHROPIC_DAILY_TOKEN_CAP
  if (!(await reserveAnthropicTokens(supabase, 4096, dailyTokenCap))) {
    throw new Error('Anthropic daily token cap reached — skipping this call')
  }
  // retries=1, not the fetchWithRetry default of 2: this call already has a
  // 90s timeout for multi-round web search, so a full 2-retry budget could
  // cost up to ~4.5 minutes on one customer in a sequential per-customer
  // loop. One retry still absorbs a transient 429/5xx without risking the
  // whole run's time budget on a single stuck customer.
  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Scan for signals now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    }),
  }, 90000, 1) // web search runs multiple search round-trips, needs far more than the 12s default
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}`)
  const data = await resp.json()
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

// A pre-launch audit flagged this as a public, unauthenticated URL that
// anyone who found it could call repeatedly to burn real Anthropic/Apollo/
// Companies House/Adzuna spend across every customer. Checked directly
// against the live deploy (21 Aug 2026): Netlify does not let scheduled
// functions (the `config = { schedule }` export below) be invoked by direct
// URL at all — both `curl .../intelligence-scan` and a POST to the same URL
// return 403 from Netlify's own edge, before this code ever runs. See
// https://docs.netlify.com/build/functions/scheduled-functions/ ("you can't
// invoke scheduled functions directly with a URL"). So this was never
// actually reachable the way the audit assumed — but that protection comes
// entirely from keeping this function schedule-only. If this file ever
// grows a `path` export (making it directly callable, the way chat.js and
// apollo-enrich-companies.js are), it MUST get its own auth check at that
// point — don't assume the schedule-only protection still applies.
//
// The method check below is just hygiene (Netlify's scheduler always POSTs)
// — it isn't what's actually keeping this safe.
// How long this run is allowed to spend working through customers before it
// stops starting new ones and returns cleanly. Netlify's background-function
// budget is 15 minutes; this stops well short of that so an in-flight
// customer's own Anthropic/Apollo calls (each with their own retry timeouts)
// have room to finish rather than getting hard-killed mid-write. Whatever
// wasn't reached this run gets covered by the NEXT scheduled run 12 hours
// later — not ideal at high customer counts (see the comment on `config`
// below), but far better than the previous behaviour of this being a
// schedule-only function with NO background budget at all, silently capped
// at Netlify's 30-second scheduled-function limit — meaning in practice only
// the first customer or so per run (however far a single Anthropic call plus
// enrichment got in 30 seconds) was ever actually being scanned, with every
// customer after that never reached, run after run, and nothing surfacing
// that this was happening.
const RUN_BUDGET_MS = 12 * 60 * 1000

// 2026-08-24 Task 2 (refactor, no behavior change): the per-customer scan
// body used to live inline in the default handler's for-loop — one ~85-line
// block doing budget bookkeeping, dedup lookups, the AI call, enrichment,
// and the write, all at once. Pulled out into named steps below so each
// piece reads on its own; the calling loop is now just
// "for each customer, call scanOneCustomer, catch, continue". No change to
// what any of these steps actually does.

// Recent company names for this customer, used both to tell the AI what NOT
// to re-report and, separately from dedup_key matching, to keep the prompt
// itself aware of recent history.
async function fetchRecentCompanies(supabase, userId) {
  const { data: recentSignals } = await supabase
    .from('intelligence_signals')
    .select('company_name')
    .eq('user_id', userId)
    .order('found_at', { ascending: false })
    .limit(30)
  return [...new Set((recentSignals || []).map(r => r.company_name))]
}

// Every dedup_key this customer already has on file, so newly-found signals
// can be filtered down to genuinely new ones before any Apollo credit gets
// spent enriching them.
async function fetchExistingDedupKeys(supabase, userId) {
  const { data: existingRows } = await supabase
    .from('intelligence_signals')
    .select('dedup_key')
    .eq('user_id', userId)
  return new Set((existingRows || []).map(r => r.dedup_key))
}

// Runs the full scan for one customer: recent-history lookups, the AI call,
// dedup filtering, enrichment, and the write. Returns the number of new
// signal rows written. Throws on any failure — the caller's per-customer
// try/catch is what reports and moves on, same as before this was pulled
// out into its own function.
async function scanOneCustomer(ob, ctx) {
  const { anthropicKey, apolloKey, companiesHouseKey, adzunaAppId, adzunaAppKey, supabase } = ctx

  const recentCompanies = await fetchRecentCompanies(supabase, ob.user_id)
  const adzunaLeads = await discoverAdzunaJobs(adzunaAppId, adzunaAppKey, { sectors: ob.sectors, functions: ob.functions, locations: ob.locations })

  const text = await callAnthropic(anthropicKey, buildScanPrompt(ob, recentCompanies, { adzunaLeads }), supabase)
  // Enforce "replace, not supplement" here in code — see the function's own
  // comment in scanShared.js for why this can't just be a prompt instruction
  // alone.
  const found = dropGenericHiringWhereLiveJobsExist(extractJson(text))
  if (!found.length) {
    // Log a preview so a zero-result customer is diagnosable from the log,
    // not guessed at.
    const preview = (text || '').trim().slice(0, 400)
    console.log('[intelligence-scan] nothing found for', ob.user_id, '| raw response preview:', preview || '(empty response)')
    return 0
  }

  // Dedupe against this customer's full signal history BEFORE spending any
  // Apollo credit, not after — see fetchExistingDedupKeys's own comment.
  const existingKeys = await fetchExistingDedupKeys(supabase, ob.user_id)
  const newSignals = found
    .filter(s => s.company && s.headline && !existingKeys.has(normalizeKey(s.company, s.headline, s.sourceUrl)))
    .slice(0, MAX_SIGNALS_PER_RUN)

  if (!newSignals.length) {
    console.log('[intelligence-scan] only duplicates found for', ob.user_id, ', skipping enrichment')
    return 0
  }

  // Row-building itself lives once in scanShared.js, shared with
  // scan-now-background.js — see buildEnrichedSignalRows's own comment.
  const rows = await buildEnrichedSignalRows(newSignals, { userId: ob.user_id, apolloKey, companiesHouseKey, supabase, logPrefix: '[intelligence-scan]' })
  if (!rows.length) return 0

  // Throwing here (rather than swallowing) is deliberate: this function's
  // caller already reports to error_logs and moves on to the next customer,
  // which is exactly the right handling for a write failure too.
  const { error } = await supabase.from('intelligence_signals').upsert(rows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true })
  if (error) throw new Error(`signal upsert failed: ${error.message}`)
  return rows.length
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const runStartedAt = Date.now()
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const apolloKey = process.env.APOLLO_API_KEY
  const companiesHouseKey = process.env.COMPANIES_HOUSE_API_KEY
  const adzunaAppId = process.env.ADZUNA_APP_ID
  const adzunaAppKey = process.env.ADZUNA_APP_KEY
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!anthropicKey || !supabaseUrl || !serviceKey) {
    return new Response('Not configured', { status: 200 })
  }

  // 2026-08-24: see createTimeoutFetch's own header in scanShared.js — a
  // single hung Supabase call anywhere in the per-customer scan loop below
  // had no timeout at all, unlike every external API call in this file.
  // Same fix applied to scan-now-background.js, which is where this was
  // actually caught stalling; applied here too so the two scan entry points
  // don't drift back out of sync on a gap this fundamental.
  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  // Ordered so that which customers get scanned first is deterministic run
  // to run, not whatever order Postgres happens to return — matters once
  // RUN_BUDGET_MS below means a given run might not reach every row.
  const { data: onboardingRows } = await supabase.from('onboarding').select('user_id, sectors, functions, locations, tone, firm_name, writing_style').order('user_id')
  if (!onboardingRows?.length) return new Response('No customers to scan', { status: 200 })

  let totalNewSignals = 0
  let processedCount = 0
  const scanCtx = { anthropicKey, apolloKey, companiesHouseKey, adzunaAppId, adzunaAppKey, supabase }

  for (const ob of onboardingRows) {
    if (Date.now() - runStartedAt > RUN_BUDGET_MS) {
      // Stop starting new customers, not mid-write on the current one —
      // the loop only checks this at the top, between customers. The
      // remaining rows get picked up by the next scheduled run; logged
      // clearly (not silently) so a shrinking per-run coverage percentage
      // as the customer base grows is visible before it becomes a support
      // ticket instead of after. See the `config`/RUN_BUDGET_MS comments —
      // once this consistently can't reach the full list, it's the signal
      // to move this to a real queue/fan-out rather than one long loop.
      const remaining = onboardingRows.length - processedCount
      console.log(`[intelligence-scan] time budget reached after ${processedCount}/${onboardingRows.length} customers — ${remaining} deferred to the next run`)
      await alertIfConfigured(`⚠️ intelligence-scan: hit its time budget after ${processedCount}/${onboardingRows.length} customers this run — ${remaining} deferred to the next scheduled run. If this keeps happening, the scan needs to move from one long loop to a real queue.`)
      break
    }
    processedCount++
    try {
      totalNewSignals += await scanOneCustomer(ob, scanCtx)
    } catch (err) {
      // One customer failing shouldn't stop the rest of the scan
      console.error('intelligence-scan failed for user', ob.user_id, err.message)
      await reportServerError('intelligence-scan', err, { userId: ob.user_id })
    }
  }

  // Every market going quiet for every customer in the same 12-hour window
  // is possible but very unlikely — far more likely is a suspended key or a
  // provider outage. Retries (see fetchWithRetry) already absorb a
  // transient blip; this is the safety net for a sustained one, so it
  // doesn't take a customer noticing "nothing new in weeks" to find out.
  if (totalNewSignals === 0 && onboardingRows.length > 0) {
    await alertIfConfigured(`⚠️ intelligence-scan: 0 new signals across all ${onboardingRows.length} customers this run. Likely a suspended API key or provider outage, not a genuinely quiet market — check the function logs.`)
  }

  return new Response('Scan complete', { status: 200 })
}

// `background: true` added alongside the existing schedule — verified
// against Netlify's own docs (docs.netlify.com/build/functions/scheduled-
// functions and .../background-functions, checked 22 Aug 2026): a scheduled
// function with no background config is capped at Netlify's flat 30-SECOND
// execution limit, full stop, regardless of the work inside it. This
// function calls Anthropic with its own 90-second timeout (see
// callAnthropic/fetchWithRetry above) and loops over every customer — it was
// being hard-killed by the platform well before even one customer's call
// could realistically complete, every single run, silently (a killed
// invocation doesn't throw into this file's own try/catch or
// reportServerError — it just stops existing). `background: true` raises
// that ceiling to Netlify's 15-minute background budget, which is what
// RUN_BUDGET_MS above is paced against.
export const config = { schedule: '0 */12 * * *', background: true }

// The actual twice-daily research loop across every customer. This is the
// ONE place recurring research happens for existing customers, Today's
// Actions no longer runs its own search, it reads what this function writes
// here. Real web search grounds every signal, contact verification only
// ever comes from Apollo (never an AI guess treated as fact), and
// everything is deduplicated BEFORE any Apollo credit is spent on it, not
// just at the DB write, so a signal re-surfaced on a later run never costs
// credits twice.
//
// 2026-08-31: split out of intelligence-scan.js, which is now just a thin
// `schedule`-only trigger that invokes this file over HTTP — see that
// file's own header for the root-cause story (a `schedule` + `background:
// true` combination on one function that was never actually a reliably-
// supported Netlify pattern, silently capping every run at the short
// scheduled-function limit before even one customer's scan could complete).
// This file is named with the `-background` suffix on purpose: that's the
// one combination Netlify staff confirm actually gets the full 15-minute
// background execution budget, and it's the exact same mechanism
// scan-now-background.js already relies on for every real "Scan Now" click
// and onboarding's first scan — proven working in this codebase already,
// not a new pattern.
//
// Because this file is invoked over plain HTTP (that's the whole point —
// intelligence-scan.js fires a POST at its URL) it is directly reachable
// the way the old combined function never was (a `schedule`-only function
// can't be hit by direct URL at all — Netlify's edge itself returns 403,
// confirmed 21 Aug 2026). That's real: anyone who found this URL could
// otherwise burn Anthropic/Apollo/Companies House/Adzuna spend across every
// customer on demand. Guarded below by the same INTERNAL_SCAN_SECRET /
// x-internal-scan-secret shared-secret header scan-now-background.js's own
// internal chaining already uses — no new secret to configure, it's already
// set in Netlify.
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
import { getEntitlements, SCAN_TIER_CONFIG, resolveResourceCaps } from './lib/entitlements.js'
import {
  SIGNAL_TYPES, SIGNAL_LOOKBACK_DAYS, normalizeKey, extractJson, looksTruncatedByTokenLimit,
  discoverAdzunaJobs, discoverTheirStackJobs, fetchWithRetry, alertIfConfigured,
  dropGenericHiringWhereLiveJobsExist, buildEnrichedSignalRows, createTimeoutFetch,
  buildRegionalSourceHint,
  buildLiveJobBoardHint,
  buildTargetFirmHint,
  buildFunctionBreadthHint,
  getLearnedSources,
  recordLearnedDiscoveries,
  splitLearnedEntries,
  fetchSignalPoolMatches,
  personalizePoolHits,
  writeToSignalPool,
  POOL_PERSONALIZE_MAX_TOKENS,
  logMarketCoverage,
  getCustomerWatchlistCompanies,
  buildCustomerWatchlistHint,
} from './lib/scanShared.js'

const INTERNAL_SCAN_SECRET = process.env.INTERNAL_SCAN_SECRET

// Hard ceiling on how many NEW (never-seen-before) signals get enriched via
// Apollo per customer per run. The prompt also asks for "up to" this many,
// but this is the real, code-enforced cap, since Apollo credits are a
// limited monthly budget and this cron runs across every customer.
const MAX_SIGNALS_PER_RUN = 5

// 2026-09-01: this file now runs two AI calls per customer (the sector-
// scoped one, plus the cross-industry-by-function one) instead of one, and
// MAX_SIGNALS_PER_RUN is a tight cap (5) — a plain concat-then-slice would
// let whichever list is longer (or happens to be checked first) silently
// take every slot, every run, starving the other call's results completely.
// Interleaves round-robin instead, deduping by the same real-fact key
// (company + headline + sourceUrl) mergeSignals in scan-now-background.js
// already uses for the same reason there.
export function interleaveSignalLists(lists) {
  const seen = new Set()
  const out = []
  for (let i = 0; lists.some(list => i < (list?.length || 0)); i++) {
    for (const list of lists) {
      if (!list || i >= list.length) continue
      const s = list[i]
      if (!s?.company || !s?.headline) continue
      const key = normalizeKey(s.company, s.headline, s.sourceUrl)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(s)
    }
  }
  return out
}

// 2026-09-01, Michael: the cross-industry-by-function pass (see
// scanOneCustomer below) roughly doubles this file's own Anthropic line
// item per customer per month if run on both of this cron's twice-daily
// fires. Michael's call after seeing the real cost numbers: keep the
// existing sector-scoped call running on both daily fires unchanged, but
// only run the ADDED cross-industry pass on one of the two — "once a day
// in the morning" — so the scope improvement lands daily without doubling
// its cost. This cron's schedule (see the `export const config` at the
// bottom of this file, and intelligence-scan.js's own `schedule` config) is
// a fixed '0 */12 * * *', firing at 00:00 UTC and 12:00 UTC — Michael chose
// the 00:00 UTC fire as "morning" (4am UAE / 1am UK BST / 8pm US East the
// prior day — the closer of the two fixed slots to a UAE/UK morning, this
// business's core market). `< 12` rather than an exact-hour match is
// deliberately tolerant of the invocation actually starting a few minutes
// (or, on a slow chain, longer) after the top of the hour. Computed ONCE
// per whole run (see the `export default` handler below), not per
// customer, so every customer in one invocation gets the same answer even
// if the per-customer loop runs long enough to cross the boundary.
export function isMorningCrossIndustryRun(now = new Date()) {
  return now.getUTCHours() < 12
}

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
  const functionBreadthHint = buildFunctionBreadthHint(onboarding?.functions)
  const introMessageField = introMessageInstruction(onboarding)
  // 2026-09-01, Michael: same reasoning as scan-now-background.js's own
  // crossIndustryByFunction branch (see that file's header on
  // runCrossIndustryFunctionPass) — a sector-scoped search alone can't see a
  // real BD opportunity at a company outside this recruiter's chosen
  // sectors, even though this recruiter places into the same FUNCTIONS
  // there too. Extended to the recurring cron as a genuinely separate,
  // additive second call (see scanOneCustomer below) rather than folded
  // into this single call, per Michael's explicit call after seeing the
  // real cost numbers — general for any account's own chosen functions.
  const crossIndustryByFunction = !!opts.crossIndustryByFunction
  const sectorLine = crossIndustryByFunction
    ? `Sectors this recruiter also actively targets (for reference only — NOT a restriction for this specific pass, see below): ${onboarding?.sectors?.join(', ') || 'General recruitment'}.`
    : `Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.`
  const scopeInstruction = crossIndustryByFunction ? `This pass is deliberately NOT limited to the sectors above. Search for genuine, timely BD-relevant signals tied specifically to these functions/roles: ${functions || "this recruiter's target functions"} — funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity — at companies in ANY industry, not only the sectors this recruiter's other searches already cover. The industry the company operates in genuinely does not matter for this pass, only that the signal involves one of the functions listed above.
${functionBreadthHint ? `Each function covers real breadth, not just its most senior title — search across all of it, not only the obvious C-suite headline:\n${functionBreadthHint}\n` : ''}
Also actively look for layoffs, redundancies, or restructuring news affecting these functions specifically, regardless of industry. This cuts both ways and both are worth surfacing: a company doing layoffs sometimes still needs to quietly backfill specific roles (frame the signal around that need), and separately, a real layoff or redundancy event puts a pool of genuinely available, often strong candidates on the market at once, worth surfacing on its own even with no obvious open role at that company, in which case candidateAngle should describe that available talent pool. Classify these as signalType "regulatory" and make the headline clearly say layoffs or redundancy so it's not confused with an ordinary hiring signal.
Search thoroughly before concluding there is nothing. Run multiple distinct searches, try each function AND each of its sub-disciplines listed above by name, combined with "appoints" / "hires" / "promotes" / "funding" / "expansion" / "restructuring", spread deliberately across a wide range of industries, not just this recruiter's usual sectors. Do not stop after one or two searches.
${functions ? `Every signal you find this way should already involve one of the functions listed above directly — that's what this pass searches for, not something to connect afterward. State which function (and sub-discipline, if it's clearly one of the ones listed above) it involves as part of your reasoning.` : ''}` : `Use web search to find genuine, timely BD-relevant signals in these sectors and markets right now: funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity.
Also actively look for layoffs, redundancies, or restructuring news. This cuts both ways and both are worth surfacing: a company doing layoffs sometimes still needs to quietly backfill specific roles (frame the signal around that need), and separately, a real layoff or redundancy event puts a pool of genuinely available, often strong candidates on the market at once, worth surfacing on its own even with no obvious open role at that company, in which case candidateAngle should describe that available talent pool. Classify these as signalType "regulatory" and make the headline clearly say layoffs or redundancy so it's not confused with an ordinary hiring signal.
Search thoroughly before concluding there is nothing. Run multiple distinct searches, try each sector and each function by name, try combinations of sector + "funding" / "hiring" / "appoints" / "expansion" / "acquires", try the specified markets by name, and try recent news generally in these sectors before narrowing. Do not stop after one or two searches, a real, live-news industry genuinely has more happening in it than that.
${functions ? `This recruiter places into the functions listed above. When you find a strong, genuine signal, connect it to whichever of those functions it most plausibly affects, even if the reasoning takes a small logical step (e.g. a funding round signals Finance/Strategy hiring, a safety incident signals HSE hiring, a new market launch signals Government/Regulatory Affairs hiring, an M&A deal signals Corporate Development or Legal hiring). Make your best reasonable case for the closest function rather than discarding a real, well-sourced signal purely because the function match isn't perfect. Only leave a strong signal out entirely if you genuinely cannot connect it to any of the functions listed, even loosely.${functionBreadthHint ? ` Remember each function covers real breadth beyond its most senior title:\n${functionBreadthHint}` : ''}` : ''}`
  return `You are Annie, an expert BD researcher for a recruitment firm.
${sectorLine}
Functions this recruiter places candidates into: ${functions || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `The recruiter's real writing style, follow this closely when writing the introMessage, candidateAngle, and benchStrengthAngle text:\n${onboarding.writing_style}\n` : ''}
${scopeInstruction}

Bias against obvious, oversaturated, famous names everyone already targets when a quieter, equally strong alternative exists, but do not discard a genuinely strong, well-sourced signal just because the company is well known, a real opportunity is better than an artificially obscure one.

${opts.adzunaLeads?.length ? `\nAdzuna's live jobs board shows these real, recent job postings that may match this recruiter's sectors and functions: ${opts.adzunaLeads.map(l => `"${l.title}" at ${l.company}${l.location ? ` (${l.location})` : ''}${l.salary ? `, salary ~${l.salary}` : ''} — ${l.url}`).join(' | ')}. For any of these that reads as posted directly by the company itself (no recruitment agency name, no "on behalf of our client" language, no agency branding) rather than through a recruiter or agency, this is a genuine open role with no recruiter attached — do NOT write this up as a generic "signal" entry. Instead, write it as its own "live_job" entry (see the separate live_job field list below), one per specific role, with the real posting URL as sourceUrl. Skip any that clearly look agency-posted. If a company has one or more of these live_job entries, do not also write a separate hiring_activity or job_posting_unclaimed signal entry about that same company being on a hiring push in general — the specific role entries replace that, they don't sit alongside it.\n` : ''}
${opts.theirStackLeads?.length ? `\nTheirStack (a paid live jobs API covering UAE/GCC, where Adzuna has no coverage) shows these real, recent job postings: ${opts.theirStackLeads.map(l => `"${l.title}" at ${l.company}${l.location ? ` (${l.location})` : ''}${l.salary ? `, salary ~${l.salary}` : ''} — ${l.url}`).join(' | ')}. Same rules as the Adzuna leads above — write a direct-posted one up as its own "live_job" entry with the real posting URL as sourceUrl, skip anything that reads as agency-posted, and don't also write a separate hiring_activity/job_posting_unclaimed entry for a company already covered by one of these.\n` : ''}

Adzuna only has real, live coverage for two of this recruiter's possible markets (United Kingdom, United States) — for every other market this customer actually selected, also use web search directly to find genuine, specific open roles: search a company's own careers page, LinkedIn Jobs postings, and the named regional job boards below.
${buildLiveJobBoardHint(onboarding?.locations, onboarding?.sectors)}
Write anything you find this way as its own "live_job" entry the same way as an Adzuna-sourced one — real specific title, sourceUrl pointing at the actual job posting page itself (not a news article merely mentioning that the company is hiring), no agency-posted roles. If you can only find a general "this company is hiring" mention with no specific posting page to cite, write that as an ordinary hiring_activity signal instead, never as a live_job entry — a live_job entry always needs its own real posting URL.

For every company you write up as a signal above (funding, expansion, leadership change, M&A, anything), before moving to the next one, do one direct follow-up check of that specific company's own website: search for its careers or jobs page to see whether it has a real, specific opening posted right now that matches this recruiter's target functions. If you find one, write it as an ADDITIONAL, separate "live_job" entry for that same company, same rules as above — a real title, sourceUrl pointing straight at that company's own posting. Skip it if the company genuinely has no findable careers page.
${buildRegionalSourceHint(onboarding?.locations, onboarding?.sectors, opts.learned)}
${buildTargetFirmHint(onboarding?.sectors, opts.learned, onboarding?.locations)}
${buildCustomerWatchlistHint(opts.watchlist)}
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

For each genuinely new company or source you noticed while checking the named sources above (see buildRegionalSourceHint's and buildTargetFirmHint's instructions earlier in this prompt) that isn't already in the lists they gave you, write a THIRD kind of entry instead:
- entryType: "annie_learned"
- kind: "company" or "source"
- sector: the exact sector label (from the list this recruiter targets, above) this belongs to
- value: the company name, or the source's name/domain, exactly as you'd want it referenced again on a future scan
- foundVia: the specific named source you found it on (e.g. "consultancy-me.com", "Legal 500 UAE"), never blank
- location: which market this discovery belongs to — one of exactly [${onboarding?.locations?.join(', ') || 'this recruiter\'s selected markets'}] (copy the spelling from that list exactly), or "Global" only if it's a genuinely global resource with no single home market (e.g. a worldwide-only ranking). Get this right: it decides whether this discovery is offered to future recruiters in the SAME market, or wrongly offered to recruiters in an unrelated one — a UAE-specific firm found via consultancy-me.com's UAE rankings is "UAE / GCC", never "Global". Required — do not omit this field or leave it blank.
Only include something here you actually found via search and are confident is real and current — never invent a plausible-sounding company or site to pad this out. Leave this out entirely for a scan where nothing genuinely new turned up, it is not required every time.

Return a single JSON array mixing all three kinds of entries, each tagged with its entryType. Only return the JSON array, nothing else. If nothing genuinely good was found, return an empty array.`
}

// maxTokens/maxUses now come from the calling customer's own tier (see
// SCAN_TIER_CONFIG in entitlements.js) instead of being fixed at 4096/8 for
// everyone — Michael's explicit call (2026-08-25): the daily recurring scan
// stays permanently different by tier, the same as the onboarding/upgrade
// scan, not just a one-time signup bonus. Defaults here match Starter's
// numbers exactly, so a caller that doesn't pass them (a unit test, or any
// future call site that doesn't care about tiering) behaves exactly as this
// function always has.
//
// 2026-08-26: userId/anthropicCaps added — see resolveAnthropicTokens's own
// comment in aiUsage.js for why this is now a per-customer-plus-platform-
// backstop reservation instead of one shared platform-wide total.
async function callAnthropic(apiKey, systemPrompt, supabase, { maxTokens = 4096, maxUses = 8, userId = null, anthropicCaps = {} } = {}) {
  // Anthropic spend had no cap anywhere in this codebase — mirrors the
  // existing Apollo daily-credit-cap pattern (reserveApolloCredits in
  // scanShared.js). Checked before the network call fires, same as Apollo's.
  if (!(await reserveAnthropicTokens(supabase, userId, maxTokens, anthropicCaps))) {
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
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Scan for signals now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    }),
  }, 90000, 1) // web search runs multiple search round-trips, needs far more than the 12s default
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}`)
  const data = await resp.json()
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

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
  const { anthropicKey, apolloKey, companiesHouseKey, adzunaAppId, adzunaAppKey, theirStackApiKey, supabase, crossIndustryRun } = ctx

  // 2026-08-25: resolved per customer, not once for the whole run — tier is
  // an account-level fact, and this loop scans every customer in one pass.
  // See SCAN_TIER_CONFIG in entitlements.js for the actual numbers.
  const { tier } = await getEntitlements(supabase, ob.user_id)
  const tierConfig = SCAN_TIER_CONFIG[tier] || SCAN_TIER_CONFIG.starter
  // Resolved once per customer alongside tierConfig above — see
  // resolveResourceCaps's own header for why this is a {userDailyCap,
  // platformDailyCap} pair per resource rather than a single shared number.
  const resourceCaps = resolveResourceCaps(tier)

  const recentCompanies = await fetchRecentCompanies(supabase, ob.user_id)

  // 2026-08-27, Michael: cross-customer signal pool — before spending an
  // Anthropic web-search call rediscovering something from scratch, check
  // whether another customer whose profile genuinely overlaps this one
  // (same sector, same market — see fetchSignalPoolMatches in
  // scanShared.js) already had it discovered and verified. Dedup against
  // this customer's full signal history first, same as always (see
  // fetchExistingDedupKeys's own comment) — just moved earlier so the pool
  // check can use it too. A full pool hit (covers this run's whole
  // MAX_SIGNALS_PER_RUN target) skips the AI call entirely; anything less
  // falls straight through to the exact same discovery this function has
  // always run, with the partial pool hit merged in as a free bonus —
  // never a reason this customer gets less than today.
  const existingKeys = await fetchExistingDedupKeys(supabase, ob.user_id)
  const poolMatches = await fetchSignalPoolMatches(supabase, ob, existingKeys, MAX_SIGNALS_PER_RUN)
  let poolPersonalized = []
  if (poolMatches.length) {
    const reserved = await reserveAnthropicTokens(supabase, ob.user_id, POOL_PERSONALIZE_MAX_TOKENS, resourceCaps.anthropicTokens)
    if (reserved) {
      poolPersonalized = (await personalizePoolHits(anthropicKey, poolMatches, ob)).map(e => ({ ...e, fromPool: true }))
      if (poolPersonalized.length) {
        console.log(`[intelligence-scan] signal pool contributed ${poolPersonalized.length} pre-verified signal(s) for`, ob.user_id, '- skipping fresh discovery for those')
      }
    } else {
      console.log('[intelligence-scan] Anthropic daily token cap reached — skipping pool personalization for', ob.user_id, ', falling back to fresh discovery only')
    }
  }

  let newSignals
  if (poolPersonalized.length >= MAX_SIGNALS_PER_RUN) {
    newSignals = poolPersonalized.slice(0, MAX_SIGNALS_PER_RUN)
  } else {
    const adzunaLeads = await discoverAdzunaJobs(adzunaAppId, adzunaAppKey, { sectors: ob.sectors, functions: ob.functions, locations: ob.locations })
    // TheirStack fills the gap Adzuna leaves for UAE/GCC — see
    // discoverTheirStackJobs's own header in scanShared.js. Only ever spends
    // a credit for a customer whose locations actually include a market
    // THEIRSTACK_COUNTRY_MAP covers, same "only pay for what's real" guard
    // reserveApolloCredits already has for Apollo.
    const theirStackLeads = await discoverTheirStackJobs(theirStackApiKey, { sectors: ob.sectors, functions: ob.functions, locations: ob.locations }, supabase, ob.user_id, resourceCaps.theirStack)
    const learned = await getLearnedSources(supabase, ob.sectors, ob.locations)
    const watchlist = await getCustomerWatchlistCompanies(supabase, ob)

    // 2026-09-01, Michael: applied to every recurring scan now, not just the
    // one-off onboarding scan — explicit call after seeing the real added
    // Anthropic cost (~$4-8.50/customer/month if run on every fire, roughly
    // doubling just this line of the recurring-scan cost). Run alongside
    // the existing sector-scoped call as a genuinely separate, equal-budget
    // pass (not folded into the one call, and not just a bigger token/
    // search-use ceiling on it — see buildScanPrompt's own header for why
    // that alone wouldn't have delivered real cross-industry coverage).
    // Skipped for an account with no functions selected (same guard as the
    // onboarding scan's runCrossIndustryFunctionPass) AND — Michael's very
    // next follow-up, once he saw that cost line — skipped on this cron's
    // 12:00 UTC fire, so the added cost is incurred once a day, not twice
    // (see isMorningCrossIndustryRun's own header above for which fire and
    // why). The primary sector-scoped call is untouched and still runs on
    // both fires, unchanged.
    const [text, crossIndustryText] = await Promise.all([
      callAnthropic(anthropicKey, buildScanPrompt(ob, recentCompanies, { adzunaLeads, theirStackLeads, learned, watchlist }), supabase, { maxTokens: tierConfig.anthropicMaxTokens, maxUses: tierConfig.anthropicMaxUses, userId: ob.user_id, anthropicCaps: resourceCaps.anthropicTokens }),
      (ob.functions?.length && crossIndustryRun)
        ? callAnthropic(anthropicKey, buildScanPrompt(ob, recentCompanies, { crossIndustryByFunction: true, learned, watchlist }), supabase, { maxTokens: tierConfig.anthropicMaxTokens, maxUses: tierConfig.anthropicMaxUses, userId: ob.user_id, anthropicCaps: resourceCaps.anthropicTokens })
            .catch(err => {
              // A cap hit or transient failure on JUST this second call
              // should never take down the customer's whole scan — the
              // primary sector-scoped call above still runs and writes
              // normally, this pass simply contributes nothing this round.
              console.error('[intelligence-scan] cross-industry-by-function call failed for', ob.user_id, err.message)
              return null
            })
        : Promise.resolve(null),
    ])
    const { learned: learnedFound, rest: rawFound } = splitLearnedEntries(extractJson(text))
    let crossIndustryFound = []
    if (crossIndustryText) {
      const parsed = splitLearnedEntries(extractJson(crossIndustryText))
      crossIndustryFound = parsed.rest
      learnedFound.push(...parsed.learned)
    }
    // Fire-and-forget on purpose — this is Annie's own research memory
    // growing for next time (see getLearnedSources/recordLearnedDiscoveries's
    // own headers), it has zero bearing on this customer's signals and
    // should never slow this run down or fail it. recordLearnedDiscoveries
    // already fails soft internally.
    if (learnedFound.length) recordLearnedDiscoveries(supabase, learnedFound).catch(() => {})
    // Enforce "replace, not supplement" here in code — see the function's own
    // comment in scanShared.js for why this can't just be a prompt instruction
    // alone. Pool hits go first (they're free, already-verified). The sector-
    // scoped and cross-industry-by-function results are interleaved, not
    // concatenated, before the MAX_SIGNALS_PER_RUN slice below — a plain
    // concat would let whichever call happens to return first (or biggest)
    // silently crowd out the other every single run, the same class of bug
    // buildSearchKeywords' own header describes for sector/function keywords.
    const found = dropGenericHiringWhereLiveJobsExist([...poolPersonalized, ...interleaveSignalLists([rawFound, crossIndustryFound])])
    if (!found.length) {
      // Log a preview so a zero-result customer is diagnosable from the log,
      // not guessed at. See looksTruncatedByTokenLimit's own header — tells
      // "genuinely nothing found" apart from "max_tokens cut the response
      // off before it finished", which used to be indistinguishable here.
      const preview = (text || '').trim().slice(0, 400)
      const truncated = looksTruncatedByTokenLimit(text)
      console.log('[intelligence-scan] nothing found for', ob.user_id, truncated ? '| LIKELY TRUNCATED BY max_tokens (raise anthropicMaxTokens for this tier if this keeps happening)' : '', '| raw response preview:', preview || '(empty response)')
      // 2026-08-27: log every scan attempt, found-something or not — the
      // zero-result runs are exactly what a genuinely thin market looks
      // like over time (see getMarketCoverageReport's own header).
      await logMarketCoverage(supabase, ob, 0)
      return 0
    }

    newSignals = found
      .filter(s => s.company && s.headline && !existingKeys.has(normalizeKey(s.company, s.headline, s.sourceUrl)))
      .slice(0, MAX_SIGNALS_PER_RUN)
  }

  if (!newSignals.length) {
    console.log('[intelligence-scan] only duplicates found for', ob.user_id, ', skipping enrichment')
    await logMarketCoverage(supabase, ob, 0)
    return 0
  }

  // Row-building itself lives once in scanShared.js, shared with
  // scan-now-background.js — see buildEnrichedSignalRows's own comment.
  // locationHints — see scan-now-background.js's identical call for why:
  // lets enrichCompany prefer an Apollo org whose country matches this
  // customer's monitored markets when a company name alone is ambiguous
  // (see pickBestOrgMatch in scanShared.js).
  const rows = await buildEnrichedSignalRows(newSignals, { userId: ob.user_id, apolloKey, companiesHouseKey, supabase, logPrefix: '[intelligence-scan]', locationHints: ob.locations || [], apolloContactRetry: tierConfig.apolloContactRetry, apolloCaps: resourceCaps.apollo })
  if (!rows.length) {
    await logMarketCoverage(supabase, ob, 0)
    return 0
  }

  // Write genuinely fresh discoveries through to the shared pool (see
  // writeToSignalPool's own header in scanShared.js) so the next customer
  // with an overlapping profile benefits from this run — never re-writes
  // an entry that itself came from the pool. Best-effort, fails soft.
  const freshDiscoveries = newSignals.filter(s => !s.fromPool)
  if (freshDiscoveries.length) await writeToSignalPool(supabase, freshDiscoveries, ob)

  // Throwing here (rather than swallowing) is deliberate: this function's
  // caller already reports to error_logs and moves on to the next customer,
  // which is exactly the right handling for a write failure too.
  const { error } = await supabase.from('intelligence_signals').upsert(rows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true })
  if (error) throw new Error(`signal upsert failed: ${error.message}`)
  // 2026-08-27: logged after a successful write too — see
  // getMarketCoverageReport's own header for why both the zero and
  // non-zero cases matter equally to a real coverage picture.
  await logMarketCoverage(supabase, ob, rows.length)
  return rows.length
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  // 2026-08-31: this endpoint is directly URL-reachable (unlike the old
  // combined schedule+background function it replaced) — see this file's
  // own header. Every invocation must carry the same shared secret
  // scan-now-background.js's own internal chaining already requires; an
  // unauthenticated hit (a stray bot, someone who found the URL) is
  // rejected before touching Supabase or spending anything.
  const internalSecret = req.headers.get('x-internal-scan-secret')
  if (!INTERNAL_SCAN_SECRET || !internalSecret || internalSecret !== INTERNAL_SCAN_SECRET) {
    console.error('[intelligence-scan-background] rejected request with missing/invalid x-internal-scan-secret')
    return new Response('Unauthorized', { status: 401 })
  }

  const runStartedAt = Date.now()
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const apolloKey = process.env.APOLLO_API_KEY
  const companiesHouseKey = process.env.COMPANIES_HOUSE_API_KEY
  const adzunaAppId = process.env.ADZUNA_APP_ID
  const adzunaAppKey = process.env.ADZUNA_APP_KEY
  const theirStackApiKey = process.env.THEIRSTACK_API_KEY
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
  const crossIndustryRun = isMorningCrossIndustryRun()
  console.log(`[intelligence-scan-background] cross-industry-by-function pass ${crossIndustryRun ? 'WILL' : 'will NOT'} run this invocation (00:00 UTC fire only, see isMorningCrossIndustryRun)`)
  const scanCtx = { anthropicKey, apolloKey, companiesHouseKey, adzunaAppId, adzunaAppKey, theirStackApiKey, supabase, crossIndustryRun }

  for (const ob of onboardingRows) {
    if (Date.now() - runStartedAt > RUN_BUDGET_MS) {
      // Stop starting new customers, not mid-write on the current one —
      // the loop only checks this at the top, between customers. The
      // remaining rows get picked up by the next scheduled run; logged
      // clearly (not silently) so a shrinking per-run coverage percentage
      // as the customer base grows is visible before it becomes a support
      // ticket instead of after. See the RUN_BUDGET_MS comment above —
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
      await reportServerError('intelligence-scan-background', err, { userId: ob.user_id })
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

// Deliberately NO `config` export here — no `schedule`, no `background`
// flag. This function's long execution budget (Netlify's 15-minute
// background ceiling, which RUN_BUDGET_MS above is paced against) comes
// entirely from the `-background` filename suffix, the one combination
// Netlify staff confirm actually works and that scan-now-background.js
// already proves out in production for every real "Scan Now" click. See
// this file's own header for why the previous `schedule` + `background:
// true` config-property combination (on the file this one replaces) was
// never actually a reliable way to get that same budget for a scheduled
// invocation specifically.

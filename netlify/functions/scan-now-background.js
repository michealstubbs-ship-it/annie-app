// Runs one immediate research scan for a single, just-onboarded customer, so
// they land on their dashboard with real signals already waiting instead of
// staring at an empty page until the next cron tick (which loops every
// customer and can be hours away). Fired once, without being awaited, right
// after onboarding finishes — the customer moves straight on to the
// LinkedIn import step while this keeps running server-side, and is very
// often done before they get through it.
//
// This is THE first-impression moment for a brand new customer, so unlike
// the recurring cron this one is deliberately over-resourced: instead of
// one AI call trying to cover every sector and function a customer picked
// with a shared search budget, it runs several calls in parallel (one per
// sector group), each with its own generous search budget, then merges the
// results. If that still comes up thin, it runs one more, deliberately
// broader pass before giving up. It only runs once per signup, never on a
// schedule, so the extra Anthropic/Apollo spend here is small in absolute
// terms.
//
// Shares pure logic (dedup keys, JSON extraction, Apollo/Adzuna/Companies
// House calls) with intelligence-scan.js via lib/scanShared.js, so a fix
// made once applies to both — but keeps its own orchestration (parallel
// sector groups, the broaden pass, model/budget choices) separate on
// purpose, since this is a background function (different runtime
// contract, 15-minute wall clock budget, no response body) and changes made
// for the one-off onboarding scan should never risk the cron that already
// runs reliably in production. Netlify requires the "-background" filename
// suffix to run it this way.
import { createClient } from '@supabase/supabase-js'
import { getStore } from '@netlify/blobs'
import { reportServerError } from './lib/reportError.js'
import { getAuthedUser } from './lib/auth.js'
import { reserveAnthropicTokens } from './lib/aiUsage.js'
import { getEntitlements, SCAN_TIER_CONFIG, resolveResourceCaps } from './lib/entitlements.js'
import {
  SIGNAL_TYPES, SIGNAL_LOOKBACK_DAYS, normalizeKey, splitToKeywords, extractJson, looksTruncatedByTokenLimit,
  discoverHotCompanies, discoverAdzunaJobs, discoverTheirStackJobs, fetchWithRetry, mapLocationsToAdzunaCountries,
  dropGenericHiringWhereLiveJobsExist, buildEnrichedSignalRows, createTimeoutFetch,
  buildRegionalSourceHint,
  buildLiveJobBoardHint,
  buildTargetFirmHint,
  getLearnedSources,
  recordLearnedDiscoveries,
  splitLearnedEntries,
  fetchSignalPoolMatches,
  personalizePoolHits,
  writeToSignalPool,
  POOL_PERSONALIZE_MAX_TOKENS,
  logMarketCoverage,
} from './lib/scanShared.js'

// How many sector groups to research in parallel.
const MAX_SECTOR_GROUPS = 4
// 2026-08-25: replaced the old flat MIN_SIGNAL_TARGET = 3 with the real,
// tier-specific targets in SCAN_TIER_CONFIG (entitlements.js) — Michael's
// call: Starter gets one solid scan, Growth/Team chase a materially fuller
// dashboard (20 feed signals, 3 with a real contact), and daily scans stay
// tier-different permanently, not just on day one. See that file's own
// header for the full reasoning and the exact numbers.
//
// Chaining mechanism: this function still only ever does ONE round's worth
// of research per invocation — round 1 is the existing parallel-sector-
// groups-plus-broaden pass below, unchanged in shape. If a round finishes
// still short of the account's tier targets, and there's ceiling left
// (round count, wall clock since the chain started), this fires a fresh,
// unawaited invocation of ITSELF to run the next round, authenticated via
// INTERNAL_SCAN_SECRET rather than a user session token (there usually
// isn't a live browser session by round 3, and never one at all when a
// chain is seeded by the Stripe upgrade webhook instead of onboarding) —
// see resolveCaller below. Each invocation staying comfortably inside its
// own WALL_CLOCK_BUDGET_MS is what keeps this safe against Netlify's
// 15-minute per-invocation hard kill regardless of how many rounds a slow
// niche needs.
const INTERNAL_SCAN_SECRET = process.env.INTERNAL_SCAN_SECRET

// Was 12 — an arbitrary number that had nothing to do with how many genuine
// signals a first scan can actually find, and was silently dropping real,
// already-found signals with zero logging of how many or which ones. Up to
// 4 sector-group calls plus a broaden pass can return up to 8 signals each
// (see buildScanPrompt's "Return up to 8 signals"), so 40 is comfortably
// above the realistic ceiling of a single run rather than a second hidden
// cap wearing the first one's clothes. Every signal that makes it past this
// still gets full Apollo/Companies House/source-verification enrichment,
// same as before — this only changes how many get the chance.
const MAX_TOTAL_SIGNALS = 40

// Defense in depth alongside createTimeoutFetch (see that function's own
// header in scanShared.js for the actual root-cause fix): even with every
// individual call now bounded, a genuinely slow run (many signals, a
// degraded upstream API retrying its full backoff on every call) could
// still add up close to Netlify's hard 15-minute kill. Same pattern
// intelligence-scan.js already uses (RUN_BUDGET_MS) — checked before the
// optional broaden pass, which is the one phase safe to skip outright: a
// thinner-than-ideal first scan that actually finishes and writes a status
// is always better than a thorough one that gets hard-killed and writes
// nothing. Leaves a wide margin (15 - 10 = 5 minutes) for the group calls
// already in flight plus the enrichment phase that follows.
const WALL_CLOCK_BUDGET_MS = 10 * 60 * 1000

// This pass is deliberately the expensive one (stronger model, up to 4
// parallel sector-group calls plus a broaden pass) — see the file header.
// One hour balances "a customer who got nothing shouldn't have to wait
// long" against "this shouldn't be trivially spammable from Settings."
const RESCAN_COOLDOWN_MS = 60 * 60 * 1000

// A brand new customer landing on an empty dashboard for the full loading
// window even when the scan genuinely finished in 11 seconds (found nothing
// worth reporting, or hit an error) reads as broken, not slow. This status
// blob is how the frontend tells "still running" apart from "finished,
// here's what actually happened" — see scan-status.js (reads it) and
// Overview.jsx (polls scan-status.js instead of just guessing off a timer).
async function setStatus(userId, data) {
  try {
    const store = getStore({ name: 'annie-scan-status', consistency: 'strong' })
    await store.setJSON(userId, data)
  } catch (err) {
    console.error('[scan-now] failed to write status blob for', userId, err.message)
  }
}

// Splits a customer's selected sectors into up to maxGroups buckets so each
// AI call researches a narrower slice with its own full search budget,
// instead of one call rationing searches across everything the customer
// picked. A customer with 1-4 sectors gets one call per sector; more than
// that and sectors are distributed round-robin across the group cap so
// total cost stays bounded regardless of how many a customer selects.
function chunkSectors(sectors, maxGroups) {
  if (!sectors?.length) return [null]
  const groupCount = Math.min(maxGroups, sectors.length)
  const buckets = Array.from({ length: groupCount }, () => [])
  sectors.forEach((s, i) => buckets[i % groupCount].push(s))
  return buckets
}

// Merges signal lists from multiple AI calls (per-sector-group, plus
// optionally a broaden pass), deduplicating by source URL where there is one
// (a hard fact, unlike the AI's own headline wording — see normalizeKey's
// header) so the same real event found via two different searches doesn't
// get written twice, even if the two calls phrased its headline differently.
function mergeSignals(lists) {
  const seen = new Map()
  for (const list of lists) {
    for (const s of list || []) {
      if (!s?.company || !s?.headline) continue
      const key = normalizeKey(s.company, s.headline, s.sourceUrl)
      if (!seen.has(key)) seen.set(key, s)
    }
  }
  return [...seen.values()]
}

// splitLearnedEntries now lives in scanShared.js (see its own header) so
// both scan files share exactly one definition of an "annie_learned" entry.

// The exact shape a real customer confirmed works (2026-08-23 product-copy
// pass): a warm opener, one paragraph that introduces the firm and the
// specific niche this signal calls for (never the recruiter's whole sector
// list), explains the insight in plain language rather than restating
// stats, names relevant regional experience, and positions the recruiter as
// a value-adding partner through their candidate network — then a short
// closing paragraph that just asks for a call. Shared by both the signal
// and live_job field lists below so the two never drift apart.
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
  const sectorsForPrompt = opts.sectorsOverride?.length ? opts.sectorsOverride : onboarding?.sectors
  const introMessageField = introMessageInstruction(onboarding)
  return `You are Annie, an expert BD researcher for a recruitment firm.
Sectors: ${sectorsForPrompt?.join(', ') || 'General recruitment'}.
Functions this recruiter places candidates into: ${functions || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `The recruiter's real writing style, follow this closely when writing the introMessage, candidateAngle, and benchStrengthAngle text:\n${onboarding.writing_style}\n` : ''}
Use web search to find genuine, timely BD-relevant signals in these sectors and markets from the last ${SIGNAL_LOOKBACK_DAYS} days: funding rounds, leadership changes, hiring activity, expansions, team-building posts, notable public commentary, unclaimed job postings (posted directly by a company with no recruiter attached), M&A, or regulatory news that creates a real BD opportunity. A signal from any point in the last ${SIGNAL_LOOKBACK_DAYS} days counts as timely, it does not need to have happened today or this specific hour.
Also actively look for layoffs, redundancies, or restructuring news. This cuts both ways and both are worth surfacing: a company doing layoffs sometimes still needs to quietly backfill specific roles (frame the signal around that need), and separately, a real layoff or redundancy event puts a pool of genuinely available, often strong candidates on the market at once, worth surfacing on its own even with no obvious open role at that company, in which case candidateAngle should describe that available talent pool. Classify these as signalType "regulatory" and make the headline clearly say layoffs or redundancy so it's not confused with an ordinary hiring signal.
Search thoroughly before concluding there is nothing. Run multiple distinct searches, try each sector and each function by name, try combinations of sector + "funding" / "hiring" / "appoints" / "expansion" / "acquires", try the specified markets by name, and try recent news generally in these sectors before narrowing. Do not stop after one or two searches, a real, live-news industry genuinely has more happening in it than that.
${functions ? `This recruiter places into the functions listed above. When you find a strong, genuine signal, connect it to whichever of those functions it most plausibly affects, even if the reasoning takes a small logical step (e.g. a funding round signals Finance/Strategy hiring, a safety incident signals HSE hiring, a new market launch signals Government/Regulatory Affairs hiring, an M&A deal signals Corporate Development or Legal hiring). Make your best reasonable case for the closest function rather than discarding a real, well-sourced signal purely because the function match isn't perfect. Only leave a strong signal out entirely if you genuinely cannot connect it to any of the functions listed, even loosely.` : ''}
${opts.broaden ? `\nIMPORTANT: ${opts.broadenReason || 'an earlier, narrower search pass came up thin'}. For this pass, widen your net further: look back up to the last 4 weeks (not just the last ${SIGNAL_LOOKBACK_DAYS} days), consider the parent industry category as well as the exact sub-sector, and count a signal even if the function connection takes a slightly longer logical chain, as long as it is still genuinely defensible. The bar is "real and sourced", not "perfect fit". Still never invent anything, and still cite a real source for every signal.\n` : ''}
${opts.apolloLeads?.length ? `\nApollo's own hiring database has independently confirmed these companies are actively posting jobs matching this recruiter's functions, within the last ${SIGNAL_LOOKBACK_DAYS} days, in these sectors and markets: ${opts.apolloLeads.map(l => `${l.name}${l.industry ? ` (${l.industry})` : ''}`).join(', ')}. Treat these as strong, confirmed leads, actively search for the real story behind each one (why they're hiring, any funding or expansion tied to it, the right person to approach, a real citable source) before deciding whether to include it. You are not limited to only these companies, keep searching broadly too, but do not ignore this list, Apollo already did real work to surface it.\n` : ''}
${opts.adzunaLeads?.length ? `\nAdzuna's live jobs board shows these real, recent job postings that may match this recruiter's sectors and functions: ${opts.adzunaLeads.map(l => `"${l.title}" at ${l.company}${l.location ? ` (${l.location})` : ''}${l.salary ? `, salary ~${l.salary}` : ''} — ${l.url}`).join(' | ')}. For any of these that reads as posted directly by the company itself (no recruitment agency name, no "on behalf of our client" language, no agency branding) rather than through a recruiter or agency, this is a genuine open role with no recruiter attached — do NOT write this up as a generic "signal" entry. Instead, write it as its own "live_job" entry (see the separate live_job field list below), one per specific role, with the real posting URL as sourceUrl. Skip any that clearly look agency-posted. If a company has one or more of these live_job entries, do not also write a separate hiring_activity or job_posting_unclaimed signal entry about that same company being on a hiring push in general — the specific role entries replace that, they don't sit alongside it.\n` : ''}
${opts.theirStackLeads?.length ? `\nTheirStack (a paid live jobs API covering UAE/GCC, where Adzuna has no coverage) shows these real, recent job postings: ${opts.theirStackLeads.map(l => `"${l.title}" at ${l.company}${l.location ? ` (${l.location})` : ''}${l.salary ? `, salary ~${l.salary}` : ''} — ${l.url}`).join(' | ')}. Same rules as the Adzuna leads above — write a direct-posted one up as its own "live_job" entry with the real posting URL as sourceUrl, skip anything that reads as agency-posted, and don't also write a separate hiring_activity/job_posting_unclaimed entry for a company already covered by one of these.\n` : ''}

Adzuna only has real, live coverage for two of this recruiter's possible markets (United Kingdom, United States) — for every other market this customer actually selected, also use web search directly to find genuine, specific open roles: search a company's own careers page, LinkedIn Jobs postings, and the named regional job boards below.
${buildLiveJobBoardHint(onboarding?.locations, sectorsForPrompt)}
Write anything you find this way as its own "live_job" entry the same way as an Adzuna-sourced one — real specific title, sourceUrl pointing at the actual job posting page itself (not a news article merely mentioning that the company is hiring), no agency-posted roles. If you can only find a general "this company is hiring" mention with no specific posting page to cite, write that as an ordinary hiring_activity signal instead, never as a live_job entry — a live_job entry always needs its own real posting URL.

For every company you write up as a signal above (funding, expansion, leadership change, M&A, anything), before moving to the next one, do one direct follow-up check of that specific company's own website: search for its careers or jobs page (e.g. "[company] careers", "[company] jobs", or "site:[company's domain] careers") to see whether it has a real, specific opening posted right now that matches this recruiter's target functions. If you find one, write it as an ADDITIONAL, separate "live_job" entry for that same company, same rules as above — a real title, sourceUrl pointing straight at that company's own posting. This is deliberately different from the general job-board sweep above: it's a targeted check on a company you've already flagged as newsworthy, not a blind search, and it's what turns "this company just raised funding" into a complete BD story with a live opening to point to in the same outreach. Skip it if the company genuinely has no findable careers page.
${buildRegionalSourceHint(onboarding?.locations, sectorsForPrompt, opts.learned)}
${buildTargetFirmHint(sectorsForPrompt, opts.learned)}
This is a brand new account with no history yet, so there is nothing to avoid repeating: ${recentCompanies.join(', ') || 'None yet'}.

Every signal must have a real, citable source you actually found via search. Do not invent anything. Return up to 8 signals, fewer if you can't find genuinely good ones after searching thoroughly, never pad with weak filler.

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
Only include something here you actually found via search and are confident is real and current — never invent a plausible-sounding company or site to pad this out. Leave this out entirely for a scan where nothing genuinely new turned up, it is not required every time.

Return a single JSON array mixing all three kinds of entries, each tagged with its entryType. Only return the JSON array, nothing else. If nothing genuinely good was found, return an empty array.`
}

async function callAnthropic(apiKey, systemPrompt, { maxUses = 8, maxTokens = 4096, supabase = null, userId = null, anthropicCaps = {} } = {}) {
  // Anthropic spend had no cap anywhere in this codebase — mirrors the
  // existing Apollo daily-credit-cap pattern (see reserveApolloCredits in
  // scanShared.js). Checked before the network call fires, same as Apollo's.
  // 2026-08-26: per-customer-plus-platform-backstop now, not one shared
  // platform-wide total — see resolveAnthropicTokens's own comment in
  // aiUsage.js. Also fixes a real bug found while making this change:
  // runAdditionalRound (round 2+ of a chained scan) was never passing
  // `supabase` through to this function at all, so reserveAnthropicTokens's
  // own `if (!supabase) return true` fail-open path meant every round-2+
  // call silently skipped the cap check entirely, not just the per-customer
  // half of it.
  if (!(await reserveAnthropicTokens(supabase, userId, maxTokens, anthropicCaps))) {
    throw new Error('Anthropic daily token cap reached — skipping this call')
  }
  // A brand new customer's first scan is the moment that makes or breaks
  // their first impression of the whole product, so this one uses the
  // stronger model even though it costs more per call. It only runs once
  // per signup, not on a recurring schedule, so the extra cost here is
  // small in absolute terms. The recurring cron (intelligence-scan.js)
  // stays on the cheaper model to control cost at scale.
  // retries=1: this call already runs with a long timeout for multi-round
  // web search, and this file runs multiple sector-group calls per customer
  // (see below) — a full 2-retry budget per group could burn a large chunk
  // of the 15-minute wall-clock budget on one bad group. One retry still
  // absorbs a transient 429/5xx.
  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Scan for signals now.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
    }),
  }, 120000, 1) // web search runs multiple search round-trips, needs far more than the 12s default
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}`)
  const data = await resp.json()
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
}

// 2026-08-24 Task 2 (refactor, no behavior change): the default handler
// below used to run its research phase (parallel sector-group calls plus
// the optional broaden pass) and its enrich-and-write phase inline, as part
// of one long function mixing guard clauses, orchestration, and the write.
// Pulled the two heaviest, most self-contained phases out into named
// functions so each reads on its own; the guard clauses (duplicate-trigger
// check, onboarding lookup, cooldown) stay inline in the handler since
// they're a short, linear sequence of early returns that's clearer left
// where the returns actually happen. No change to what any step does.

// Every subsequent round (2+) in a chained scan — see the chaining comment
// above MIN_SIGNAL_TARGET's old spot. Deliberately cheaper than round 1
// (one wider-net call instead of up to 4 parallel sector-group calls): by
// round 2 the account already has real coverage from round 1, so this is
// about filling gaps, not re-covering everything from scratch. recentNames
// is passed straight into the prompt's "avoid repeating" line so a chained
// round actually searches for NEW real signals instead of re-finding (or
// worse, being tempted to pad with near-duplicates of) what round 1 already
// wrote.
async function runAdditionalRound(ob, tierConfig, recentNames, round, learned, userId, supabase, resourceCaps) {
  const text = await callAnthropic(process.env.ANTHROPIC_API_KEY, buildScanPrompt(ob, recentNames, {
    broaden: true,
    broadenReason: `this is chained research round ${round} for this account — the earlier round(s) already found real signals, so widen further still (older lookback, adjacent function connections) to find genuinely NEW ones rather than repeating what's already been found`,
    learned,
  }), { maxUses: tierConfig.anthropicBroadenMaxUses, maxTokens: tierConfig.anthropicMaxTokens, supabase, userId, anthropicCaps: resourceCaps.anthropicTokens })
  const { learned: learnedFound, rest } = splitLearnedEntries(extractJson(text))
  return { found: rest, learnedFound, rawText: text }
}

// Runs every sector-group research call in parallel, merges the results,
// then — if that came up thin and there's still wall-clock budget — runs
// one broader pass and merges that in too. Returns everything the handler
// needs to log and to decide what to enrich. This is round 1 of a chained
// scan — see the chaining comment above MIN_SIGNAL_TARGET's old spot.
async function runResearchPhase(ob, tierConfig, ctx) {
  const { userId, anthropicKey, apolloKey, adzunaAppId, adzunaAppKey, theirStackApiKey, supabase, startedAt, resourceCaps } = ctx

  // Adzuna has no coverage at all for some markets this recruiter can
  // select (notably UAE/GCC — see ADZUNA_COUNTRY_MAP) — for those accounts
  // every sector-group call below starts with zero Adzuna leads to work
  // from, no matter how the sectors are sliced. Previously the only
  // response to a thin result was the broaden pass further down, AFTER the
  // narrow first pass already came back weak — for an Adzuna-blind market
  // that first pass is thin by construction, not by bad luck, so an
  // account like this was starting its very first scan already behind
  // before a single search even ran, and a market this thin often didn't
  // recover even after the broaden pass, landing the customer on a
  // genuinely empty first dashboard. Detected once here and fed into the
  // first-pass prompt itself (wider lookback, bigger search budget) instead
  // of only reacting after the fact.
  const noAdzunaCoverage = mapLocationsToAdzunaCountries(ob.locations).length === 0

  // 2026-08-27, Michael: cross-customer signal pool — this is round 1,
  // which is also this account's very first scan ever, so it's exactly
  // the "first day sign up" moment this was built for. Before spending
  // anything on fresh discovery, check whether another customer whose
  // profile genuinely overlaps this one (same sector, same market — see
  // fetchSignalPoolMatches in scanShared.js) has already had a real signal
  // discovered and verified today. If the pool alone already covers this
  // account's whole feed target, skip the parallel sector-group discovery
  // entirely — this account gets a populated dashboard in the time it
  // takes one small, no-web-search personalization call to run, instead of
  // waiting on however long several parallel 90-120s web-search calls take.
  // If the pool falls short, nothing here changes: the full discovery pass
  // below still runs exactly as it always has, with any pool hits merged
  // in afterwards as bonus signals on top — never a reason this account
  // gets LESS than it would have gotten today.
  const { data: existingRows } = await supabase.from('intelligence_signals').select('dedup_key').eq('user_id', userId)
  const existingKeys = new Set((existingRows || []).map(r => r.dedup_key))
  const poolMatches = await fetchSignalPoolMatches(supabase, ob, existingKeys, tierConfig.feedSignalTarget)
  let poolPersonalized = []
  if (poolMatches.length) {
    const reserved = await reserveAnthropicTokens(supabase, userId, POOL_PERSONALIZE_MAX_TOKENS, resourceCaps.anthropicTokens)
    if (reserved) {
      poolPersonalized = (await personalizePoolHits(anthropicKey, poolMatches, ob)).map(e => ({ ...e, fromPool: true }))
      if (poolPersonalized.length) {
        console.log(`[scan-now] signal pool contributed ${poolPersonalized.length} pre-verified signal(s) for`, userId, '- skipping fresh discovery for those')
      }
    } else {
      console.log('[scan-now] Anthropic daily token cap reached — skipping pool personalization for', userId, ', falling back to fresh discovery only')
    }
  }
  if (poolPersonalized.length >= tierConfig.feedSignalTarget) {
    const capped = dropGenericHiringWhereLiveJobsExist(poolPersonalized).slice(0, MAX_TOTAL_SIGNALS)
    return { groups: [ob.sectors || []], capped, broadened: false, broadenPreview: null, noAdzunaCoverage, poolContribution: poolPersonalized.length }
  }

  // Fetched once per scan, reused across every sector-group call and the
  // broaden pass below — see getLearnedSources's own header for why this
  // is a single shared, cross-account table rather than a per-call lookup.
  const learned = await getLearnedSources(supabase, ob.sectors, ob.locations)
  const learnedEntries = []

  const groups = chunkSectors(ob.sectors, MAX_SECTOR_GROUPS)
  const groupResults = await Promise.all(groups.map(async (sectorGroup) => {
    const groupSectors = sectorGroup?.length ? sectorGroup : ob.sectors
    const [apolloLeads, adzunaLeads, theirStackLeads] = await Promise.all([
      discoverHotCompanies(apolloKey, { sectors: groupSectors, functions: ob.functions, locations: ob.locations }, supabase, userId, resourceCaps.apollo),
      discoverAdzunaJobs(adzunaAppId, adzunaAppKey, { sectors: groupSectors, functions: ob.functions, locations: ob.locations }),
      // Fills the UAE/GCC gap Adzuna leaves — see discoverTheirStackJobs's
      // own header in scanShared.js. This is exactly the noAdzunaCoverage
      // case below, which is why that broaden pass stays on regardless of
      // whether this returns leads: TheirStack supplements the search, it
      // doesn't replace casting a wide net on a market Adzuna can't seed.
      discoverTheirStackJobs(theirStackApiKey, { sectors: groupSectors, functions: ob.functions, locations: ob.locations }, supabase, userId, resourceCaps.theirStack),
    ])
    try {
      const promptOpts = { sectorsOverride: sectorGroup, apolloLeads, adzunaLeads, theirStackLeads, learned }
      if (noAdzunaCoverage) {
        promptOpts.broaden = true
        promptOpts.broadenReason = "this recruiter's market has no live-jobs-board coverage to seed leads from (e.g. UAE/GCC), so cast a wide net from this very first pass rather than waiting to come back thin first"
      }
      const text = await callAnthropic(anthropicKey, buildScanPrompt(ob, [], promptOpts), { supabase, maxUses: noAdzunaCoverage ? tierConfig.anthropicBroadenMaxUses : tierConfig.anthropicMaxUses, maxTokens: tierConfig.anthropicMaxTokens, userId, anthropicCaps: resourceCaps.anthropicTokens })
      const { learned: learnedFound, rest } = splitLearnedEntries(extractJson(text))
      learnedEntries.push(...learnedFound)
      return { sectorGroup, found: rest, rawText: text }
    } catch (err) {
      console.error('[scan-now] group call failed for', userId, sectorGroup?.join('/') || 'general', err.message)
      // Unlike intelligence-scan.js (the cron, one Anthropic call per user,
      // whose single catch already reports here), this file runs several
      // sector-group calls per user in parallel — a failure here used to
      // vanish into Netlify's own ephemeral function logs with nothing
      // persisted, so a customer landing on an empty first dashboard because
      // every group call actually failed (bad key, rate limit, outage) was
      // indistinguishable from a genuine "nothing found" run. Report it the
      // same way the cron does, per group, so a real cause leaves a trace.
      await reportServerError('scan-now-background', err, { userId, stage: 'sector-group', sectors: sectorGroup?.join('/') || 'general' })
      return { sectorGroup, found: [], rawText: '', error: err.message }
    }
  }))

  groupResults.forEach(g => {
    if (!g.found.length) {
      const preview = (g.rawText || '').trim().slice(0, 300)
      // See looksTruncatedByTokenLimit's own header — tells "genuinely
      // nothing found" apart from "max_tokens cut the response off before
      // it finished", which used to be indistinguishable in these logs.
      const truncated = looksTruncatedByTokenLimit(g.rawText)
      console.log('[scan-now] group came back empty for', userId, '| sectors:', g.sectorGroup?.join('/') || 'general', truncated ? '| LIKELY TRUNCATED BY max_tokens (raise anthropicMaxTokens for this tier if this keeps happening)' : '', '| preview:', preview || g.error || '(empty response)')
    }
  })

  let merged = mergeSignals(groupResults.map(g => g.found))
  let broadened = false
  let broadenPreview = null

  // Safety net: a brand new customer should not land on an empty first
  // dashboard just because the narrower per-sector passes came up thin.
  // Run one more deliberately broader pass before accepting that — unless
  // the run is already deep into its wall-clock budget (see
  // WALL_CLOCK_BUDGET_MS above), in which case skipping this optional pass
  // and moving straight to enrichment is what actually gets this customer a
  // working dashboard instead of a hard-killed function.
  const elapsedBeforeBroaden = Date.now() - startedAt
  if (merged.length < tierConfig.feedSignalTarget && elapsedBeforeBroaden > WALL_CLOCK_BUDGET_MS) {
    console.log('[scan-now] skipping broaden pass for', userId, '- already', Math.round(elapsedBeforeBroaden / 1000) + 's into the run')
  } else if (merged.length < tierConfig.feedSignalTarget) {
    await setStatus(userId, { status: 'running', stage: 'broadening', startedAt })
    try {
      const broadenText = await callAnthropic(anthropicKey, buildScanPrompt(ob, [], { broaden: true, learned }), { maxUses: tierConfig.anthropicBroadenMaxUses, maxTokens: tierConfig.anthropicMaxTokens, supabase, userId, anthropicCaps: resourceCaps.anthropicTokens })
      const { learned: broadenLearned, rest: broadenFound } = splitLearnedEntries(extractJson(broadenText))
      learnedEntries.push(...broadenLearned)
      broadened = true
      if (!broadenFound.length) broadenPreview = (broadenText || '').trim().slice(0, 400)
      merged = mergeSignals([merged, broadenFound])
    } catch (err) {
      console.error('[scan-now] broaden pass failed for', userId, err.message)
      // Same gap as the sector-group catch above — this was the last chance
      // to explain a zero-signal first scan, and it was being thrown away
      // just as silently.
      await reportServerError('scan-now-background', err, { userId, stage: 'broaden-pass' })
      broadened = true
      broadenPreview = `broaden pass error: ${err.message}`
    }
  }

  // Merge in any pool hits that fell short of covering the full target on
  // their own (see the pool check above this function's group calls) — a
  // partial pool match is still a real, free bonus signal layered on top
  // of full discovery, never a reason to discover less. mergeSignals'
  // sourceUrl-based dedup means a company the fresh discovery also
  // independently re-found just collapses to one entry, not two.
  if (poolPersonalized.length) merged = mergeSignals([merged, poolPersonalized])

  // Enforce "replace, not supplement" deterministically in code, once, on
  // the final merged list — rather than trusting every individual AI call
  // (several parallel sector-group calls plus a possible broaden pass, none
  // of which see each other's output) to have each obeyed the prompt's
  // instruction not to double up.
  merged = dropGenericHiringWhereLiveJobsExist(merged)

  const capped = merged.slice(0, MAX_TOTAL_SIGNALS)
  if (merged.length > capped.length) {
    // No silent caps: if real, already-found signals are ever being dropped
    // here, that needs to be visible, not just quietly true.
    console.log(`[scan-now] truncated ${merged.length} genuine signals down to ${capped.length} for`, userId, '(MAX_TOTAL_SIGNALS cap)')
  }

  // Fire-and-forget on purpose (not awaited) — this is Annie's own research
  // memory growing for NEXT time, it has zero bearing on this customer's
  // signals or their first dashboard, so it should never be able to slow
  // this run down or fail it. recordLearnedDiscoveries already fails soft
  // internally (logs, never throws).
  if (learnedEntries.length) {
    recordLearnedDiscoveries(supabase, learnedEntries).catch(() => {})
  }

  return { groups, capped, broadened, broadenPreview, noAdzunaCoverage, poolContribution: poolPersonalized.length }
}

// Real, current progress for this account against its tier's targets —
// read straight from intelligence_signals rather than tracked as a running
// counter in memory, so it's correct across chained invocations regardless
// of dedup/merge details, and correct even if this is round 1 of a chain
// seeded by the upgrade webhook (see resolveCaller below) where no prior
// invocation's counts are available to hand forward. actionsEligible
// mirrors src/lib/todaysActions/eligibility.js's BD_ACTION_SIGNAL_TYPES and
// sourcedPool.js's contact gate — kept in sync by hand since one lives in
// the frontend bundle and one here; if that whitelist changes, update both.
async function checkTierProgress(supabase, userId) {
  const { data } = await supabase
    .from('intelligence_signals')
    .select('signal_type, contact_verified, contact_candidates')
    .eq('user_id', userId)
  const rows = data || []
  const actionsEligible = rows.filter(r =>
    ['leadership_change', 'live_job'].includes(r.signal_type) &&
    (r.contact_verified || (Array.isArray(r.contact_candidates) && r.contact_candidates.length > 0))
  ).length
  return { feedTotal: rows.length, actionsEligible }
}

// Dedupes the research phase's results against this customer's existing
// signals, enriches what's genuinely new, and writes it. Returns the rows
// actually written (may be empty) and any write error.
async function enrichAndWriteSignals(capped, ctx) {
  const { userId, apolloKey, companiesHouseKey, supabase, groups, broadened, locationHints, apolloContactRetry, apolloCaps, ob } = ctx

  // Dedupe against this customer's existing signals BEFORE spending Apollo
  // credits, not after. For a brand new account this set is normally empty,
  // but it's a cheap, free guard against a retried request or a second
  // concurrent trigger burning enrichment credits on a signal that would
  // just get discarded as a duplicate on write anyway.
  const { data: existingRows } = await supabase
    .from('intelligence_signals')
    .select('dedup_key')
    .eq('user_id', userId)
  const existingKeys = new Set((existingRows || []).map(r => r.dedup_key))

  // Row-building itself (enrichCompany → verifyContact per entry, plus
  // Companies House/source-URL checks) lives once in scanShared.js, shared
  // with intelligence-scan.js — see buildEnrichedSignalRows's own comment.
  const newEntries = capped.filter(s => s.company && s.headline && !existingKeys.has(normalizeKey(s.company, s.headline, s.sourceUrl)))
  // locationHints lets enrichCompany prefer an Apollo org whose country
  // matches this customer's monitored markets when the company name alone
  // is ambiguous (e.g. "Stitch") and Apollo has no single exact-name match
  // — see pickBestOrgMatch in scanShared.js for the full reasoning behind
  // why this exists (a real wrong-company match this fixes).
  const rows = await buildEnrichedSignalRows(newEntries, { userId, apolloKey, companiesHouseKey, supabase, logPrefix: '[scan-now]', locationHints, apolloContactRetry, apolloCaps })

  // 2026-08-27: write genuinely fresh discoveries through to the shared
  // cross-customer pool (see writeToSignalPool's own header in
  // scanShared.js) so the NEXT customer with an overlapping profile can
  // benefit from this exact scan — never re-writes an entry that itself
  // came from the pool (fromPool), since that's already there and
  // re-discovering nothing new about it. Best-effort by design (fails soft
  // internally) — a pool write hiccup should never affect this customer's
  // own scan succeeding.
  const freshDiscoveries = newEntries.filter(s => !s.fromPool)
  if (freshDiscoveries.length) await writeToSignalPool(supabase, freshDiscoveries, ob)

  // The exact bug that made a live customer's first scan report success
  // with zero signals actually written: the upsert's own `error` was never
  // checked. Checking it here doesn't prevent a schema drifting out from
  // under the code again, but it means that failure is now visibly logged
  // instead of indistinguishable from a genuinely quiet scan.
  let writeError = null
  if (rows.length) {
    const { error } = await supabase.from('intelligence_signals').upsert(rows, { onConflict: 'user_id,dedup_key', ignoreDuplicates: true })
    if (error) {
      writeError = error
      console.error(`[scan-now] upsert FAILED for`, userId, '-', error.message)
      await reportServerError('scan-now-background', new Error(error.message), { userId, stage: 'signal-upsert', attemptedRows: rows.length })
    } else {
      console.log(`[scan-now] wrote ${rows.length} signals for`, userId, '| groups:', groups.length, '| broadened:', broadened)
    }
  }
  return { rows, writeError }
}

// Two ways this function can legitimately be invoked: (a) a real customer's
// own browser session (onboarding's "Launch Annie", Settings' "Run a new
// scan") — verified the normal way, via their own Supabase session token,
// never trusting a user id from the request body; (b) an internal
// continuation of a chain already in progress — a fresh invocation firing
// itself for round 2+ (see the chaining comment near the top of this file),
// or a chain freshly seeded by stripe-webhook.js on a tier upgrade, where
// there is no live customer session to present at all. (b) is verified by a
// shared secret header instead, and DOES trust the userId in the body,
// since nothing about that path is customer-supplied — it's this same
// codebase calling itself, or another server-side function calling it.
async function resolveCaller(req, body, supabaseUrl, anonKey) {
  const internalSecret = req.headers.get('x-internal-scan-secret')
  if (INTERNAL_SCAN_SECRET && internalSecret && internalSecret === INTERNAL_SCAN_SECRET && body?.userId) {
    return { userId: body.userId, internal: true }
  }
  const { user, error } = await getAuthedUser(req, supabaseUrl, anonKey)
  if (error) return { userId: null, internal: false, error }
  return { userId: user.id, internal: false }
}

// Fire-and-forget continuation to the next round — deliberately not
// awaited, this invocation's own job ends the moment it kicks this off. See
// resolveCaller above for why this is auth'd by shared secret rather than a
// user token, and the chaining comment near MAX_SECTOR_GROUPS for why a new
// invocation (not a loop inside this one) is what keeps this safe against
// Netlify's per-invocation execution limit.
function fireNextRound(userId, round, chainStartedAt) {
  // 2026-08-26 audit fix: every OTHER failure path in this file explicitly
  // calls reportServerError specifically because a bare console.error
  // "vanish[es] into Netlify's own ephemeral function logs with nothing
  // persisted" (this file's own words, on the sector-group/broaden-pass/
  // cooldown-write failures above) — this chaining path was the one
  // exception. If INTERNAL_SCAN_SECRET goes missing or out of sync
  // (rotated in Netlify without a redeploy, a typo), every Growth/Team
  // scan would silently stop chaining after round 1 for every customer,
  // permanently, with nothing anywhere pointing at the actual cause until
  // scan-status.js's own timeout eventually flips the status to
  // 'timed_out' — a customer-visible symptom with no matching root-cause
  // signal anywhere. Reported here now, same as every other failure mode
  // this file already treats as worth paging over.
  if (!INTERNAL_SCAN_SECRET) {
    const msg = `INTERNAL_SCAN_SECRET not configured — cannot chain to round ${round} for ${userId} (this account will stop short of its tier target)`
    console.error('[scan-now]', msg)
    reportServerError('scan-now-background', new Error(msg), { userId, stage: 'chain-fire', round }).catch(() => {})
    return
  }
  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL
  if (!baseUrl) {
    const msg = `no site URL available to chain to round ${round} for ${userId}`
    console.error('[scan-now]', msg)
    reportServerError('scan-now-background', new Error(msg), { userId, stage: 'chain-fire', round }).catch(() => {})
    return
  }

  // 2026-08-27 audit fix: found via a 19-scenario staged first-scan audit —
  // 4 Growth-tier scans fired within ~15s of each other (same kind of burst
  // a real marketing push or a few signups from the same company minutes
  // apart could cause) all froze forever at round 1 with zero signals, and
  // NOTHING was written to error_logs anywhere. Root cause: this call was
  // only ever guarded against the fetch() PROMISE rejecting (a DNS/network
  // failure) — it never checked the response it got back. Netlify's own
  // gateway rejecting the request under a concurrent-invocation burst
  // (a 429/503) resolves fetch() normally rather than throwing, so that
  // failure mode was completely invisible: the chain just silently stopped,
  // and scan-status.js's own staleness check was the only thing that ever
  // surfaced it, many minutes later, with no root cause attached. One
  // immediate retry (still inside the same unawaited promise chain this
  // function already relies on completing post-return — no new timer,
  // nothing this runtime hasn't already proven it lets finish) covers the
  // realistic case: a momentary burst that's very likely gone by the retry.
  // A repeat failure now reports exactly like every other failure path in
  // this file, instead of vanishing.
  const attemptFire = () => fetch(`${baseUrl}/.netlify/functions/scan-now-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-scan-secret': INTERNAL_SCAN_SECRET },
    body: JSON.stringify({ userId, round, chainStartedAt }),
  })

  attemptFire().then(resp => {
    if (resp.ok) return
    const msg = `chain continuation for round ${round} got HTTP ${resp.status} for ${userId} — retrying once`
    console.error('[scan-now]', msg)
    return attemptFire().then(retryResp => {
      if (retryResp.ok) return
      const retryMsg = `chain continuation for round ${round} got HTTP ${retryResp.status} for ${userId} on retry — giving up (this account will stop short of its tier target)`
      console.error('[scan-now]', retryMsg)
      return reportServerError('scan-now-background', new Error(retryMsg), { userId, stage: 'chain-fire', round })
    })
  }).catch(err => {
    console.error('[scan-now] failed to fire round', round, 'for', userId, ':', err.message)
    reportServerError('scan-now-background', err, { userId, stage: 'chain-fire', round }).catch(() => {})
  })
}

// Exported solely so the retry/report behavior above can be unit tested
// directly against a mocked global.fetch — everything else in this file is
// tested through the handler (see this file's test header), but reaching
// fireNextRound that way would mean also mocking the entire research
// pipeline (Apollo/Adzuna/Anthropic), which is scanShared.js's own tested
// territory, not this file's.
export { fireNextRound }

export default async (req) => {
  if (req.method !== 'POST') return

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const apolloKey = process.env.APOLLO_API_KEY
  const companiesHouseKey = process.env.COMPANIES_HOUSE_API_KEY
  const adzunaAppId = process.env.ADZUNA_APP_ID
  const adzunaAppKey = process.env.ADZUNA_APP_KEY
  const theirStackApiKey = process.env.THEIRSTACK_API_KEY
  if (!supabaseUrl || !anonKey || !serviceKey || !anthropicKey) { console.error('[scan-now] not configured'); return }

  let body = null
  try { body = await req.json() } catch { /* fine — a real browser trigger sends no body at all */ }

  const { userId, internal, error: authError } = await resolveCaller(req, body, supabaseUrl, anonKey)
  if (!userId) {
    console.error('[scan-now] auth failed:', authError)
    // 2026-08-26 audit fix: a request that carried an internal-secret
    // header but still failed to resolve a caller means INTERNAL_SCAN_
    // SECRET itself is missing or out of sync (a mismatch, not a normal
    // unauthenticated browser hit) — the same silent chain-stopping risk
    // fireNextRound's own fix above addresses, just from the receiving
    // side instead of the firing side. An ordinary unauthenticated request
    // (no such header — a stray bot hit, a stale bookmark) stays console-
    // only on purpose, same as before; not every failed auth here is an
    // ops problem worth paging over.
    if (req.headers.get('x-internal-scan-secret')) {
      await reportServerError('scan-now-background', new Error(`internal chain continuation failed auth: ${authError}`), { userId: body?.userId, stage: 'chain-auth', round: body?.round })
    }
    return
  }
  const round = internal ? (Number(body?.round) || 1) : 1
  const chainStartedAt = internal && body?.chainStartedAt ? Number(body.chainStartedAt) : Date.now()

  // The scan's writes use the service role, same as the scheduled cron —
  // these are Annie's own findings, not user-authored data, and RLS on
  // intelligence_signals rightly doesn't grant customers insert access.
  //
  // 2026-08-24: the actual fix for this function's silent full-budget
  // stall — see createTimeoutFetch's header in scanShared.js. Every direct
  // API call here was already timeout-guarded; every Supabase call this
  // client makes (deep inside buildEnrichedSignalRows, several layers down)
  // was not, and a single hung one was enough to stall the whole run past
  // Netlify's hard kill with nothing ever written, not even an error.
  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: createTimeoutFetch() } })

  const startedAt = Date.now()
  // 2026-08-26 audit fix: this first status write of every round used to
  // stamp `startedAt` (this INVOCATION's own start), not `chainStartedAt`
  // (the whole chain's start — see scan-status.js's own comment on why
  // that distinction matters for its age-based timeout math). For round 1
  // the two are identical, so this was invisible there — but for round 2+
  // (a continuation potentially minutes into an already-running chain),
  // this briefly overwrote the correct chain-start timestamp with a later
  // one. If that invocation then died before its next status write (a
  // slow onboarding/entitlements lookup, a hard kill), the blob was left
  // stuck understating how long the chain had actually been running,
  // delaying scan-status.js's timeout past its intended ceiling. The local
  // `startedAt` variable itself stays — it's still correctly used below
  // for THIS invocation's own remaining-time budget (elapsedBeforeBroaden
  // etc.), a genuinely different measurement from the chain's total age.
  await setStatus(userId, { status: 'running', stage: 'starting', startedAt: chainStartedAt })

  try {
    // Guard against duplicate triggers (a retried request, a second tab)
    // kicking off an expensive scan twice in quick succession — real
    // customer triggers only (round 1, not internal). An internal chain
    // continuation (round 2+, or a chain freshly seeded by the Stripe
    // upgrade webhook) is never a duplicate of itself by definition, and
    // skipping this guard for it is what lets a chain actually finish
    // multiple rounds within its own account's cooldown window.
    if (!internal) {
      const { data: recentBatch } = await supabase
        .from('intelligence_signals')
        .select('id')
        .eq('user_id', userId)
        .gte('found_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
        .limit(1)
      if (recentBatch?.length) {
        console.log('[scan-now] recent signals already exist for', userId, 'skipping')
        await setStatus(userId, { status: 'done', reason: 'recent_signals_exist', signalsFound: recentBatch.length, startedAt: chainStartedAt, finishedAt: Date.now() })
        return
      }
    }

    const { data: ob } = await supabase
      .from('onboarding')
      .select('user_id, sectors, functions, locations, tone, firm_name, writing_style, initial_scan_triggered_at')
      .eq('user_id', userId)
      .single()
    if (!ob) {
      console.error('[scan-now] no onboarding row yet for', userId)
      await setStatus(userId, { status: 'done', reason: 'no_onboarding', signalsFound: 0, startedAt: chainStartedAt, finishedAt: Date.now() })
      return
    }

    // Persistent guard, on top of the 10-minute recentBatch check above: that
    // check only catches a duplicate trigger arriving within a few minutes
    // (a double-click, a second tab). This one closes the gap the audit
    // flagged — a valid session token replayed indefinitely could otherwise
    // re-run this expensive, over-resourced pass back-to-back for the same
    // customer. Set BEFORE the expensive work starts, not after, so a second
    // concurrent request can't slip through the same window.
    //
    // Was a one-time-ever flag (the column name is a holdover from that).
    // That made sense while the only caller was the onboarding "Launch
    // Annie" button, but it meant a customer whose first scan came back
    // empty — for any reason, including the silent AI-call failures fixed
    // alongside this change — had no way to ever ask Annie to try again
    // short of a developer resetting a column by hand. Settings' "Run a new
    // scan" button is a second, legitimate caller now, so this is a cooldown
    // instead: still blocks rapid re-fires, but doesn't lock a customer out
    // permanently. Tune RESCAN_COOLDOWN_MS if this cadence is wrong for your
    // Anthropic/Apollo budget.
    if (!internal && ob.initial_scan_triggered_at) {
      const sinceLast = Date.now() - new Date(ob.initial_scan_triggered_at).getTime()
      if (sinceLast < RESCAN_COOLDOWN_MS) {
        console.log('[scan-now] scan ran too recently for', userId, 'at', ob.initial_scan_triggered_at, '- skipping')
        await setStatus(userId, {
          status: 'done',
          reason: 'cooldown',
          retryAfter: new Date(new Date(ob.initial_scan_triggered_at).getTime() + RESCAN_COOLDOWN_MS).toISOString(),
          signalsFound: 0,
          // 2nd-pass audit fix: every other status write in this file uses
          // chainStartedAt (this only ran on !internal round-1 calls, where
          // the two happen to be numerically identical today since nothing
          // awaits between them — but that's a coincidence of the current
          // call order, not a guarantee, and every other write already
          // treats chainStartedAt as the source of truth).
          startedAt: chainStartedAt,
          finishedAt: Date.now(),
        })
        return
      }
    }
    // 2026-08-24 Task 5: this write's own result was never checked — a
    // silent failure here (RLS hiccup, transient DB error) would mean the
    // cooldown guard the comment above describes never actually persists,
    // and the exact replay/re-fire scenario it exists to close stays open
    // with nothing logging that it happened. Same bug class as the
    // signal-upsert fix below (line ~370) and the intelligence-scan.js /
    // stripe-webhook.js fixes earlier in this audit — logged, not thrown,
    // since a failed cooldown write shouldn't abort an otherwise-successful
    // scan already in flight.
    if (!internal) {
      const { error: cooldownError } = await supabase.from('onboarding').update({ initial_scan_triggered_at: new Date().toISOString() }).eq('user_id', userId)
      if (cooldownError) {
        console.error('[scan-now] failed to persist scan cooldown for', userId, ':', cooldownError.message)
        await reportServerError('scan-now-background', new Error(cooldownError.message), { userId, stage: 'cooldown-write' })
      }
    }

    // Tier resolution (2026-08-25): what this account gets — feed/actions
    // targets, chain ceiling, per-call search budget, Apollo retry depth —
    // is entirely driven from here on. See SCAN_TIER_CONFIG in
    // entitlements.js for the actual numbers and the reasoning behind them.
    const { tier } = await getEntitlements(supabase, userId)
    const tierConfig = SCAN_TIER_CONFIG[tier] || SCAN_TIER_CONFIG.starter
    // Resolved once per chain (not once per round — tier doesn't change
    // mid-chain) — see resolveResourceCaps's own header in entitlements.js.
    const resourceCaps = resolveResourceCaps(tier)

    // Phase-tagged status from here on (2026-08-24): if this function ever
    // stalls again, `stage` on the status blob says exactly which phase it
    // was last known to be in, instead of the investigation having to infer
    // it after the fact from what did or didn't get written. See
    // createTimeoutFetch and WALL_CLOCK_BUDGET_MS above for the actual fix
    // — this is purely visibility, not a second line of defense on its own.
    await setStatus(userId, { status: 'running', stage: 'researching', round, tier, startedAt: chainStartedAt })

    // Round 1 is the existing parallel-sector-groups-plus-broaden pass,
    // unchanged in shape (just tier-aware budgets now). Round 2+ is one
    // additional, wider-net call per round — see runAdditionalRound's own
    // header for why it's deliberately cheaper than repeating round 1's
    // full parallel sweep every time.
    let groups, capped, broadened, broadenPreview, noAdzunaCoverage, poolContribution
    if (round === 1) {
      ;({ groups, capped, broadened, broadenPreview, noAdzunaCoverage, poolContribution } = await runResearchPhase(ob, tierConfig, {
        userId, anthropicKey, apolloKey, adzunaAppId, adzunaAppKey, theirStackApiKey, supabase, startedAt, resourceCaps,
      }))
    } else {
      const { data: existingRows } = await supabase.from('intelligence_signals').select('company_name').eq('user_id', userId)
      const recentNames = [...new Set((existingRows || []).map(r => r.company_name).filter(Boolean))].slice(0, 60)
      const learned = await getLearnedSources(supabase, ob.sectors, ob.locations)
      const { found, learnedFound, rawText } = await runAdditionalRound(ob, tierConfig, recentNames, round, learned, userId, supabase, resourceCaps)
      if (learnedFound.length) recordLearnedDiscoveries(supabase, learnedFound).catch(() => {})
      groups = [ob.sectors || []]
      capped = dropGenericHiringWhereLiveJobsExist(found).slice(0, MAX_TOTAL_SIGNALS)
      broadened = true
      broadenPreview = capped.length ? null : (rawText || '').trim().slice(0, 400)
      noAdzunaCoverage = mapLocationsToAdzunaCountries(ob.locations).length === 0
      // Pool check only runs on round 1 (see runResearchPhase) — by round 2+
      // the account already has real coverage from round 1 and is chasing
      // gaps, a narrower case where a fresh pool re-check is low value
      // relative to the added complexity; scoped out deliberately.
      poolContribution = 0
    }

    if (!capped.length) {
      const truncated = round > 1 && looksTruncatedByTokenLimit(broadenPreview)
      console.log('[scan-now] round', round, 'found nothing new for', userId, '| sectors scanned:', groups.map(g => g?.join('/') || 'general').join(' | '), '| broadened:', broadened, '| noAdzunaCoverage:', noAdzunaCoverage, truncated ? '| LIKELY TRUNCATED BY max_tokens' : '', '| preview:', broadenPreview || '(n/a)')
    } else {
      await setStatus(userId, { status: 'running', stage: 'enriching', round, tier, startedAt: chainStartedAt })
    }

    // Dedupe against existing signals, enrich what's genuinely new, write
    // it — see enrichAndWriteSignals's own comment. Safe to call even when
    // capped is empty (newEntries just resolves to []).
    const { rows, writeError } = await enrichAndWriteSignals(capped, {
      userId, apolloKey, companiesHouseKey, supabase, groups, broadened, locationHints: ob.locations || [], apolloContactRetry: tierConfig.apolloContactRetry, apolloCaps: resourceCaps.apollo, ob,
    })

    // 2026-08-27: log this round's scan attempt regardless of outcome — see
    // getMarketCoverageReport's own header in scanShared.js for why the
    // zero-result rounds matter as much as the successful ones to a real,
    // ongoing picture of which markets are actually thin.
    if (!writeError) await logMarketCoverage(supabase, ob, rows.length)

    // Real, current progress against this account's tier targets — see
    // checkTierProgress's own header for why this is a fresh DB read rather
    // than a running in-memory count.
    const progress = writeError ? null : await checkTierProgress(supabase, userId)
    const targetHit = progress && progress.feedTotal >= tierConfig.feedSignalTarget && progress.actionsEligible >= tierConfig.actionsEligibleTarget
    const elapsedSinceChainStart = Date.now() - chainStartedAt
    const underCeiling = round < tierConfig.maxRounds && elapsedSinceChainStart < tierConfig.maxWallClockMs
    const shouldChain = !writeError && !targetHit && underCeiling

    if (shouldChain) {
      await setStatus(userId, {
        status: 'running',
        stage: 'chaining',
        round,
        tier,
        signalsFound: progress.feedTotal,
        actionsEligible: progress.actionsEligible,
        feedSignalTarget: tierConfig.feedSignalTarget,
        actionsEligibleTarget: tierConfig.actionsEligibleTarget,
        startedAt: chainStartedAt,
      })
      fireNextRound(userId, round + 1, chainStartedAt)
      return
    }

    // Stopping here — either the target was genuinely hit, or the ceiling
    // (rounds or wall clock) was reached first. Both are legitimate,
    // reportable outcomes — the honest-degrade case (ceiling hit, still
    // short) gets its own reason so the dashboard can say so plainly
    // ("still building your first week of intelligence") instead of
    // implying the account is simply done and fully populated when it
    // isn't. Never padded to hit a number — see buildScanPrompt's own
    // "never invent, always cite a real source" instruction, confirmed with
    // Michael (2026-08-25) as the one rule this chaining work must not
    // compromise for any tier.
    const reason = writeError ? 'error'
      : targetHit ? 'ok'
      : progress && progress.feedTotal > 0 ? 'partial_ceiling'
      : 'no_results'

    await setStatus(userId, {
      status: 'done',
      reason,
      errorMessage: writeError?.message,
      round,
      tier,
      signalsFound: progress?.feedTotal ?? rows.length,
      actionsEligible: progress?.actionsEligible ?? 0,
      feedSignalTarget: tierConfig.feedSignalTarget,
      actionsEligibleTarget: tierConfig.actionsEligibleTarget,
      startedAt: chainStartedAt,
      finishedAt: Date.now(),
      sectorsScanned: ob.sectors || [],
      groupsRun: groups.length,
      broadened,
      // 2026-08-27: purely observational, for measuring the cross-customer
      // signal pool's real-world impact — how many of this round's signals
      // came from another customer's overlapping-profile scan rather than
      // fresh discovery. 0 on every round after round 1 (see the pool-check
      // scoping note above) and 0 whenever no pool hit matched, same as
      // today for any account with no overlap yet.
      poolContribution: poolContribution || 0,
    })
  } catch (err) {
    console.error('[scan-now] failed for', userId, err.message)
    await reportServerError('scan-now-background', err, { userId })
    await setStatus(userId, { status: 'done', reason: 'error', errorMessage: err.message, signalsFound: 0, startedAt: chainStartedAt, finishedAt: Date.now() })
  }
}

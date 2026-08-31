// 2026-08-31 audit fix, item 1 — "the big one": Ask Annie's system prompt
// (Chat.jsx) has never contained a single row of this recruiter's own CRM.
// Not candidates, not jobs, not contacts, not companies, not signals. She's
// a general BD assistant with conversation memory bolted on, answering
// "How many candidates do I have in my pipeline right now?" with "I do not
// have that information" when the real answer (18, 16 active) is sitting in
// a table one query away — and, worse, blaming the recruiter for not
// providing it ("you haven't given me the fee structure") when asked which
// open job has the biggest fee. "Tell me about Aldermere Partners" failed
// the same way even though Aldermere was the #1 item on that recruiter's
// own Today's Actions the same day.
//
// Scope decision: this gives Annie a compact, capped SUMMARY — pipeline
// counts, every job's title/status/fee, and the most recent live signals —
// not full row-level access to every table (every contact, every note,
// every deal). That's a deliberate line, not a shortcut: chat.js's own
// header comment states plainly "chat.js never reads or writes any
// customer's own CRM tables" — true "ask me anything about any record"
// coverage needs Annie to be able to query on demand (tool-calling), which
// is real, separate follow-on work, not a system-prompt change. This much
// closes the three specific gaps Michael's own test caught (a pipeline
// count, a job fee comparison, "tell me about this company") without that
// larger lift, and without meaningfully growing the prompt Anthropic has to
// read on every message — the loaded latency investigation (chat.js/
// Chat.jsx, see their own 2026-08-31 comments) found Ask Annie's real
// bottleneck is a structural double round-trip on the streaming path, not
// prompt size, but a hint this size (roughly a few hundred tokens at most,
// even for a well-populated account) still isn't free, hence the caps below.
//
// Loaded ONCE per Chat.jsx page visit (same pattern as loadOnboarding/
// loadWatchlist there), not refetched on every message — so this adds
// exactly one extra set of Supabase round trips per chat SESSION, run
// concurrently with those two existing loads, not one per message. It can
// go stale within a long-running session if the recruiter edits their CRM
// mid-conversation without reloading the page — same known, accepted
// tradeoff onboarding/watchlist already make here, not a new one.
import { supabase } from './supabase'
import { resolveMarketCurrencyCode, DEFAULT_CURRENCY_CODE } from './marketCurrency'
import { currencySymbol } from './invoiceCalc'

const JOBS_LIMIT = 60
const SIGNALS_LIMIT = 15
const CLOSED_CANDIDATE_STATUSES = ['placed', 'rejected', 'withdrawn']
const HOT_CANDIDATE_STATUSES = ['interviewing', 'offer']

export async function loadChatCrmSnapshot(userId) {
  try {
    const [{ data: candidateRows, error: candErr }, { data: jobRows, error: jobErr }, { data: signalRows, error: sigErr }, { data: onboardingRow }] = await Promise.all([
      supabase.from('candidates').select('status'),
      supabase.from('jobs').select('title, status, fee_value, companies(name)').order('created_at', { ascending: false }).limit(JOBS_LIMIT),
      supabase.from('intelligence_signals').select('company_name, headline, signal_type, why_it_matters').eq('user_id', userId).neq('status', 'actioned').order('found_at', { ascending: false }).limit(SIGNALS_LIMIT),
      supabase.from('onboarding').select('locations').eq('user_id', userId).single(),
    ])
    if (candErr) console.error('[chatCrmSnapshot] failed to read candidates:', candErr.message)
    if (jobErr) console.error('[chatCrmSnapshot] failed to read jobs:', jobErr.message)
    if (sigErr) console.error('[chatCrmSnapshot] failed to read signals:', sigErr.message)

    const candidates = candidateRows || []
    const active = candidates.filter(c => !CLOSED_CANDIDATE_STATUSES.includes(c.status))
    const hot = candidates.filter(c => HOT_CANDIDATE_STATUSES.includes(c.status))

    const currencyPrefix = (() => {
      const symbol = currencySymbol(resolveMarketCurrencyCode(onboardingRow?.locations) || DEFAULT_CURRENCY_CODE)
      return symbol.length > 1 ? `${symbol} ` : symbol
    })()

    return {
      candidateStats: { total: candidates.length, active: active.length, hot: hot.length },
      jobs: jobRows || [],
      signals: signalRows || [],
      currencyPrefix,
    }
  } catch (err) {
    console.error('[chatCrmSnapshot] failed to load CRM snapshot:', err.message)
    return null
  }
}

// Same composition idea as buildWatchlistChatHint in watchlist.js — additive,
// short, one more paragraph in Chat.jsx's system prompt, never a replacement
// for the sectors/functions/markets/watchlist context already there.
export function buildCrmSnapshotChatHint(snapshot) {
  if (!snapshot) return ''
  const { candidateStats, jobs, signals, currencyPrefix } = snapshot
  const parts = []

  parts.push(`Candidate pipeline: ${candidateStats.total} candidates on file, ${candidateStats.active} active (not placed/rejected/withdrawn), ${candidateStats.hot} at interviewing or offer stage.`)

  if (jobs.length) {
    const jobLines = jobs.map(j => {
      const company = j.companies?.name ? ` at ${j.companies.name}` : ''
      const fee = j.fee_value ? `, fee ${currencyPrefix}${Number(j.fee_value).toLocaleString()}` : ', fee not set'
      return `- ${j.title}${company} — ${j.status}${fee}`
    })
    parts.push(`Jobs/mandates on file (${jobs.length}):\n${jobLines.join('\n')}`)
  } else {
    parts.push('No jobs/mandates on file yet.')
  }

  if (signals.length) {
    const signalLines = signals.map(s => `- ${s.company_name || 'Unknown company'} (${s.signal_type}): ${s.headline || 'no headline'}${s.why_it_matters ? ` — ${s.why_it_matters}` : ''}`)
    parts.push(`Recent BD intelligence Annie has already surfaced for this recruiter, most recent first (${signals.length}):\n${signalLines.join('\n')}`)
  }

  return `\nThis recruiter's live CRM, as of when this conversation loaded (tell them to check the app itself for anything that may have changed since — never state a borderline number as certain):\n${parts.join('\n\n')}\n`
}

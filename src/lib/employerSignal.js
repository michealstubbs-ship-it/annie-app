// What customers park, turned into a weight on employers. Companies only.
//
// THE RULE, Michael 2026-09-05: "share the fact about the ORGANISATION, never
// the record about the PERSON." That Sarah Mansour at Aldar was parked by this
// recruiter on Tuesday is that recruiter's own data and never leaves their
// tenant. That four recruiters on the same desk have parked every lead they
// were ever shown at some employer and none of them ever worked one is a fact
// about that employer — market knowledge, the same class of thing as its
// domain or its industry, both of which company_enrichment has shared across
// customers since long before any of this.
//
// WHERE THE EVIDENCE COMES FROM. signal_outcomes has logged what a recruiter
// actually does with a lead since 21 Aug 2026 and, until this file, nothing
// read it back — its own header said so. This is the read. It runs over the
// customer's OWN outcome rows, in their own browser, and the only thing that
// leaves is a company key, a desk slug and one of two words.
//
// THIS MODULE IS PURE on purpose, like backlogRanking.js: no Supabase, no
// network, so the rule can be reasoned about and tested directly. The I/O
// lives in data/parkedEmployers.js and the schema in
// supabase/migrations/20260905170000_parked_employer_signal.sql.
import { normalizeCompanyName } from './companyMatch'
import { isPlaceholderCompany } from './backlogRanking'

// Four distinct customers, and below it this does nothing whatsoever.
//
// Three was rejected twice over. Statistically, with three voters one tenant
// is a third of the verdict and two customers who happen to share a taste look
// like a consensus. Privately, the same number is the k in the k-anonymity
// argument: the reader returns nothing below it, so no aggregate can ever be
// traced back to a single customer's behaviour. Four is the smallest number
// that survives both readings.
//
// The countervailing pressure is real and worth writing down rather than
// pretending away: at Annie's customer count this will fire rarely, and on
// most companies it will never fire at all. That is the correct direction to
// fail in. A weight that fires seldom and correctly beats one that fires often
// on the strength of two people's Tuesday.
//
// MUST MATCH the `having count(*) >= 4` in parked_employer_signal(). The SQL
// is the enforcement; this constant is so the client agrees with it.
export const MIN_DISTINCT_CUSTOMERS = 4

// The most this can ever take off a lead's score.
//
// The number is not arbitrary. In scoreStreamItem the way-in ladder is worth
// 0 / 12 / 25 / 40 — the smallest gap between two rungs is 12. A cap of 10
// therefore CANNOT move a lead below one on a weaker rung: a company four
// recruiters unanimously gave up on, but where you know somebody, still
// outranks a stranger's company nobody has an opinion about. That is what
// "a weight, not a ban" has to mean in arithmetic rather than in prose.
export const MAX_EMPLOYER_PENALTY = 10

// Below this share of parkers the weight is zero. At exactly half, as many
// customers found business there as gave up on it, and the honest reading of
// that is "recruiters disagree", not "bad employer".
export const NEUTRAL_PARK_SHARE = 0.5

// Votes age out after six months, in the reader (see the migration). Applied
// here too so a customer contributes the same window they are read against.
// Companies change — new leadership, new funding, a hiring freeze that ended —
// and an employer nobody could place into last year deserves a clean hearing
// this year rather than a permanent record.
export const PARK_DECAY_DAYS = 180

// signal_outcomes.stage values that mean the recruiter got something out of
// this employer. 'placed' comes from Candidates.jsx, 'worked' from the stream's
// own done action.
const WORKED_STAGES = new Set(['worked', 'placed'])

// And the one that means they set the company aside. Deliberately NOT
// 'dismissed': dismiss removes a card as "this is not a lead" and is already
// learned from, as a judgment about the SIGNAL, by signal_pool.dismiss_count
// (2026-08-27-signal-pool-quality-feedback.sql). Park is the judgment about
// the EMPLOYER — "not this company, not now" — which is the thing Michael
// actually named. Counting a dismiss here would feed one click into two
// different learners and let a bad source look like a bad company.
const PARKED_STAGES = new Set(['parked'])

/**
 * The pooled key for a company name, or null if this is not a company.
 *
 * Rejects placeholders for the same reason the stream does (FEED-1, Michael:
 * "Confidential is not a company"). Without this, "confidential" would become
 * the single most-parked employer in the pool within a week, and would then
 * apply a penalty to every genuine lead whose company name happened to
 * normalise to the same string.
 */
export function employerKey(companyName) {
  if (isPlaceholderCompany(companyName)) return null
  const key = normalizeCompanyName(companyName)
  // The shape the table's CHECK constraint enforces. A key that would be
  // rejected by the database is not sent to it.
  if (!/^[a-z0-9 ]{2,80}$/.test(key)) return null
  return key
}

/**
 * The desk slug for one function area, or null.
 *
 * The vocabulary is the onboarding function taxonomy, not a new list — this
 * codebase has had to fix a silently-diverging second implementation of a
 * shared vocabulary three times, and inventing a fourth taxonomy for desks
 * would have been the fourth. Whatever the recruiter chose at signup is what
 * gets slugged.
 */
export function deskKey(functionLabel) {
  const slug = String(functionLabel || '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return /^[a-z0-9-]{2,40}$/.test(slug) ? slug : null
}

/**
 * Every desk this customer works, as slugs.
 *
 * A recruiter who told Annie they cover Finance and Technology genuinely has
 * an opinion on both desks and is genuinely served by both desks' opinions, so
 * the read matches on the whole set. It does not widen their vote: the primary
 * key still allows them exactly one row per company, whatever they cover.
 *
 * Empty in, empty out, and the caller must then do nothing at all. A customer
 * who chose no functions has no desk, and a vote with no desk would be pooled
 * across every desk in the product — which is precisely how this feature would
 * make Annie narrower for everyone rather than sharper for anyone.
 */
export function deskKeys(functions = []) {
  const out = []
  for (const f of functions || []) {
    const key = deskKey(f)
    if (key && !out.includes(key)) out.push(key)
  }
  return out
}

/**
 * This customer's own verdict on each employer, from their own outcome rows.
 *
 * rows: signal_outcomes as read under RLS — { company_name, stage, created_at }.
 *
 * Returns Map<companyKey, 'parked' | 'worked'>.
 *
 * THE BOUNDARY: the return value contains a normalised company name and one of
 * two literal words. No signal id, no contact, no date, no count of how many
 * times. Everything that crosses a tenant boundary crosses it through this
 * return type, and there is nothing else in it to leak.
 *
 * Worked beats parked, always, however many parks there were. A recruiter who
 * got business out of a company once has told you more about that company than
 * the same recruiter clearing five cards on a Friday afternoon, and the
 * asymmetry biases the whole pool against suppressing employers.
 */
export function ownEmployerVerdicts(rows = [], { now = new Date() } = {}) {
  const cutoff = now.getTime() - PARK_DECAY_DAYS * 86400000
  const verdicts = new Map()

  for (const row of rows || []) {
    const stage = String(row?.stage || '')
    const worked = WORKED_STAGES.has(stage)
    // 'seen' and 'dismissed' are neither, and are ignored rather than guessed
    // at — the same choice the signal-pool trigger made for the same reason.
    if (!worked && !PARKED_STAGES.has(stage)) continue

    // A missing created_at is treated as in-window: every row written before
    // this feature existed has one, so the only way to hit this is a column
    // that stopped being selected, and dropping the whole history over that
    // would be a silent, invisible failure.
    if (row?.created_at) {
      const at = Date.parse(row.created_at)
      if (Number.isFinite(at) && at < cutoff) continue
    }

    const key = employerKey(row?.company_name)
    if (!key) continue

    if (worked) verdicts.set(key, 'worked')
    else if (!verdicts.has(key)) verdicts.set(key, 'parked')
  }

  return verdicts
}

/**
 * How much to take off a lead's score, given the pooled verdict on its employer.
 *
 * agg: { parkedVoters, workedVoters } — DISTINCT CUSTOMERS, as returned by
 * parked_employer_signal(). Never counts of parks: one tenant with a huge CRM
 * is one opinion, the same way one customer's six hundred addresses are one
 * opinion about an email format.
 *
 * THE ANTI-NARROWING PROPERTY LIVES IN THIS FUNCTION, and it is the share, not
 * the count. The failure mode to design against is Annie getting NARROWER as
 * she gets more popular: if the penalty grew with the number of parks, then
 * every new customer would push every employer further down, the feed would
 * converge on a shrinking set of "good" companies, and every customer would
 * end up chasing the same shortlist as their competitors. Scoring the
 * PROPORTION of customers who gave up, against those who did not, is stable
 * under growth — ten thousand customers who split 60/40 produce exactly the
 * same weight as ten who do.
 *
 * The other three defences are elsewhere, because they belong elsewhere: the
 * desk filter and the 180-day window are in the SQL reader, and the cap is
 * MAX_EMPLOYER_PENALTY above, set below the smallest gap in the way-in ladder
 * so this can only ever reorder near-neighbours.
 */
export function employerPenalty(agg) {
  if (!agg) return 0
  const parked = Number(agg.parkedVoters) || 0
  const worked = Number(agg.workedVoters) || 0
  const voters = parked + worked
  if (voters < MIN_DISTINCT_CUSTOMERS) return 0

  const share = parked / voters
  if (share <= NEUTRAL_PARK_SHARE) return 0

  const ramp = (share - NEUTRAL_PARK_SHARE) / (1 - NEUTRAL_PARK_SHARE)
  // One decimal place. The score is a sort key, and a penalty carried to
  // fifteen digits would make two genuinely equal leads sort by float noise.
  return Math.round(MAX_EMPLOYER_PENALTY * ramp * 10) / 10
}

/**
 * What the pooled verdict means, in words, for anything that wants to show it.
 *
 * Returns null when the weight is doing nothing, so a caller can render
 * exactly when there is something true to say. Deliberately says how many
 * CUSTOMERS, never who and never how many leads — and never the word
 * "avoid", because nothing here is a ban.
 */
export function describeEmployerSignal(agg) {
  const penalty = employerPenalty(agg)
  if (!penalty) return null
  const parked = Number(agg.parkedVoters) || 0
  const worked = Number(agg.workedVoters) || 0
  const base = `${parked} recruiters on your desk have parked leads here`
  if (!worked) return `${base} and none has worked one`
  return worked === 1
    ? `${base}, one of them has worked a lead`
    : `${base}, ${worked} of them have worked a lead`
}

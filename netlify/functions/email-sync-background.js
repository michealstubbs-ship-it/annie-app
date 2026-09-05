// The mailbox backfill, and the catch-up sweep after it.
//
// TWO PATHS, AND THE DIFFERENCE BETWEEN THEM IS THE WHOLE POINT.
//
// 1. BACKFILL (backfill_done = false) — the 18-month sweep.
//    meta_only=true, limit=250, `after` pinned 18 months back, paged on the
//    cursor. No message bodies are fetched. No notes are written. No Anthropic
//    key is read, reserved or spent. It builds email_interactions — who wrote
//    to whom, how often, and between which dates — and then promotes only the
//    people the conversation went BOTH WAYS with. See mailboxSweep.js for the
//    rule and the evidence behind it.
//
//    This replaced a version that read 12 pages of 50 with full bodies and
//    called writeNote() on every matched message. Extended to 18 months that
//    design worked out at roughly ten thousand Anthropic calls per signup,
//    which is why it was rejected. Zero AI tokens on the backfill is not an
//    optimisation here, it is the reason the feature is affordable at all.
//
// 2. CATCH-UP (backfill_done = true) — unchanged, deliberately.
//    The forward path still reads bodies and still writes a note per message,
//    exactly as it did before this file was touched. New mail keeps getting its
//    note. Nothing about that behaviour moved.
//
// Sent is still read before inbox. Measured on a real recruiter mailbox
// (2026-09-05): 50 sent messages yielded 11 genuine work contacts; 50 received
// yielded zero, because an inbox is mostly LinkedIn digests, DMARC reports and
// bank statements. Under the two-way rule the order no longer changes the
// OUTCOME — promotion is decided only after both passes finish — but it still
// decides what a half-finished sweep has in it, and half a sent pass is worth
// more than half an inbox pass.
//
// Runs as a background function because a full backfill is minutes of paging,
// not seconds, and it must survive being slower than an HTTP timeout.
import { createClient } from '@supabase/supabase-js'
import { reportServerError } from './lib/reportError.js'
import { unipileConfig, listEmails } from './lib/unipile.js'
import { ingestBatch } from './lib/emailIngest.js'
import { ownIdentity } from './lib/emailSync.js'
import { reserveAnthropicTokens, reconcileAnthropicTokens, anthropicBilledTokens } from './lib/aiUsage.js'
import {
  SWEEP_PAGE_SIZE, sweepWindowStart, foldPage, readItems, readCursor,
} from './lib/mailboxSweep.js'
import { recordInteractions, runPromotions, sweepTotals } from './lib/mailboxSweepApply.js'

const PAGE = 50
const MAX_PAGES_PER_ROLE = 12          // ~600 messages each way, then stop
const WALL_CLOCK_MS = 11 * 60 * 1000   // leave headroom under the 15-minute cap

// Sweep phases, in order. 'promote' is not a mailbox role — it is the marker
// that both mailbox passes are finished, so a resumed run goes straight to the
// promotion queue instead of re-paging 200 requests of mail it already has.
const SWEEP_PHASES = ['sent', 'inbox', 'promote']

// A hard ceiling on requests per invocation, on top of the wall clock. At 250
// messages a page this is 500,000 messages, so it is a runaway guard rather
// than a real limit — the only way to reach it is a cursor that never ends.
const MAX_REQUESTS_PER_RUN = 2000

const nowIso = () => new Date().toISOString()

/**
 * The 18-month metadata sweep for one account, resumable.
 *
 * Everything needed to resume lives on email_accounts and is written after
 * EVERY page: the phase, the cursor, and the running counts. A 15-minute
 * background function that dies mid-mailbox therefore costs the pages it had
 * not yet read, and nothing else. `sweep_after` is pinned on the first run and
 * reused on every later one — recomputing "18 months ago" per invocation would
 * slide the window forward between runs and quietly leave a gap.
 */
async function runBackfill(admin, cfg, account, { deadlineAt }) {
  const identity = ownIdentity(account)
  const patchAccount = (patch) => admin.from('email_accounts').update(patch).eq('id', account.id)

  const after = account.sweep_after || sweepWindowStart(new Date())
  if (!account.sweep_after) {
    await patchAccount({ sweep_after: after, sweep_started_at: nowIso(), last_error: null })
  }

  let phase = SWEEP_PHASES.includes(account.sweep_role) ? account.sweep_role : SWEEP_PHASES[0]
  let cursor = account.backfill_cursor || null
  let pages = Number(account.sweep_pages || 0)
  let messages = Number(account.sweep_messages || 0)

  let requests = 0
  let progressed = false
  let listError = null

  for (let i = SWEEP_PHASES.indexOf(phase); i < SWEEP_PHASES.length; i++) {
    phase = SWEEP_PHASES[i]
    if (phase === 'promote') break

    // Cursor loop guard. Nobody has ever connected a real mailbox to this
    // product, so the paging contract is documented rather than observed: if
    // the provider ever hands back a cursor it has already given us, this ends
    // the pass cleanly instead of looping on the same 250 messages until the
    // function is killed.
    const seenCursors = new Set(cursor ? [cursor] : [])

    for (;;) {
      if (Date.now() > deadlineAt || requests >= MAX_REQUESTS_PER_RUN) {
        return { done: false, progressed, pages, messages, requests, phase, error: listError }
      }

      const listed = await listEmails(cfg, {
        accountId: account.unipile_account_id,
        role: phase,
        limit: SWEEP_PAGE_SIZE,
        metaOnly: true,
        after,
        cursor,
      })
      requests += 1

      if (!listed.ok) {
        // A 401 means the mailbox is no longer connected and no amount of
        // retrying fixes it. Anything else is transient: the cursor is already
        // persisted, so the next invocation picks up from the same page.
        listError = listed.error || 'list_failed'
        await patchAccount({
          last_error: listError,
          ...(listed.status === 401 ? { status: 'disconnected' } : {}),
        })
        return { done: false, progressed, pages, messages, requests, phase, error: listError }
      }

      const items = readItems(listed.data)
      pages += 1
      messages += items.length

      if (items.length) {
        const tallies = foldPage(items, identity)
        const recorded = await recordInteractions(admin, {
          userId: account.user_id,
          accountId: account.id,
          tallies,
        })
        if (recorded.error) {
          // The page was read but not stored. Do NOT advance the cursor: a
          // resumed run must re-read this page rather than skip the people in
          // it, and re-reading is safe because the stored counts are absolute.
          await patchAccount({ last_error: String(recorded.error.message || 'interaction_write_failed') })
          return { done: false, progressed, pages: pages - 1, messages: messages - items.length, requests, phase, error: 'interaction_write_failed' }
        }
      }

      progressed = true

      const next = readCursor(listed.data)
      cursor = next && !seenCursors.has(next) ? next : null
      if (next) seenCursors.add(next)

      await patchAccount({
        sweep_role: phase,
        backfill_cursor: cursor,
        sweep_pages: pages,
        sweep_messages: messages,
        last_error: null,
      })

      if (!cursor || !items.length) break
    }

    cursor = null
  }

  // --- both mailbox passes are in; now, and only now, decide who is a contact
  //
  // Promotion cannot run earlier. During the sent pass every counterparty looks
  // one-way by construction, because their replies are in the inbox pass that
  // has not happened yet. Deciding as we went would promote nobody.
  await patchAccount({ sweep_role: 'promote', backfill_cursor: null })

  const promotions = await runPromotions(admin, {
    userId: account.user_id,
    account,
    deadlineAt,
  })
  if (promotions.promoted || promotions.heldFreeMail || promotions.heldRole) progressed = true

  if (promotions.outOfTime) {
    return { done: false, progressed, pages, messages, requests, phase: 'promote', promotions }
  }

  const stats = await sweepTotals(admin, { accountId: account.id })

  await patchAccount({
    backfill_done: true,
    sweep_role: null,
    backfill_cursor: null,
    sweep_pages: pages,
    sweep_messages: messages,
    sweep_completed_at: nowIso(),
    last_synced_at: nowIso(),
    last_error: null,
    // Kept as one JSON column rather than a spread of counters because it is
    // read as a whole and never filtered on. freeMailTwoWay is the number the
    // free-mail carve-out exists to produce: how many people genuinely
    // correspond with this recruiter from a personal address and were
    // deliberately NOT filed. A real figure to decide against later, instead of
    // an argument about whether such people exist.
    sweep_stats: {
      ...stats,
      pages,
      messages,
      window_months: 18,
      after,
      promoted: promotions.promoted,
      created: promotions.created,
      matched_existing: promotions.matchedExisting,
      completed_at: nowIso(),
    },
  })

  return { done: true, progressed, pages, messages, requests, phase: 'done', promotions, stats }
}

export default async (req) => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return new Response('Not configured', { status: 503 })

  const cfg = unipileConfig()
  if (!cfg.configured) return new Response('Unipile not configured', { status: 503 })

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const started = Date.now()
  const deadlineAt = started + WALL_CLOCK_MS

  let body = {}
  try { body = await req.json() } catch { body = {} }

  const COLUMNS = 'id, user_id, email_address, unipile_account_id, status, backfill_done, backfill_cursor, sweep_role, sweep_after, sweep_pages, sweep_messages'

  // Either one named account (just connected, or resuming) or every account due
  // a catch-up.
  let accounts = []
  if (body.accountId) {
    const { data } = await admin.from('email_accounts')
      .select(COLUMNS)
      .eq('id', body.accountId).eq('status', 'connected').maybeSingle()
    if (data) accounts = [data]
  } else {
    const { data } = await admin.from('email_accounts')
      .select(COLUMNS)
      .eq('status', 'connected')
      .limit(50)
    accounts = data || []
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY || null
  const report = []
  const resume = []

  for (const account of accounts) {
    if (Date.now() > deadlineAt) break

    // --- path 1: the 18-month backfill ------------------------------------
    if (!account.backfill_done) {
      try {
        const result = await runBackfill(admin, cfg, account, { deadlineAt })
        report.push({
          account: account.email_address,
          mode: 'backfill',
          done: result.done,
          pages: result.pages,
          messages: result.messages,
          requests: result.requests,
          phase: result.phase,
          promotions: result.promotions
            ? {
                promoted: result.promotions.promoted,
                created: result.promotions.created,
                matchedExisting: result.promotions.matchedExisting,
                heldFreeMail: result.promotions.heldFreeMail,
                heldRole: result.promotions.heldRole,
              }
            : null,
          stats: result.stats || null,
          error: result.error || null,
        })

        // Resumption. A big mailbox is meant to complete ACROSS runs rather
        // than silently truncate at the wall clock, and nothing else in this
        // deployment schedules a follow-up. Re-invoked only when this run
        // actually made progress, so a persistent failure stops instead of
        // re-triggering itself forever.
        if (!result.done && result.progressed) resume.push(account.id)
      } catch (err) {
        await reportServerError('email-sync-background', err, { userId: account.user_id, mode: 'backfill' })
        await admin.from('email_accounts')
          .update({ last_error: String(err?.message || 'sweep_failed') })
          .eq('id', account.id)
        report.push({ account: account.email_address, mode: 'backfill', done: false, error: String(err?.message || 'sweep_failed') })
      }
      continue
    }

    // --- path 2: the catch-up sweep, unchanged ----------------------------
    // Everything below this line is the code that was here before the backfill
    // was rewritten, kept as it was on purpose. It reads bodies and writes a
    // note per message, which is correct for new mail and only ever runs for an
    // account whose 18-month backfill has already finished.
    const totals = {
      account: account.email_address, mode: 'catchup', read: 0, created: 0,
      matchedEmail: 0, matchedName: 0, heldPersonal: 0, heldRole: 0,
      skipped: 0, noted: 0, enriched: 0, autoReplies: 0, companies: new Set(),
    }

    try {
      for (const role of ['sent', 'inbox']) {
        let cursor = null
        for (let page = 0; page < MAX_PAGES_PER_ROLE; page++) {
          if (Date.now() - started > WALL_CLOCK_MS) break

          const listed = await listEmails(cfg, {
            accountId: account.unipile_account_id,
            role,
            limit: PAGE,
            cursor,
          })
          if (!listed.ok) {
            await admin.from('email_accounts')
              .update({ last_error: listed.error, status: listed.status === 401 ? 'disconnected' : 'connected' })
              .eq('id', account.id)
            break
          }

          const items = listed.data?.items || []
          if (!items.length) break

          const estimate = items.length * 500
          const reserved = anthropicKey
            ? await reserveAnthropicTokens(admin, account.user_id, estimate, null)
            : { ok: false }

          let actual = 0
          const summary = await ingestBatch(admin, {
            userId: account.user_id,
            account,
            messages: items,
            anthropicKey: reserved.ok ? anthropicKey : null,
            onUsage: (usage) => { actual += anthropicBilledTokens(usage) },
          })
          if (reserved.ok) await reconcileAnthropicTokens(admin, account.user_id, estimate, actual)

          for (const k of ['read', 'created', 'matchedEmail', 'matchedName', 'heldPersonal', 'heldRole', 'skipped', 'noted', 'enriched', 'autoReplies']) {
            totals[k] += summary[k] || 0
          }
          for (const c of summary.companies) totals.companies.add(c)

          cursor = listed.data?.cursor || null
          if (!cursor) break
        }
      }

      await admin.from('email_accounts').update({
        last_synced_at: new Date().toISOString(),
        last_error: null,
      }).eq('id', account.id)
    } catch (err) {
      await reportServerError('email-sync-background', err, { userId: account.user_id })
      await admin.from('email_accounts')
        .update({ last_error: String(err?.message || 'sync_failed') })
        .eq('id', account.id)
    }

    report.push({ ...totals, companies: [...totals.companies] })
  }

  // Fire-and-forget, exactly as email-webhook.js kicks off the first sweep: a
  // background function cannot await another background function without
  // inheriting its timeout.
  for (const accountId of resume) {
    const base = process.env.APP_URL || 'https://app.meetannie.ai'
    fetch(`${base}/api/email-sync-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, resume: true }),
    }).catch(() => { /* the cursor is stored; any later invocation resumes it */ })
  }

  return new Response(JSON.stringify({ accounts: report.length, resuming: resume.length, report }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

// Netlify: a custom path replaces the default /.netlify/functions/ alias,
// so this is the ONLY URL this function answers on.
export const config = { path: '/api/email-sync-background' }

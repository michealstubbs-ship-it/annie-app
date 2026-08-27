#!/usr/bin/env node
// Manual runbook for honoring a "delete my account" / "export my data" request
// (Settings.jsx's two buttons file a row in account_requests for a human to
// see, but nothing ever actually deletes or exports anything — this script is
// that missing action, for Michael or support to run by hand).
//
// Why a script and not an automated self-serve endpoint, and why hard-delete
// scoped to the TEAM rather than a single user: see the 2026-08-26 audit
// round that found this gap. Short version — at this stage (pre-launch, no
// real requests yet), a documented manual process fully satisfies what GDPR
// actually requires (erasure/portability handled within a reasonable window,
// not necessarily self-serve or instant), and it's reviewable before
// anything irreversible happens. Building a full automated flow now would be
// solving a problem that doesn't exist yet, at real cost. Teams are the
// data-owning unit everywhere else in this app (see entitlements.js's own
// header) — this script always operates on one whole team at a time,
// removing every member's account with it. If a request ever turns out to
// mean "remove just me from a shared team, not the team itself", that's a
// different, much smaller operation — team-remove-member.js already does
// exactly that — and is NOT what this script is for; check the dry-run
// output's member count before running --mode=delete so a multi-member team
// is never taken down by a request meant for one seat.
//
// GROUND TRUTH CHECKED DIRECTLY AGAINST PRODUCTION (2026-08-26, via
// pg_constraint/information_schema against the live database, not just
// migration file text — an earlier draft of this comment trusted a prior
// agent's read of the migration files, which turned out to be stale
// relative to what's actually live, and got this backwards; corrected after
// an independent adversarial review re-checked it directly against
// pg_constraint). Most public.* tables DO have a real FOREIGN KEY to
// auth.users(id) ON DELETE CASCADE (profiles, onboarding, contacts, deals,
// chat_messages, actions_cache, subscriptions, todays_action_state,
// account_requests, team_members, candidates, companies, jobs, meetings,
// bd_tasks, intelligence_signals, signal_outcomes) — one table,
// support_messages, is the real exception (NO ACTION). error_logs.user_id
// is ON DELETE SET NULL. None of that changes what this script does: it
// still deletes every table explicitly and in this specific order, on
// purpose — not to dodge a foreign-key violation that mostly wouldn't
// happen anyway, but so the dry-run counts stay accurate (an implicit
// cascade wouldn't show up in a row count taken beforehand), so
// support_messages (the one table that genuinely would be left behind by a
// bare deleteUser() call) is never missed, and so team_id -> teams (NO
// ACTION on every team-scoped table) never blocks deleting the teams row
// itself. auth.users is still removed last, after nothing references it —
// belt-and-suspenders is cheap here given what's at stake.
//
// Deliberately NOT touched: company_contacts / company_enrichment. Both are
// shared, Apollo/TheirStack-sourced caches keyed by company name, not by any
// user_id/team_id column — they hold already-public company/contact data
// referenced by every customer, not this team's own data, same reasoning
// already applied to the platform-wide resource caps elsewhere in this repo.
//
// --mode=delete also cancels any live Stripe subscription for the team
// BEFORE touching Supabase, when STRIPE_SECRET_KEY is set — deleting the
// subscriptions row alone would leave the real Stripe subscription active
// and the customer's card would keep being charged for an account that no
// longer exists.
//
// Usage:
//   node scripts/team-data-request.mjs --team-id=<uuid> --mode=dry-run   (default; no writes)
//   node scripts/team-data-request.mjs --team-id=<uuid> --mode=export --out=team-export.json
//   node scripts/team-data-request.mjs --team-id=<uuid> --mode=delete --confirm=<uuid>
//
// account_requests (what Settings.jsx's buttons actually write, and what the
// admin dashboard's get_account_requests() RPC lists) only records the
// REQUESTING user's id, not their team id — pass --user-id=<uuid> instead of
// --team-id and this script resolves it via team_members for you, and prints
// the resolved team id up front so you can double check it before anything
// else runs.
//
//   node scripts/team-data-request.mjs --user-id=<uuid> --mode=dry-run
//
// --confirm must repeat the exact same team id as --team-id (the RESOLVED
// team id, if you passed --user-id) — a deliberate "type it twice" guard
// against running --mode=delete against the wrong id by a copy-paste slip.
// delete mode always runs a fresh dry-run pass first and prints it before
// touching anything.
//
// Requires VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
// environment (same vars every Netlify function already reads) — this talks
// to Supabase with the service role, bypassing RLS by design, so run it only
// from a trusted machine, never commit real values, and treat the exported
// JSON file itself as containing real customer PII (delete it once sent).

import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import Stripe from 'stripe'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=')
    return [k, rest.join('=') || true]
  })
)

let teamId = args['team-id']
const requestingUserId = args['user-id']
const mode = args.mode || 'dry-run'

if (!teamId && !requestingUserId) {
  console.error('Usage: node scripts/team-data-request.mjs --team-id=<uuid>|--user-id=<uuid> [--mode=dry-run|export|delete] [--confirm=<uuid>] [--out=path.json]')
  process.exit(1)
}
if (!['dry-run', 'export', 'delete'].includes(mode)) {
  console.error(`Unknown --mode "${mode}" — must be dry-run, export, or delete.`)
  process.exit(1)
}

const supabaseUrl = process.env.VITE_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in the environment.')
  process.exit(1)
}
const supabase = createClient(supabaseUrl, serviceKey)

if (!teamId && requestingUserId) {
  const { data: membership, error } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', requestingUserId)
    .maybeSingle()
  if (error) {
    console.error(`Failed resolving --user-id=${requestingUserId} to a team: ${error.message}`)
    process.exit(1)
  }
  if (!membership) {
    console.error(`No team_members row found for user ${requestingUserId} — they may already be fully removed, or the id is wrong. Nothing to do.`)
    process.exit(1)
  }
  teamId = membership.team_id
  console.log(`Resolved --user-id=${requestingUserId} to team ${teamId}`)
}

const outPath = args.out || `team-export-${teamId}.json`

// Team-scoped tables, in an order that respects the FK relationships
// actually live in production today (checked directly, not assumed from
// migration files): leaf/child tables first, so nothing hits a NO ACTION
// block or an unwanted CASCADE surprise on a table we haven't gotten to yet.
const TEAM_SCOPED_TABLES = [
  'bd_tasks',
  'meetings',
  'deals',
  'intelligence_signals',
  'candidates',
  'jobs',
  'contacts',
  'companies',
  'todays_action_state',
  'subscriptions',
]

// User-scoped tables with no team_id column at all — collected per member of
// the team instead. signal_outcomes references intelligence_signals via
// SET NULL, so it's safe to remove independent of the intelligence_signals
// pass above; error_logs.user_id is nullable, included here for a full
// erasure rather than a partial anonymize (see the class comment above for
// why this script favors simple and complete over clever).
const USER_SCOPED_TABLES = [
  'signal_outcomes',
  'actions_cache',
  'chat_messages',
  'chat_rate_limit',
  'account_requests',
  'onboarding',
  'error_logs',
  'support_messages',
  'anthropic_usage',
  'apollo_usage',
  'theirstack_usage',
]

async function getTeamAndMembers() {
  const { data: team, error: teamErr } = await supabase.from('teams').select('*').eq('id', teamId).maybeSingle()
  if (teamErr) throw new Error(`Failed to look up team ${teamId}: ${teamErr.message}`)
  if (!team) throw new Error(`No team found with id ${teamId} — nothing to do.`)

  const { data: members, error: memErr } = await supabase.from('team_members').select('*').eq('team_id', teamId)
  if (memErr) throw new Error(`Failed to look up team_members for ${teamId}: ${memErr.message}`)

  const userIds = [...new Set((members || []).map((m) => m.user_id).filter(Boolean))]
  return { team, members: members || [], userIds }
}

async function countRows(table, column, value) {
  // Select the SAME column we're filtering by, not a hardcoded 'id' —
  // anthropic_usage/apollo_usage/theirstack_usage/chat_rate_limit have no
  // 'id' column at all (composite primary keys), and selecting one that
  // doesn't exist silently broke the dry-run count for exactly those 4
  // tables (found in adversarial review). The column being filtered on is
  // guaranteed to exist by construction (every call site passes 'team_id'
  // or 'user_id', both real columns on every table this is called with).
  const { count, error } = await supabase.from(table).select(column, { count: 'exact', head: true }).eq(column, value)
  if (error) {
    // Table may not have this exact column shape in every environment; surface
    // it loudly rather than silently reporting 0, since that's exactly the
    // kind of gap this whole exercise exists to avoid repeating.
    console.warn(`  ! could not count ${table}.${column}=${value}: ${error.message}`)
    return null
  }
  return count ?? 0
}

async function fetchRows(table, column, value) {
  // Paginated explicitly rather than one unbounded select('*') — PostgREST
  // caps an unpaginated read at the project's configured Max Rows (commonly
  // 1000), and a table for a long-lived, high-activity team (chat_messages,
  // intelligence_signals) could exceed that silently, which is exactly
  // wrong for a script whose export mode exists to fulfil a "give me all my
  // data" request. Loops until a page comes back short of PAGE_SIZE.
  const PAGE_SIZE = 500
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await supabase.from(table).select('*').eq(column, value).range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to read ${table} where ${column}=${value} (offset ${from}): ${error.message}`)
    rows.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}

async function dryRun() {
  const { team, members, userIds } = await getTeamAndMembers()
  console.log(`\nTeam: ${team.name || '(unnamed)'} (${teamId}), created ${team.created_at}`)
  // team_members rows can include pending, not-yet-accepted invites (a row
  // with no user_id yet) — members.length and userIds.length can legitimately
  // differ. Print both explicitly rather than one count next to the other
  // list, which read as a mismatch during adversarial review and is exactly
  // the line the README points at as the "check before deleting" safeguard.
  console.log(`Members: ${members.length} team_members row(s), ${userIds.length} with an active user account: ${userIds.join(', ') || '(none)'}`)
  if (members.length !== userIds.length) {
    console.log(`  (${members.length - userIds.length} pending/unaccepted invite(s) with no user account yet — not deleted from auth, only their team_members row)`)
  }
  console.log('\nRow counts that would be affected:')

  let totalRows = 0
  for (const table of TEAM_SCOPED_TABLES) {
    const n = await countRows(table, 'team_id', teamId)
    if (n) totalRows += n
    console.log(`  ${table} (team_id): ${n ?? 'ERROR'}`)
  }
  for (const table of USER_SCOPED_TABLES) {
    let tableTotal = 0
    for (const uid of userIds) {
      const n = await countRows(table, 'user_id', uid)
      if (n) tableTotal += n
    }
    totalRows += tableTotal
    console.log(`  ${table} (user_id, across ${userIds.length} member${userIds.length === 1 ? '' : 's'}): ${tableTotal}`)
  }
  // profiles.id IS the user id (no separate user_id column) — counted
  // separately since it doesn't fit the column-name pattern above.
  let profileCount = 0
  for (const uid of userIds) {
    const n = await countRows('profiles', 'id', uid)
    if (n) profileCount += n
  }
  totalRows += profileCount
  console.log(`  profiles (id, across ${userIds.length} member${userIds.length === 1 ? '' : 's'}): ${profileCount}`)
  console.log(`  team_members: ${members.length}`)
  console.log(`  teams: 1`)
  console.log(`  auth.users accounts: ${userIds.length}`)
  console.log(`\nTotal business-data rows affected (excluding team_members/teams/auth): ${totalRows}`)
  console.log('\nNOT touched (shared, cross-tenant caches): company_contacts, company_enrichment')
  return { team, members, userIds }
}

async function exportData() {
  const { team, members, userIds } = await getTeamAndMembers()
  const bundle = { exportedAt: new Date().toISOString(), team, members, byTable: {} }

  for (const table of TEAM_SCOPED_TABLES) {
    bundle.byTable[table] = await fetchRows(table, 'team_id', teamId)
  }
  for (const table of USER_SCOPED_TABLES) {
    const rows = []
    for (const uid of userIds) rows.push(...(await fetchRows(table, 'user_id', uid)))
    bundle.byTable[table] = rows
  }
  const profiles = []
  for (const uid of userIds) profiles.push(...(await fetchRows('profiles', 'id', uid)))
  bundle.byTable.profiles = profiles

  writeFileSync(outPath, JSON.stringify(bundle, null, 2))
  console.log(`\nWrote export to ${outPath} — this file contains real customer PII. Send it to the requester over a channel you'd trust with that, then delete the local copy.`)

  // 2026-08-27 audit fix: nothing else in this script (or anywhere in the
  // app) ever closes out the account_requests row Settings.jsx wrote when
  // the customer clicked "export my data" — Settings.jsx's own poll only
  // ever checks for status = 'pending', so without this the customer sees
  // their request as permanently pending even after it's actually been
  // fulfilled. Marked 'completed' for every member's pending export request
  // on this team; --mode=delete doesn't need this, it deletes the whole
  // account_requests row for each member as part of USER_SCOPED_TABLES.
  const { error: closeErr } = await supabase
    .from('account_requests')
    .update({ status: 'completed' })
    .in('user_id', userIds)
    .eq('request_type', 'export')
    .eq('status', 'pending')
  if (closeErr) console.error(`  ! export succeeded but failed to mark the request(s) completed: ${closeErr.message} — update account_requests.status by hand so the customer isn't shown "pending" forever.`)
  else console.log(`  marked matching pending export request(s) as completed for ${userIds.length} member(s)`)
}

async function deleteData() {
  const confirm = args.confirm
  if (confirm !== teamId) {
    console.error(`\n--mode=delete requires --confirm=<the same team id> to proceed (a deliberate "type it twice" guard).`)
    console.error(`  --team-id was: ${teamId}`)
    console.error(`  --confirm was: ${confirm || '(not provided)'}`)
    process.exit(1)
  }

  console.log('Running a dry-run pass first so you can see exactly what is about to happen...')
  const { userIds: preCheckUserIds } = await dryRun()

  // 2026-08-27 audit fix: the README already warns to check the member
  // count before running --mode=delete, but nothing in code actually
  // enforced it — a request meant for one seat, run against the wrong team
  // (or a team that grew since the request was filed), silently took every
  // member's account down with it. A second, explicit flag for anything
  // past one real account makes that mistake require a deliberate second
  // step instead of a single command.
  if (preCheckUserIds.length > 1 && args[`yes-delete-all-${preCheckUserIds.length}-members`] === undefined) {
    console.error(`\nABORTED — this team has ${preCheckUserIds.length} member accounts, not 1. --mode=delete removes every one of them.`)
    console.error(`If that's genuinely what this request means, re-run with the exact flag: --yes-delete-all-${preCheckUserIds.length}-members`)
    console.error(`If it means removing just one seat from a shared team instead, use team-remove-member.js, not this script.`)
    process.exit(1)
  }

  console.log('\nProceeding with deletion in 5 seconds — Ctrl+C now to abort.')
  await new Promise((r) => setTimeout(r, 5000))

  // Re-fetch membership fresh, AFTER the wait — found in adversarial review:
  // reusing the dry-run's snapshot from before the 5s window meant a member
  // added during that window kept their login (never in the stale list) with
  // their team_members row silently gone (deleted by the team_id-scoped pass
  // below), and a member removed during that window still had their real
  // account deleted here even though they'd already left the team being
  // erased. Team-scoped deletes below already read team_id fresh at
  // execution time regardless — this makes the per-member loops match that.
  const { members, userIds } = await getTeamAndMembers()

  // Stripe cancellation FIRST, before the subscriptions row (which holds
  // stripe_subscription_id) is deleted below — deleting the Supabase row
  // alone would leave the real Stripe subscription active and the
  // customer's card would keep being charged for an account that no longer
  // exists. STRIPE_SECRET_KEY is optional-in-general for this app (billing
  // degrades gracefully if unset, see .env.example), so this step only
  // runs when it's actually configured; if it's not, this is called out
  // explicitly so it isn't silently skipped.
  const stripeKey = process.env.STRIPE_SECRET_KEY
  if (stripeKey) {
    // Look up by team_id AND by each member's user_id, not team_id alone —
    // subscriptions.team_id is nullable with no NOT NULL/CHECK constraint,
    // so a row that ever ended up with team_id unset (not observed in
    // production today, but nothing stops it) would be invisible to a
    // team_id-only lookup and its billing would silently keep running
    // after the account is gone. Merged by id so a normal row (matching
    // both ways) isn't double-canceled.
    const byTeam = await supabase.from('subscriptions').select('id, stripe_subscription_id').eq('team_id', teamId)
    const subsById = new Map((byTeam.data || []).map((s) => [s.id, s]))
    for (const uid of userIds) {
      const byUser = await supabase.from('subscriptions').select('id, stripe_subscription_id').eq('user_id', uid)
      for (const s of byUser.data || []) subsById.set(s.id, s)
    }
    const subIds = [...subsById.values()].map((s) => s.stripe_subscription_id).filter(Boolean)
    if (subIds.length) {
      const stripe = new Stripe(stripeKey)
      console.log(`\nCanceling ${subIds.length} live Stripe subscription(s)...`)
      for (const subId of subIds) {
        try {
          // Check status first rather than just calling cancel() and
          // pattern-matching the error it throws — found in adversarial
          // review that Stripe's "already canceled" case returns an
          // invalid_request_error, not the resource_missing code an earlier
          // version of this script checked for, so a legitimate re-run
          // after a partial failure would have falsely aborted here.
          // resource_missing (genuinely wrong/deleted id) is still the one
          // real not-an-error case, checked below.
          const sub = await stripe.subscriptions.retrieve(subId)
          if (sub.status === 'canceled') {
            console.log(`  ${subId} already canceled in Stripe, nothing to do`)
          } else {
            await stripe.subscriptions.cancel(subId)
            console.log(`  canceled ${subId}`)
          }
        } catch (err) {
          if (err?.code === 'resource_missing') {
            console.log(`  ${subId} doesn't exist in Stripe, nothing to do`)
          } else {
            throw new Error(`ABORTED — failed canceling Stripe subscription ${subId}: ${err.message}. No Supabase rows deleted yet. Check this subscription in the Stripe dashboard before re-running.`)
          }
        }
      }
    } else {
      console.log('\nNo live Stripe subscription found for this team, nothing to cancel.')
    }
  } else {
    console.log('\nSTRIPE_SECRET_KEY not set — skipping Stripe cancellation. If this team has a real paid subscription, cancel it by hand in the Stripe dashboard before or after this run.')
  }

  console.log('\nDeleting team-scoped tables...')
  for (const table of TEAM_SCOPED_TABLES) {
    const { error } = await supabase.from(table).delete().eq('team_id', teamId)
    if (error) throw new Error(`ABORTED — failed deleting ${table} for team ${teamId}: ${error.message}. Nothing after this table ran; re-run is safe (deletes are idempotent).`)
    console.log(`  deleted ${table}`)
    // 2026-08-27 audit fix: subscriptions.team_id is nullable (same fact the
    // Stripe-cancellation step above already accounts for) — a row that
    // ever ended up with team_id unset would survive this team_id-only
    // delete and keep showing up in any future billing report tied to one
    // of these now-deleted users. Belt-and-suspenders, same reasoning as
    // the Stripe lookup: also delete by each member's user_id.
    if (table === 'subscriptions') {
      for (const uid of userIds) {
        const { error: byUserErr } = await supabase.from('subscriptions').delete().eq('user_id', uid)
        if (byUserErr) throw new Error(`ABORTED — failed deleting subscriptions for user ${uid}: ${byUserErr.message}.`)
      }
      console.log('  deleted subscriptions (also by user_id, for any row with team_id unset)')
    }
  }

  console.log('\nDeleting user-scoped tables for each member...')
  for (const table of USER_SCOPED_TABLES) {
    for (const uid of userIds) {
      const { error } = await supabase.from(table).delete().eq('user_id', uid)
      if (error) throw new Error(`ABORTED — failed deleting ${table} for user ${uid}: ${error.message}. Re-run is safe (deletes are idempotent) — team-scoped tables above are already gone.`)
    }
    console.log(`  deleted ${table} for all members`)
  }

  console.log('\nDeleting profiles...')
  for (const uid of userIds) {
    const { error } = await supabase.from('profiles').delete().eq('id', uid)
    if (error) throw new Error(`ABORTED — failed deleting profile for user ${uid}: ${error.message}`)
  }
  console.log('  deleted profiles')

  console.log('\nDeleting team_members and the team itself...')
  const { error: tmErr } = await supabase.from('team_members').delete().eq('team_id', teamId)
  if (tmErr) throw new Error(`ABORTED — failed deleting team_members: ${tmErr.message}`)
  const { error: teamErr } = await supabase.from('teams').delete().eq('id', teamId)
  if (teamErr) throw new Error(`ABORTED — failed deleting team ${teamId}: ${teamErr.message}. All business data and members are already gone; the team row itself still needs manual cleanup.`)
  console.log('  deleted team_members and teams row')

  console.log('\nDeleting auth.users accounts for each member (this is last and irreversible)...')
  for (const uid of userIds) {
    const { error } = await supabase.auth.admin.deleteUser(uid)
    if (error) {
      console.error(`  ! failed deleting auth user ${uid}: ${error.message} — all their business data is already gone; only the login itself remains. Retry this one manually via the Supabase dashboard (Authentication > Users) if needed.`)
    } else {
      console.log(`  deleted auth user ${uid}`)
    }
  }

  console.log(`\nDone. Team ${teamId} and all ${members.length} member account(s) fully removed, except company_contacts/company_enrichment (shared, untouched by design).`)
}

try {
  if (mode === 'dry-run') await dryRun()
  else if (mode === 'export') await exportData()
  else if (mode === 'delete') await deleteData()
} catch (err) {
  console.error(`\n${err.message}`)
  process.exit(1)
}

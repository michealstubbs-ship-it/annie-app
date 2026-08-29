import React, { useState, useRef, useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { callChat } from '../lib/callChat'
import { parseEscalation } from '../lib/supportEscalation'
import { describeChatFailure, describeStaleTab } from '../lib/chatErrorMessage'
import { isTabStale } from '../lib/staleBuild'
import { withTimeout } from '../lib/withTimeout'
import { reportClientError } from '../lib/errorReporting'

// Rewritten 2026-08-26 after a real production incident: the previous
// version of this prompt described features that don't exist (a "target
// companies" onboarding step, LinkedIn's "Connections only" export option,
// hot-tagging by target company) and omitted the things customers actually
// ask about most — pricing, tiers, trial terms, what happens if a payment
// fails. Every fact below was re-verified directly against the live code
// (not the marketing copy, not an older prompt) before being written here.
// If a fact here and the code ever disagree again, the code is right —
// update this file, don't leave the drift.
//
// Voice rules (bottom half of this prompt) are deliberately stricter than
// before: short, direct, no filler, no re-stating the question, one
// clarifying question at a time. A support agent that pads every answer
// with "Great question!" reads as a script, not a colleague who built this.
const SUPPORT_SYSTEM_PROMPT = `You are Annie's own product support. You know this product because you're built by the same team that built it, and you talk like a sharp colleague who's used it every day, not a script reading from a manual. Never open with "As an AI" or "I am an assistant." If someone directly asks whether they're talking to a person or a bot, say plainly that you're Annie's AI support assistant, one sentence, no fuss, then keep helping.

Everything you know about the product is below. Treat it as the single source of truth. If something isn't in here, say you don't know and that you'll flag it for the team — never guess, extrapolate from how similar products usually work, or invent a feature, price, limit, or policy that isn't written here.

=== WHAT ANNIE IS ===
Annie is a BD intelligence platform for recruitment firms (built by Vantage Search Group). It watches a firm's chosen sectors, functions, and markets for real BD triggers — funding rounds, leadership changes, expansions, genuine live job postings — verifies a real contact to approach for each one, and keeps the firm's CRM (contacts, companies, deals, meetings, tasks) plus recruiting tools (jobs/mandates, candidates) in one place. It also has a BD assistant chat ("Ask Annie") for drafting outreach, call prep, and market intel.

=== PLANS & PRICING ===
Three plans, monthly or annual (annual shown as an effective $/month, already discounted — never say "annual is 12x the monthly price" since annual is cheaper per month, not billed as a lump sum multiplier):
- Starter: $79/mo, or $69/mo billed annually. For a solo recruiter or single desk. Includes full CRM/pipeline/contacts, a recurring BD signal scan, Today's Actions, Ask Annie (capped at 100 messages/month), LinkedIn import.
- Growth: $129/mo, or $109/mo billed annually. Our most popular plan. Everything in Starter, plus unlimited Ask Annie messages and deeper, ongoing research scans (this applies to the regular background scans permanently, not just a one-time onboarding boost).
- Team: $99/mo per seat, or $84/mo per seat billed annually, 3-seat minimum. Everything in Growth per seat, plus a shared CRM across the whole team, a team admin/insights view, and volume seat pricing.

There is no separate "target companies" perk or step — that's not a real thing in the current product, don't invent it if asked. LinkedIn re-import and support response aren't tiered either — re-import works "for anyone, regardless of plan" (see the LINKEDIN IMPORT section below), and there's no priority support queue: every escalation from every plan goes to the same one inbox today. If a customer asks about either as a paid perk, be straightforward that it isn't one.

If someone asks exactly when they'd notice Growth/Team's deeper research, confirm it applies to their ongoing scans rather than committing to a specific calendar day — never promise "by tomorrow" or any exact timing you're not certain of.

Nobody is ever locked out of the core product (CRM, Today's Actions, Intelligence Feed) for not having an active subscription — plan differences are about extra depth and perks, never a hard wall.

=== TRIAL & SIGNUP ===
Standard trial is 7 days. Whether a card is required depends on how someone signed up: signing up directly in the app (the normal path) needs no card at all to start; starting from the public pricing page on the marketing site always asks for a card up front, since that path goes straight into a real subscription that auto-charges after the trial unless cancelled. If someone isn't sure which path they used, ask them where they started instead of guessing.

There's a separate 30-day, no-card free-month offer, but it isn't self-serve anywhere in the app — it only works via a specific link the team hands out directly. If someone asks how to get a free month and doesn't already have that link, tell them honestly there's no self-serve way to get one, and flag it for the team rather than inventing a code.

=== BILLING, PAYMENT FAILURES & TEAM SEATS ===
All plan changes, card updates, invoices, and cancellations happen in Stripe's own secure billing portal, reached via "Manage billing" on the Billing page — the app doesn't build any of that itself, so there's no in-app "cancel" button to look for.

If a real card fails to charge on a normal paid plan, Annie doesn't cancel anything immediately — Stripe retries automatically, and an email goes out asking them to update their card. If the free-month trial ends with no card ever added, a different, gentler email goes out ("add a card to keep using Annie") since there was never a card to have failed.

Team plan seats start at 3 and can be added on the Billing page's Stripe checkout (up to 100). Only the team owner can invite or remove teammates, from the Team section on the Billing page (not Settings). Adding a teammate past the seats already paid for is blocked with a message to add seats first. Removing someone from the team doesn't delete their Annie account — they just lose team membership and access to the shared team data.

There is no refund policy written anywhere in this product yet. Never promise a refund, never say refunds aren't available, and never guess at a policy — always tell the customer you're flagging it for the team to handle directly.

=== ONBOARDING ===
A new account completes exactly 5 steps in this order: firm details (firm name, required; LinkedIn profile URL, optional), sectors they recruit in, functions they place people into (a separate thing from sectors — the discipline a candidate works in, like Finance or Engineering, versus the sector their employer sits in), target markets, and communication tone. There is no "target companies" step — if someone describes onboarding that way, gently correct it.

Markets are currently limited to three: United Kingdom, UAE/GCC, and United States — these are the only markets with real, verified data behind them right now. If someone asks for a market outside these three, be honest that it isn't supported yet rather than implying it might work.

Right after onboarding, Annie kicks off a first research scan automatically in the background — nobody has to trigger anything. That first scan typically takes a few minutes and finishes within about 10 minutes. While it's running, the dashboard shows a "researching your market" banner that updates on its own; nothing needs refreshing. A customer can also trigger a fresh scan manually from Settings ("Run a new scan"), limited to once per hour. After that first scan, Annie re-scans every account automatically every 12 hours going forward.

If a first scan comes back thin or empty, that's sometimes genuinely because a niche sector or market has less breaking BD news on a given day, not a bug — Annie is honest about that on the dashboard rather than padding results, and the customer can just ask her to look again.

=== LINKEDIN IMPORT ===
Reachable from Settings ("LinkedIn contacts") or as the very next step after onboarding. The real current export path from LinkedIn (LinkedIn removed the old "connections only" option): Settings & Privacy, then Data privacy, then "Get a copy of your data," then choose "Download larger data archive" and request it — LinkedIn can take anywhere from a few hours up to 24 hours to email the file. Once it arrives, download the zip and open Connections.csv from inside it, then upload that file to Annie.

Filters before importing: sectors, markets (a wider list here than onboarding's three — UAE/GCC, UK, US, Europe, Asia Pacific, Global), functions, seniority (Any level / Manager+ / Director-VP+ / C-Suite-Partner-MD), and how recently connected (a slider, 1 to 10 years). A contact must pass the title-based filters (function, seniority, recency) AND the sector/market check to be imported. If someone gets zero or very few matches, the most likely fix is widening seniority to "Any level" — but the functions filter only covers a handful of categories by default too, so if widening seniority alone doesn't help, widening functions is worth trying next.

The most senior contacts (C-Suite/Partner/MD-level titles) are tagged "hot" automatically; there's no "target company" list involved in that tagging anymore. Import can be re-run any time from Settings, for anyone, regardless of plan.

=== DASHBOARD FEATURES ===
Today's BD Actions: only ever shows leadership changes and genuine live job postings — funding and expansion signals don't appear here because they don't reliably come with one clear person to contact; they still show up in the Intelligence Feed. Every single item on this list comes with a real contact recommendation, either one verified person or a short list of likely contacts across a few functions — nothing appears without at least an attempt at a real contact. The list doesn't wipe and regenerate; it's recomputed live from real signals and CRM data every time it's opened, and "done" status sticks per item.

Intelligence Feed: shows the broader set of signals (funding, leadership changes, expansions, hiring activity, and more) as they're found. A separate "News" tab inside the Feed holds market-level items that aren't real BD actions — M&A news, regulatory news, and public commentary — clearly separated so they never clutter Today's Actions.

Ask Annie: a BD assistant chat for outreach drafts, call prep, market intelligence, and objection handling, aware of the account's own sectors, markets, and tone. It does not currently do live web searches — its answers come from its own knowledge and whatever the account's own onboarding/CRM context gives it. Starter is capped at 100 messages/month; Growth and Team are unlimited.

Contacts: each has a status — hot, warm, cold, client, or inactive. Hot and warm contacts are the ones Annie actively watches for new signals.

Companies: a simple record (name, industry, location, website, notes) with linked contacts and jobs shown on its detail view.

BD Pipeline: deals move through prospect, approached, meeting booked, pitch sent, negotiating, then won or lost, with value, probability, and next-action fields. Pipeline deals are tracked by company name as free text right now, not yet linked directly to a Companies or Contacts record — so if someone asks why a deal doesn't show up under a company's own page, that's why.

Meetings: logged against a contact (not a candidate, even though a future version of the schema allows it), with date, type, outcome, next steps, and a follow-up date.

Tasks: plain manual BD to-dos, separate from the AI-generated Today's Actions — no AI involved, just a straightforward list linkable to a contact or candidate.

Jobs & Mandates and Candidates: available to every account, not gated to any particular firm type. Every job attaches to a real Companies record (picked from a dropdown, never free text) so the same client doesn't get created twice under different spellings. Candidates move through sourced, screening, shortlisted, presented, interviewing, offer, placed, rejected, or withdrawn.

Settings: profile details (name, job title, firm name, phone — email itself can't be changed here), the LinkedIn re-import button, a writing-style analyser, and the manual "Run a new scan" button. Sectors, functions, and markets are shown here but are NOT self-serve editable — changing them requires contacting the team directly, that's a deliberate current limitation, not a bug. Data & privacy requests (export or delete account data) are also handled here, but they're submitted as a request for the team to action, not instant/automated.

There's no notification-preferences page anywhere in the product currently — if asked, say so plainly rather than describing settings that don't exist.

A small admin-only Insights page exists (usage/billing/support/error overview) for internal use, but there's no self-serve way to get access to it — it's not tied to any plan or team role, it's a backend setting. If someone asks how to get it, say it isn't self-serve and flag it for the team.

=== ACCOUNT BASICS ===
If a confirmation email never arrives, check spam first; a new one can be requested from the login screen. Forgotten passwords use the "Forgot password?" link on the login screen. Both are ordinary, working flows — no need to escalate either one.

=== ESCALATION ===
You cannot see this account's real conversation history beyond what's shown to you, cannot process payments, cannot access anyone's private data yourself, and cannot promise a specific fix timeline. For the categories below, don't try to resolve it yourself — tell the customer plainly that you're flagging this for the team, give a realistic sense of what happens next (someone will follow up, not a guaranteed time), and end your reply with the matching marker on its own line so it reaches a real person. Never show the marker text to the customer as something they should type — it's invisible to them.

- A refund or billing dispute of any kind → end with: <<ESCALATE: refund_billing>>
- A request to export or delete their account data (if they haven't already used the Settings buttons for this) → end with: <<ESCALATE: gdpr_data_request>>
- Something that sounds like a genuine, reproducible bug, or anything that may have affected their real data → end with: <<ESCALATE: bug_report>>
- They directly ask to speak to a person → end with: <<ESCALATE: human_requested>>
- You've tried and failed to resolve the same issue across three back-and-forths, or they've expressed real frustration twice in this conversation → end with: <<ESCALATE: unresolved>>

Only ever use one marker, at the very end of your reply, only when one of these is genuinely true.

=== VOICE ===
Write like a sharp colleague typing quickly, not a support macro.
- Short sentences, usually one to three. Longer only for steps someone has to follow in order.
- Answer first, context after. Never open with a preamble or restate their question back to them.
- Plain text. No headers, no bullet lists, unless you're giving numbered steps in a strict order.
- Contractions always — "you'll", "that's", "I've".
- Match their register. Terse gets terse. Chatty gets a little warmer. Angry gets shorter and more concrete, never softer or more apologetic.
- One question per message, maximum. Never a list of clarifying questions.
- Never say "Great question!", "I'd be happy to help", "Thanks for reaching out", or "I understand how frustrating that must be" — or any other reflection of their emotion back at them.
- Never close with "Let me know if you have any other questions!" or similar boilerplate.
- Apologise at most once per conversation, and only when something is actually on Annie's side.
- No em dashes — use a comma or a full stop instead.
- No emoji unless they used one first.
- Don't re-greet or re-introduce yourself mid-conversation, and don't ask for information already given earlier in this chat.`

export default function SupportWidget() {
  const { user, profile } = useAuth()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [accountContext, setAccountContext] = useState(null)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (open && user) {
      loadHistory()
      loadAccountContext()
    }
  }, [open, user])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function loadHistory() {
    const { data } = await supabase
      .from('support_messages')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(30)
    if (data?.length) setMessages(data.map(m => ({ role: m.role, content: m.content })))
  }

  // Annie's system prompt tells her a lot about the PRODUCT, but nothing
  // about THIS customer's actual account — without this, she can only ever
  // guess at "what plan am I on" or "how many messages have I used", which
  // is exactly the kind of guess the prompt itself tells her never to make.
  // This mirrors entitlements.js's own team_members -> subscriptions lookup
  // (same tables, same join), just read client-side once per widget open
  // rather than as a real tool call — this app has no agentic tool-call
  // loop anywhere yet, a single extra context block up front is the
  // pragmatic fit for a one-shot chat call, not a sign a real tool-calling
  // rebuild is owed here.
  async function loadAccountContext() {
    try {
      const { data: membership } = await supabase
        .from('team_members')
        .select('team_id, role')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .maybeSingle()

      let sub = null
      if (membership?.team_id) {
        const { data } = await supabase
          .from('subscriptions')
          .select('tier, status, current_period_end, seats')
          .eq('team_id', membership.team_id)
          .maybeSingle()
        sub = data
      }

      const startOfMonth = new Date()
      startOfMonth.setUTCDate(1)
      startOfMonth.setUTCHours(0, 0, 0, 0)
      const { count: messagesThisMonth } = await supabase
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('role', 'user')
        .gte('created_at', startOfMonth.toISOString())

      const tier = sub?.tier || 'starter'
      const lines = [
        `Plan: ${tier}${sub?.status ? ` (${sub.status})` : ' (no active subscription found — treated as Starter)'}`,
        tier === 'starter' ? `Ask Annie messages used this month: ${messagesThisMonth ?? 0} of 100` : `Ask Annie messages used this month: ${messagesThisMonth ?? 0} (unlimited on this plan)`,
      ]
      if (sub?.status === 'trialing' && sub?.current_period_end) {
        lines.push(`Trial ends: ${new Date(sub.current_period_end).toLocaleDateString('en-GB')}`)
      }
      if (tier === 'team' && sub?.seats) lines.push(`Team seats: ${sub.seats}`)
      if (membership?.role) lines.push(`Team role: ${membership.role}`)

      setAccountContext(lines.join('\n'))
    } catch {
      // Same fail-open philosophy as everywhere else this widget touches
      // the network — a failed lookup should never block the customer from
      // getting help, it just means Annie answers account-specific
      // questions a little more generically this one time.
      setAccountContext(null)
    }
  }

  async function tagTopic(userText) {
    try {
      const { text } = await callChat({
        messages: [{ role: 'user', content: userText }],
        systemOverride: 'Read the customer support question and respond with only a short 2-4 word topic tag summarising what they are confused or asking about, for example "linkedin import filters" or "password reset". Respond with the tag only, nothing else, lowercase.',
        maxTokens: 20,
      })
      return (text || '').trim().replace(/["'.]/g, '').slice(0, 60)
    } catch {
      return null
    }
  }

  // Fire-and-forget — never blocks or changes what the customer sees. The
  // comment this used to carry ("a failed escalation is a problem for us to
  // notice separately — support-escalate.js reports it") is only true once
  // the request actually reaches the server. 2026-08-29 audit fix: it
  // wasn't — a hung or unguarded getSession() (no timeout, same root bug as
  // callChat.js) or a fetch that never leaves the browser means the request
  // never arrives, support-escalate.js's own reporting never fires, and
  // nobody ever finds out a customer asked for a human and got silence.
  // Still fire-and-forget (still must never interrupt the chat), but now
  // bounded by a timeout and logged client-side on any failure so a
  // silently-dropped escalation at least leaves a trace someone can find.
  async function escalate(category, latestExchange) {
    try {
      const { data: { session } } = await withTimeout(supabase.auth.getSession(), 8000, 'support-escalate-session')
      const token = session?.access_token
      if (!token) return
      await fetch('/api/support-escalate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ category, excerpt: latestExchange }),
      })
    } catch (err) {
      reportClientError('Support escalation failed to send', err, { category })
    }
  }

  async function send() {
    if (!input.trim() || loading || !user) return
    const userMsg = { role: 'user', content: input.trim() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    // The user's own message is written immediately — that's a plain DB
    // insert, not an Anthropic call, so it's free to fire right away.
    const insertPromise = supabase.from('support_messages').insert({ user_id: user.id, role: 'user', content: userMsg.content }).select().single()

    try {
      // Pre-flight check, 2026-08-27: same fix as Ask Annie's Chat.jsx, same
      // reason — a tab left open across a deploy is still running JS that
      // can't complete a request, so this checks for that BEFORE ever
      // attempting one, rather than only reacting to the failure it would
      // otherwise cause. See staleBuild.js's own header.
      if (await isTabStale()) {
        const { text: staleText, reloadSuggested } = describeStaleTab()
        setMessages(prev => [...prev, { role: 'assistant', content: staleText, reloadSuggested }])
        return
      }

      const systemPrompt = accountContext
        ? `${SUPPORT_SYSTEM_PROMPT}\n\n=== THIS CUSTOMER'S REAL ACCOUNT (verified — trust this, don't guess) ===\n${accountContext}`
        : SUPPORT_SYSTEM_PROMPT

      const { text: rawText } = await callChat({
        messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
        systemOverride: systemPrompt,
        maxTokens: 600,
      })
      const { displayText, category } = parseEscalation(rawText)
      const assistantMsg = { role: 'assistant', content: displayText }
      setMessages(prev => [...prev, assistantMsg])
      await supabase.from('support_messages').insert({ user_id: user.id, role: 'assistant', content: displayText })

      if (category) {
        const excerpt = [...messages, userMsg, assistantMsg]
          .slice(-10)
          .map(m => `${m.role}: ${m.content}`)
          .join('\n\n')
        escalate(category, excerpt)
      }
    } catch (err) {
      // 2026-08-27: reuses the exact same classification Ask Annie uses
      // (describeChatFailure) instead of this widget's own separate,
      // simpler apology — one request that failed at the network layer
      // (the retry-once in callChat.js already absorbed a single blip; this
      // is what's left over) deserves the same one-click reload here as
      // everywhere else, not a dead-end "try again" that fails the same
      // way if the tab really is stale.
      const { text: friendly, reloadSuggested } = describeChatFailure(err)
      setMessages(prev => [...prev, { role: 'assistant', content: friendly, reloadSuggested }])
    } finally {
      setLoading(false)
    }

    // Topic-tagging is cosmetic metadata only, and now deliberately runs
    // AFTER the real reply above has fully settled rather than
    // concurrently with it. It used to fire in parallel with the reply's
    // own callChat request, which meant every single customer message
    // quietly doubled as two simultaneous Anthropic API calls — right at
    // the moment the real, user-facing reply needed rate-limit headroom
    // most. That's the actual mechanism behind the 2026-08-23 report of the
    // widget working once and then failing on the very next message: not a
    // one-off outage, a self-inflicted doubling of load on every message.
    insertPromise
      .then(({ data }) => data?.id && tagTopic(userMsg.content).then(topic => {
        if (topic) supabase.from('support_messages').update({ topic }).eq('id', data.id)
      }))
      .catch(() => {})
  }

  if (!user) return null

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-6 w-[340px] bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden z-50 flex flex-col" style={{ maxHeight: '460px' }}>
          <div className="bg-navy px-4 py-3.5 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-gold flex items-center justify-center font-bold text-navy text-sm flex-shrink-0">A</div>
            <div>
              <div className="text-white text-sm font-semibold leading-tight">Annie support</div>
              <div className="text-gray-400 text-xs">Usually replies instantly</div>
            </div>
            <button onClick={() => setOpen(false)} className="ml-auto text-gray-400 hover:text-white text-lg leading-none" aria-label="Close support chat">×</button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 bg-page-bg space-y-2.5">
            {messages.length === 0 && (
              <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-sm px-3.5 py-2.5 text-xs text-gray-600 leading-relaxed max-w-[85%]">
                Hi {profile?.full_name?.split(' ')[0] || 'there'}, I'm here if anything's unclear. What can I help with?
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap
                  ${m.role === 'user' ? 'bg-navy text-white rounded-br-sm' : 'bg-white border border-gray-100 text-gray-700 rounded-bl-sm'}`}>
                  {m.content}
                  {m.reloadSuggested && (
                    <div className="mt-1.5 pt-1.5 border-t border-gray-100">
                      <button
                        onClick={() => window.location.reload()}
                        className="text-[11px] font-medium text-navy hover:text-gold underline underline-offset-2"
                      >
                        Reload page
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-sm px-3.5 py-2.5">
                  <div className="flex gap-1">
                    {[0, 1, 2].map(i => <div key={i} className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />)}
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="flex gap-2 p-3 border-t border-gray-100 bg-white">
            <input
              className="input flex-1 text-xs"
              placeholder="Ask a question..."
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            />
            <button onClick={send} disabled={loading || !input.trim()} className="btn-primary text-xs px-3">Send</button>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen(o => !o)}
        className="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-navy shadow-xl flex items-center justify-center z-50 hover:scale-105 transition-transform"
        aria-label="Get help"
      >
        {open ? (
          <span className="text-gold text-xl leading-none">×</span>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#c9a84c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        )}
      </button>
    </>
  )
}

import React, { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { callChat, callChatStream } from '../lib/callChat'
import { trackEvent } from '../lib/analytics'
import { getWatchlistCompanyNames, buildWatchlistChatHint } from '../lib/watchlist'
import { loadChatCrmSnapshot, buildCrmSnapshotChatHint } from '../lib/chatCrmSnapshot'
import { shouldSearchWeb } from '../lib/chatWebSearch'
import { describeChatFailure, describeStaleTab, isGenericNetworkFailure } from '../lib/chatErrorMessage'
import { isTabStale } from '../lib/staleBuild'
import { recentHistory } from '../lib/chatHistory'
import { reportClientError } from '../lib/errorReporting'

// Security fix, 2026-08-27 audit: citation URLs come from Anthropic's own
// web_search tool, so a malicious value getting into this field would be an
// upstream problem, not a customer-supplied one — but rendering it as
// `<a href>` with no scheme check at all meant a non-http(s) value (e.g. a
// javascript: URL) would execute on click, since React escapes the visible
// text but not the href attribute. Cheap to close either way.
function isSafeHttpUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

export default function Chat() {
  const { user, profile } = useAuth()
  const location = useLocation()
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [onboarding, setOnboarding] = useState(null)
  const [watchlist, setWatchlist] = useState([])
  const [crmSnapshot, setCrmSnapshot] = useState(null)
  const bottomRef = useRef(null)

  useEffect(() => { loadHistory(); loadOnboarding(); loadWatchlist(); loadCrmSnapshot() }, [user])

  // Arriving from Intelligence Feed's "Draft outreach" button, prefill the input
  // with context so the recruiter doesn't retype what Annie already knows.
  useEffect(() => {
    if (location.state?.prefill) setInput(location.state.prefill)
  }, [location.state])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function loadOnboarding() {
    const { data } = await supabase.from('onboarding').select('*').eq('user_id', user.id).single()
    setOnboarding(data)
  }

  // "Annie always learning" — same reasoning as buildCustomerWatchlistHint
  // in the scan pipeline (scanShared.js), reused here so Ask Annie is aware
  // of this recruiter's own tracked companies too, not just their onboarding
  // sectors/functions/markets — see watchlist.js's own header.
  async function loadWatchlist() {
    setWatchlist(await getWatchlistCompanyNames())
  }

  // 2026-08-31 audit fix, item 1: see chatCrmSnapshot.js's own header for
  // the full story — this is what makes Annie able to answer real questions
  // about this recruiter's own pipeline, jobs, and the BD signals she's
  // already surfaced, instead of "I do not have that information." Loaded
  // once here alongside onboarding/watchlist above, not re-fetched on every
  // message.
  async function loadCrmSnapshot() {
    if (!user) return
    setCrmSnapshot(await loadChatCrmSnapshot(user.id))
  }

  async function loadHistory() {
    const { data } = await supabase.from('chat_messages').select('*').eq('user_id', user.id).order('created_at', { ascending: true }).limit(50)
    if (data?.length) setMessages(data.map(m => ({ role: m.role, content: m.content })))
  }

  async function send() {
    if (!input.trim() || loading) return
    const userMsg = { role: 'user', content: input.trim() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    // The streaming assistant bubble starts empty and grows in place as
    // tokens arrive — its index is captured the moment the placeholder is
    // added so onDelta below always knows which message to update, and the
    // bubble itself (not a separate dots indicator) is what shows the
    // "thinking" state, then becomes the real answer word by word. This is
    // the fix for "needs to be functioning like a top AI chat bot" — the
    // old version showed bouncing dots then popped the whole reply in at
    // once, which is why it never felt like one.
    let assistantIndex
    setMessages(prev => {
      assistantIndex = prev.length
      return [...prev, { role: 'assistant', content: '', streaming: true }]
    })

    try {
      // Pre-flight check, 2026-08-27: run alongside the DB insert (no need
      // to wait for one before starting the other) rather than ever
      // attempting a request this tab's own JS can no longer possibly
      // complete — see staleBuild.js's own header for why a stale tab is
      // detectable before it fails, not just after. The recruiter's message
      // is still saved to chat_messages either way; only the doomed
      // request to Annie herself is skipped, replaced with a message that
      // says plainly what's actually true (staleBuild.js already confirmed
      // it) rather than the generic fallback's "if this just started
      // happening" hedge — that hedge is for when a request failed and we
      // can only guess why, not for when we already know.
      const [, stale] = await Promise.all([
        supabase.from('chat_messages').insert({ user_id: user.id, role: 'user', content: userMsg.content }),
        isTabStale(),
      ])

      if (stale) {
        const { text: staleText, reloadSuggested } = describeStaleTab()
        setMessages(prev => {
          const next = [...prev]
          next[assistantIndex] = { role: 'assistant', content: staleText, reloadSuggested }
          return next
        })
        return
      }

      // 2026-09-01 audit fix, real customer report ("Annie is not having a
      // proper chat... that's not a natural conversation and its
      // confusing"): this system prompt had no voice/formatting
      // instructions at all before this, so the model defaulted to its
      // normal helpful-assistant style — bold section headers, bulleted
      // lists ("**Prospect outreach?**") — for what's meant to feel like
      // texting a colleague. SupportWidget.jsx (which Michael confirmed
      // reads fine) already has exactly this kind of section; the
      // "=== VOICE ===" block below mirrors it, adapted for a BD assistant
      // rather than a support bot — numbered steps are allowed here since
      // drafting outreach genuinely is often a strict sequence, unlike
      // support's stricter "plain text" rule.
      const systemPrompt = `You are Annie, an expert BD intelligence assistant for ${profile?.full_name || 'a recruiter'} at ${profile?.firm_name || 'their recruitment firm'}.
Sectors: ${onboarding?.sectors?.join(', ') || 'General recruitment'}.
Functions this recruiter places candidates into: ${onboarding?.functions?.join(', ') || 'All functions, no specific focus given'}.
Markets: ${onboarding?.locations?.join(', ') || 'UK and international'}.
Communication tone: ${onboarding?.tone || 'professional'}.
${onboarding?.writing_style ? `\nWhen drafting any message, email, or LinkedIn copy on the recruiter's behalf, follow their real writing style closely:\n${onboarding.writing_style}\n` : ''}
${buildWatchlistChatHint(watchlist)}
${buildCrmSnapshotChatHint(crmSnapshot)}
You help with: BD strategy, outreach messages, market intelligence, interview prep, candidate pitches, objection handling, and anything recruitment business development related.
Be specific, actionable and concise. No waffle.

=== RESEARCH SCOPE ===
2026-09-01, per Michael, real customer report: asked about a company that
wasn't in his tracked list and got told it "isn't in my tracked companies"
instead of an actual answer. That's wrong — the CRM/watchlist context above
is background you already have on hand, never the boundary of what you can
help with. You can be asked about ANY company, person, or market topic, not
just ones already in this recruiter's CRM. If you don't already know
something, use your web search tool to actually go find out, the same way
you'd look something up for a colleague before answering — never use "not
tracked" or "not in my CRM" as a reason to stop short. Use the CRM/pipeline
context above when it's genuinely relevant to the question (e.g. connecting
a new company to a candidate already on file), and web search for anything
about the world outside it. If a search genuinely turns up nothing solid,
say that plainly and offer what you can reason about instead — don't
pretend a lack of tracked-company data means a lack of an answer.

=== VOICE ===
Write like a sharp, switched-on colleague typing quickly, not a business document.
- Short sentences, usually one to three. Longer only for an actual draft (an email, a LinkedIn message) you're asked to write out in full.
- Answer first, context after. Never open with a preamble or restate the question back.
- Plain text by default. No bold section headers, no bullet lists of options — write it as sentences. Numbered steps are fine ONLY for a real sequence someone follows in order (e.g. a 3-step outreach plan), never as a menu of unrelated ideas.
- One clarifying question at a time, never a numbered list of several at once — ask the single most useful one, get the answer, then ask the next if you still need it.
- Contractions always — "you'll", "that's", "I've".
- Never say "Great question!", "I'd be happy to help", "What's on your mind?", or close with "Let me know if you have any other questions!" or similar boilerplate.
- No em dashes — use a comma or a full stop instead.
- No emoji unless the recruiter used one first.`

      // 27 Aug 2026: only pay search's extra cost/latency when the question
      // actually needs current information — see chatWebSearch.js's header.
      //
      // 2026-08-29 audit fix: this used to send the WHOLE conversation —
      // every message since the tab was opened — on every turn, with no cap
      // anywhere in the pipeline. See chatHistory.js's own header for why
      // that's the same failure shape as Today's Actions' batching bug: an
      // uncapped conversation grows this prompt indefinitely, hitting the
      // streaming timeout hardest for exactly the customers actually
      // engaging most with Ask Annie. Full history still renders on screen
      // and still saves to chat_messages in full — only what's SENT to the
      // model is capped.
      const chatPayload = {
        messages: recentHistory([...messages, userMsg]).map(m => ({ role: m.role, content: m.content })),
        systemOverride: systemPrompt,
        maxTokens: 1500,
        webSearch: shouldSearchWeb(userMsg.content),
        maxSearchUses: 3,
      }

      let text, citations
      const streamStartedAt = Date.now()
      try {
        ;({ text, citations } = await callChatStream({
          ...chatPayload,
          onDelta: (_chunk, fullTextSoFar) => {
            setMessages(prev => {
              const next = [...prev]
              next[assistantIndex] = { role: 'assistant', content: fullTextSoFar, streaming: true }
              return next
            })
          },
        }))
      } catch (streamErr) {
        // 2026-08-29 audit fix, root cause of Michael's "worst one" report:
        // Netlify hard-caps a STREAMING function response at 10 seconds of
        // execution (their own docs: "If the limit is reached, the response
        // stops streaming" — their staff points to Edge Functions as the
        // real fix, since only CPU time counts there, not time waiting on
        // Anthropic). A question that triggers a real web search (Annie can
        // run up to 3, each with genuine multi-second latency — see
        // shouldSearchWeb above) can easily clear 10s of actual generation
        // time while still comfortably finishing inside a REGULAR function's
        // much more generous ~30s limit — chat.js's own non-streaming path,
        // used by every caller except this one. So rather than surface that
        // platform ceiling as a failure at all, retry once, non-streaming,
        // through the exact same endpoint with the exact same payload —
        // the recruiter loses the word-by-word animation on this one reply,
        // not the reply itself. Only for a generic, contentless failure
        // (what a killed stream produces): a real server-sent answer (the
        // monthly Ask Annie cap, a rate limit) means the request was never
        // in doubt, so retrying non-streaming would just hit the identical
        // wall a second time for no reason — let the outer catch show that
        // verbatim instead, same as before this fix.
        if (!isGenericNetworkFailure(streamErr)) throw streamErr
        // 2026-08-30: observability only, no behavior change. Today's
        // Actions' identical callChatStream call sites were traced to a
        // real, measured transport failure (stream:true -> HTTP 504 at
        // ~31s, zero bytes ever sent — see useTodaysActions.js's own fix
        // comment) and switched to callChat entirely. This call site
        // consumes onDelta for a real word-by-word effect, so it wasn't
        // switched — this fallback already exists and should mask the same
        // failure from the user — but there was no way to tell how often it
        // actually fires. Logged here (not before) so a genuinely generic,
        // narrow network blip doesn't get conflated with a systematic
        // transport failure — elapsedMs is what actually distinguishes them.
        reportClientError('Ask Annie: streaming reply failed, falling back to non-streaming', streamErr, {
          elapsedMs: Date.now() - streamStartedAt,
        })
        setMessages(prev => {
          const next = [...prev]
          // Clear whatever partial text the killed stream left in the
          // placeholder before the retry starts — the fallback's own answer
          // replaces it below once it lands, not appends to a fragment.
          next[assistantIndex] = { role: 'assistant', content: '', streaming: true }
          return next
        })
        ;({ text, citations } = await callChat(chatPayload))
      }

      setMessages(prev => {
        const next = [...prev]
        // citations only ever come back when this message actually triggered
        // a live search (see shouldSearchWeb above) — surfaced so a
        // recruiter can tell a search-grounded answer from Annie's own
        // knowledge, not just take "as of today" on faith.
        next[assistantIndex] = { role: 'assistant', content: text, citations: citations?.length ? citations : undefined }
        return next
      })
      await supabase.from('chat_messages').insert({ user_id: user.id, role: 'assistant', content: text })
      trackEvent('ask_annie_message_sent')
    } catch (err) {
      // 2026-08-26 audit fix: this used to always show a generic "something
      // went wrong" regardless of what actually failed. callChatStream()
      // throws new Error(err.error || 'Request failed') for every non-ok
      // response, and chat.js's own error bodies are already written to be
      // shown to the user verbatim — most importantly its 402 for hitting
      // the monthly Ask Annie cap ("You've used all 100 Ask Annie messages
      // included this month. Upgrade to Growth for unlimited messages."),
      // which a Starter user hitting their limit was previously never told
      // at all. Only fall back to the generic copy for the cases where
      // err.message genuinely isn't something a user should see: no
      // message, the generic 'Request failed' used when the server didn't
      // send a JSON body, or a raw browser network-error string.
      //
      // 2026-08-27 fix: that generic fallback case is exactly the class of
      // failure a stale tab produces — the tab is still running a previous
      // deploy's JS when a new one goes live, and the very next send() fails
      // at the network layer. Other pages already auto-recover from this
      // (see ErrorBoundary.jsx's chunk-load handling), but that boundary only
      // catches React render errors, never a fetch() failure inside this
      // try/catch, so Ask Annie was the one place still telling the
      // recruiter to just "try again" — which fails the same way again if
      // the tab really is stale, since resending doesn't reload anything.
      // describeChatFailure centralises the same message-classification
      // logic and adds the one thing that actually fixes it: a one-click
      // reload, offered rather than forced (an unprompted auto-reload here
      // would risk looping on a genuine, unrelated network problem — see
      // describeChatFailure's own header).
      const { text: friendly, reloadSuggested } = describeChatFailure(err)
      setMessages(prev => {
        const next = [...prev]
        // Replace the streaming placeholder in place (it may already have
        // partial text in it) rather than appending a second bubble — a
        // failed request should leave exactly one assistant message, not a
        // half-written one plus a separate apology underneath it.
        if (assistantIndex != null && next[assistantIndex]?.streaming) {
          next[assistantIndex] = { role: 'assistant', content: friendly, reloadSuggested }
        } else {
          next.push({ role: 'assistant', content: friendly, reloadSuggested })
        }
        return next
      })
    } finally {
      setLoading(false)
    }
  }

  const QUICK = ['Draft an outreach email to a new prospect', 'Help me prepare for a BD call', 'What should I say to re-engage a cold contact?', 'Write a LinkedIn message for a warm lead']

  return (
    // Fixed viewport height, not min-height, so this must account for the
    // same mobile top bar Dashboard.jsx's <main> already clears with its own
    // `pt-14 lg:pt-0` (see that file's comment) — without the matching
    // `-3.5rem` here on mobile, this container renders 56px taller than the
    // space actually visible below that bar, pushing the message input row
    // (including the Send button) 56px below the fold on any viewport under
    // the lg breakpoint, so it's only reachable by scrolling `<main>` itself.
    // 2026-08-27 UX audit fix; boundary moved from md: to lg: on 2026-08-29
    // alongside Sidebar.jsx's own fix — see that file's header for why.
    <div className="flex flex-col h-[calc(100vh-3.5rem)] lg:h-screen max-h-screen p-8 pb-0">
      <div className="mb-4">
        <h1 className="text-3xl font-bold text-navy">Ask Annie</h1>
        <p className="text-gray-500 mt-1">Your personal BD intelligence assistant</p>
      </div>

      {messages.length === 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2">
          {QUICK.map(q => (
            <button key={q} onClick={() => { setInput(q); }} className="card p-3 text-left text-sm text-gray-600 hover:border-gold hover:text-navy transition-all border border-gray-100">
              {q}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-4 pb-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap
              ${m.role === 'user' ? 'bg-navy text-white rounded-br-sm' : 'bg-white border border-gray-100 text-gray-700 rounded-bl-sm shadow-sm'}`}>
              {m.streaming && !m.content ? (
                <div className="flex gap-1">
                  {[0,1,2].map(i => <div key={i} className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />)}
                </div>
              ) : (
                <>
                  {m.content}
                  {m.streaming && <span className="inline-block w-1.5 h-4 bg-gray-400 ml-0.5 align-middle animate-pulse" />}
                  {m.citations?.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-100 text-xs text-gray-400 space-y-0.5">
                      <div className="font-medium text-gray-400">Checked live just now:</div>
                      {m.citations.filter(c => isSafeHttpUrl(c.url)).slice(0, 5).map((c, ci) => (
                        <a key={ci} href={c.url} target="_blank" rel="noopener noreferrer" className="block truncate hover:text-gold hover:underline">
                          {c.title || c.url}
                        </a>
                      ))}
                    </div>
                  )}
                  {m.reloadSuggested && (
                    <div className="mt-2 pt-2 border-t border-gray-100">
                      <button
                        onClick={() => window.location.reload()}
                        className="text-xs font-medium text-navy hover:text-gold underline underline-offset-2"
                      >
                        Reload page
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="py-4 border-t border-gray-100 bg-page-bg">
        <div className="flex gap-2">
          <input className="input flex-1" placeholder="Ask Annie anything..." value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()} />
          <button onClick={send} disabled={loading || !input.trim()} className="btn-primary px-5">Send</button>
        </div>
      </div>
    </div>
  )
}

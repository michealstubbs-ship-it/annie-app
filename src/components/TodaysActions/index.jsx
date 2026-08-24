import React, { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useTodaysActions } from './useTodaysActions.js'
import { buildApproaches, BD_CATEGORIES, BADGE, normalizeMatch, buildWhyChips } from './helpers.js'
import { firstNameOf } from '../../lib/outreachMessage'
import ApproachPicker from '../ApproachPicker'
import CompanyLogo from '../CompanyLogo'
import CandidateProfileBox from '../CandidateProfileBox'

// Page shell only — all data and mutations come from useTodaysActions.js.
// Everything kept as local state here is genuinely UI-only: which card is
// expanded, which copy button just fired, which approach chip is picked,
// and which tab is active. Nothing here ever recomputes eligibility or
// touches actions_cache directly — see useTodaysActions.js and
// src/lib/todaysActions/ for why that's now impossible to get out of sync.
export default function TodaysActions() {
  const { user, profile } = useAuth()
  const { actions, loading, refreshing, generated, error, crmAdded, refresh, markDone, addContactToCrm, fullIntroMessage } = useTodaysActions({ user, profile })
  const [openIndex, setOpenIndex] = useState(null)
  const [copiedIndex, setCopiedIndex] = useState(null)
  const [approachChoice, setApproachChoice] = useState({})
  const [tab, setTab] = useState('bd')

  async function copyIntroMessage(action, index, contact) {
    const text = fullIntroMessage(action, contact)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard permission can fail quietly in some browsers/contexts —
      // the message is still shown right above the button either way.
    }
    setCopiedIndex(index)
    setTimeout(() => setCopiedIndex(c => (c === index ? null : c)), 2000)
  }

  return (
    <div className="p-8 max-w-[900px]">
      <div className="mb-1">
        <h1 className="text-xl font-extrabold text-navy">Good morning, {profile?.full_name?.split(' ')[0] || 'there'}</h1>
        <p className="text-gray-500 text-[13px] mt-0.5">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
      </div>

      {!generated && !loading && (
        <div className="card p-10 text-center mt-6">
          <div className="text-5xl mb-4">⚡</div>
          <h2 className="text-xl font-bold text-navy mb-2">Ready to see today's actions?</h2>
          <p className="text-gray-500 mb-6 max-w-sm mx-auto">Annie is already researching your market around the clock. This pulls together everything genuinely worth acting on today, sized by real opportunity, not a fixed number.</p>
          <button onClick={() => refresh({ silent: false })} className="btn-primary">Show Today's Actions</button>
        </div>
      )}

      {loading && (
        <div className="card p-10 text-center mt-6">
          <div className="w-12 h-12 border-4 border-gold border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-navy font-semibold">Annie is thinking...</p>
          <p className="text-gray-500 text-sm mt-1">Scoring your pipeline against what she's already found</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm mb-4 mt-6">{error}</div>
      )}

      {generated && actions.length > 0 && (() => {
        const rows = actions.map((action, i) => ({ action, i }))
        const bdRows = rows.filter(r => BD_CATEGORIES.includes(r.action.category))
        const followUpRows = rows.filter(r => !BD_CATEGORIES.includes(r.action.category))
        const activeRows = tab === 'bd' ? bdRows : followUpRows
        return (
        <div>
          <div className="flex gap-0 border-b-2 border-gray-200 mt-6">
            <button
              onClick={() => setTab('bd')}
              className={`px-1.5 py-2.5 mr-[22px] text-[13.5px] font-bold border-b-2 -mb-0.5 transition-colors ${tab === 'bd' ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'}`}
            >
              Today's BD actions {bdRows.length > 0 && <span className="text-xs font-semibold">({bdRows.length})</span>}
            </button>
            <button
              onClick={() => setTab('followup')}
              className={`px-1.5 py-2.5 text-[13.5px] font-bold border-b-2 -mb-0.5 transition-colors ${tab === 'followup' ? 'text-navy border-gold' : 'text-gray-500 border-transparent hover:text-gray-600'}`}
            >
              Worth your follow up {followUpRows.length > 0 && <span className="text-xs font-semibold">({followUpRows.length})</span>}
            </button>
          </div>

          {activeRows.length === 0 ? (
            <div className="card p-8 text-center mt-5">
              <p className="text-gray-500 text-sm max-w-sm mx-auto">
                {tab === 'bd'
                  ? "No new BD signals right now, check Worth your follow up, or check back soon, Annie's still watching in the background."
                  : "Nothing needs following up right now, your pipeline is current."}
              </p>
            </div>
          ) : (
          <>
          <p className="text-[12.5px] text-gray-500 leading-relaxed mt-5 mb-4 max-w-[600px]">
            {tab === 'bd'
              ? <>Annie found <span className="font-semibold text-navy">{activeRows.length} new signal{activeRows.length === 1 ? '' : 's'} worth acting on</span>, ranked by what's most time-sensitive first.</>
              : <><span className="font-semibold text-navy">{activeRows.length} thing{activeRows.length === 1 ? '' : 's'}</span> worth a routine follow-up, no new research behind these.</>}
          </p>

          <div className={tab === 'followup' ? 'space-y-2' : 'space-y-3'}>
          {activeRows.map(({ action, i }) => {
            const isOpen = openIndex === i
            const isSourced = action.source === 'sourced'
            // A plain sourced signal (not live_job) carries no category badge
            // at all, matching the mock — it's only ever flagged via the
            // separate time-sensitive pill just below when it's urgent.
            const badge = action.signalType === 'live_job' ? BADGE.live_job : (isSourced ? null : (BADGE[action.category] || BADGE.new_client))
            const matches = (action.pipelineMatches || []).map(normalizeMatch)
            // The one thing that actually unlocks a "ready-to-send" message:
            // a real, Apollo-verified person to address it to — the single
            // verifiedContact when one exists, else the first of the
            // multi-function contactCandidates panel.
            const messageContact = action.verifiedContact || (action.contactCandidates?.length ? action.contactCandidates[0] : null)
            return (
              <div
                key={i}
                onClick={() => setOpenIndex(isOpen ? null : i)}
                className={`bg-white rounded-xl shadow-[0_1px_2px_rgba(13,27,62,0.06),0_1px_6px_rgba(13,27,62,0.04)] cursor-pointer hover:shadow-md transition-shadow ${tab === 'followup' ? 'px-3.5 py-3' : 'p-4'}`}
              >
                <div className="flex items-start gap-3">
                  {tab === 'bd' && (
                    <div className="w-7 h-7 rounded-full bg-navy text-gold flex items-center justify-center font-bold text-xs flex-shrink-0 mt-0.5">
                      {i + 1}
                    </div>
                  )}
                  {action.company && <CompanyLogo name={action.company} logoUrl={action.companyLogo} size={tab === 'followup' ? 'w-6 h-6' : 'w-8 h-8'} textSize={tab === 'followup' ? 'text-[9px]' : 'text-[11px]'} />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={`font-bold text-navy ${tab === 'followup' ? 'text-[13px]' : 'text-sm'}`}>{action.headline}</h3>
                      {badge && <span className={`text-[9.5px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${badge.className}`}>{badge.label}</span>}
                      {isSourced && action.signalType !== 'live_job' && action.urgency >= 2 && <span className="text-[9.5px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-gold text-navy">time-sensitive</span>}
                    </div>
                    {(action.contact || action.company) && (
                      <p className="text-[12px] text-gold-ink font-semibold mt-1">
                        {[action.contact, action.title, action.company].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    <p className={isSourced ? 'text-gray-600 text-[13px] italic border-l-2 border-gold pl-2.5 mt-1.5 leading-relaxed' : `text-gray-600 ${tab === 'followup' ? 'text-[12.5px] mt-0.5' : 'text-sm mt-1.5'}`}>{action.detail}</p>

                    {isOpen && (
                      <div className="mt-3 pt-3 border-t border-gray-100" onClick={e => e.stopPropagation()}>
                        {isSourced ? (
                          <>
                            <div className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">What Annie found</div>
                            {action.sourceUrl && (
                              <a href={action.sourceUrl} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline block mb-3">
                                🔗 {action.sourceLabel || action.sourceUrl}
                              </a>
                            )}
                            <div className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Who to approach, and why</div>
                            {action.verifiedContact ? (
                              <div className="bg-green-50 border border-green-200 rounded-[10px] px-3 py-2.5 mb-2.5">
                                <div className="flex items-center justify-between gap-2 mb-1">
                                  <span className="text-[9px] font-bold text-green-700 uppercase tracking-wider">Verified via Apollo</span>
                                  <button
                                    onClick={() => addContactToCrm(action, action.verifiedContact, String(i))}
                                    disabled={crmAdded[String(i)]}
                                    className={`text-[10.5px] font-bold px-2.5 py-1 rounded-full border transition-colors flex-shrink-0 ${crmAdded[String(i)] ? 'text-gray-400 border-gray-200 bg-white cursor-default' : 'text-green-700 border-green-300 bg-white hover:bg-green-50'}`}
                                  >
                                    {crmAdded[String(i)] ? `✓ Added to CRM` : `＋ Add ${firstNameOf(action.verifiedContact.name)} to CRM`}
                                  </button>
                                </div>
                                <p className="text-[12.5px] font-bold text-navy mt-0.5">{action.verifiedContact.name}{action.verifiedContact.title ? `, ${action.verifiedContact.title}` : ''}</p>
                                <div className="flex items-center gap-2.5 mt-0.5 flex-wrap">
                                  {action.verifiedContact.email && (
                                    <a href={`mailto:${action.verifiedContact.email}`} className="text-[11px] text-blue-600 hover:underline">{action.verifiedContact.email}</a>
                                  )}
                                  {action.verifiedContact.linkedin_url && (
                                    <a href={action.verifiedContact.linkedin_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline">View LinkedIn profile</a>
                                  )}
                                </div>
                                <p className="text-xs text-gray-600 mt-1.5">{action.whoToApproach}</p>
                              </div>
                            ) : action.contactCandidates?.length > 0 ? (
                              // Funding/expansion signals rarely have one obvious single
                              // contact — this is the guaranteed fallback that makes "always
                              // a contact recommendation" true for those anyway.
                              <div className="bg-green-50 border border-green-200 rounded-[10px] px-3 py-2.5 mb-2.5">
                                <span className="text-[9px] font-bold text-green-700 uppercase tracking-wider">Verified via Apollo · likely contacts across functions</span>
                                {action.likelyRoles?.length > 0 && (
                                  <p className="text-xs text-gray-600 mt-1 mb-1.5">Likely hiring for: <span className="font-semibold text-navy">{action.likelyRoles.join(', ')}</span></p>
                                )}
                                <div className="space-y-2 mt-1.5">
                                  {action.contactCandidates.map((c, ci) => {
                                    const crmKey = `${i}:${c.function || ci}`
                                    return (
                                      <div key={crmKey} className="flex items-start justify-between gap-2 pt-2 border-t border-green-700/15 first:border-t-0 first:pt-0">
                                        <div className="min-w-0">
                                          <p className="text-[12.5px] font-bold text-navy">{c.name}{c.title ? `, ${c.title}` : ''}</p>
                                          <div className="flex items-center gap-2.5 mt-0.5 flex-wrap">
                                            {c.email && <a href={`mailto:${c.email}`} className="text-[11px] text-blue-600 hover:underline">{c.email}</a>}
                                            {c.linkedin_url && <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline">View LinkedIn profile</a>}
                                          </div>
                                        </div>
                                        <button
                                          onClick={() => addContactToCrm(action, c, crmKey)}
                                          disabled={crmAdded[crmKey]}
                                          className={`text-[10.5px] font-bold px-2.5 py-1 rounded-full border transition-colors flex-shrink-0 ${crmAdded[crmKey] ? 'text-gray-400 border-gray-200 bg-white cursor-default' : 'text-green-700 border-green-300 bg-white hover:bg-green-50'}`}
                                        >
                                          {crmAdded[crmKey] ? '✓ Added' : `＋ Add to CRM`}
                                        </button>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            ) : (
                              <p className="text-xs text-gray-600 mb-2.5">{action.whoToApproach} <span className="text-gray-400">(no verified contact found yet, approach by role)</span></p>
                            )}

                            {/* Rich per-candidate pipeline match, mirroring the mock's
                                cand-row layout — real name, role and current company
                                for each match, never invented "why" reasoning. */}
                            {matches.length > 0 ? (
                              <div className="bg-green-50 border border-green-200 rounded-[10px] px-3 py-2.5 mb-2.5">
                                <div className="text-[9px] font-bold text-green-700 uppercase tracking-wider">✓ Annie checked your pipeline</div>
                                <p className="text-[12.5px] font-bold text-green-700 mt-0.5 mb-0.5">{matches.length} candidate{matches.length === 1 ? '' : 's'} already in your pipeline could fit this</p>
                                <p className="text-[10.5px] italic text-[#4d7c5f]">Matched on role and industry overlap with this signal</p>
                                {matches.map((m, mi) => {
                                  const chips = buildWhyChips(m, action)
                                  return (
                                    <div key={mi} className="mt-2 pt-2 border-t border-green-700/15">
                                      <p className="text-xs font-bold text-navy">
                                        {m.name}
                                        {(m.role || m.company) && <span className="font-medium text-[#166534] text-[11.5px]"> · {[m.role, m.company].filter(Boolean).join(', ')}</span>}
                                      </p>
                                      {chips.length > 0 && (
                                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                                          {chips.map((c, ci) => (
                                            c.aiGenerated ? (
                                              <span
                                                key={ci}
                                                title="Annie's read — an AI-written pitch grounded in this candidate's own profile and notes, not a verified fact."
                                                className="text-[10.5px] font-semibold px-2.5 py-[3px] rounded-full bg-white border border-dashed border-green-300 text-[#166534] whitespace-nowrap"
                                              >
                                                {c.icon} {c.text} <span className="italic text-[#4d7c5f]">— Annie's read</span>
                                              </span>
                                            ) : (
                                              <span key={ci} className="text-[10.5px] font-semibold px-2.5 py-[3px] rounded-full bg-white border border-green-200 text-[#166534] whitespace-nowrap">
                                                {c.icon} {c.text}
                                              </span>
                                            )
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            ) : (
                              <div className="bg-page-bg border border-dashed border-[#d7dceb] rounded-[10px] px-3 py-2.5 mb-2.5">
                                <div className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">🔍 Annie checked your pipeline</div>
                                <p className="text-xs text-gray-500 mt-0.5">No current candidates match this spec yet, worth sourcing fresh rather than a dead end.</p>
                              </div>
                            )}

                            <CandidateProfileBox profile={action.candidateProfile} />
                            {matches.length === 0 && (
                              <ApproachPicker
                                approaches={buildApproaches(action)}
                                selectedKey={approachChoice[i]}
                                onSelect={key => setApproachChoice(prev => ({ ...prev, [i]: key }))}
                              />
                            )}
                            {/* The one thing here meant to be used as-is, not just
                                read. Gated on messageContact: a message greeted "Hi
                                there," and labeled ready-to-send when there's
                                genuinely nobody confirmed to send it to yet was worse
                                than no message at all. */}
                            {messageContact && (
                              <div className="bg-navy rounded-[10px] px-3.5 py-3 mb-1">
                                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                                  <span className="text-[9.5px] font-bold text-gold uppercase tracking-wider">✉️ Ready-to-send message</span>
                                  <button
                                    onClick={() => copyIntroMessage(action, i, messageContact)}
                                    title="Copies this message to your clipboard, ready to paste into an email or LinkedIn message: nothing to draft, nothing to leave this page for."
                                    className="text-xs font-bold px-4 py-2 rounded-md bg-gold text-navy hover:bg-gold/90 flex-shrink-0 transition-colors"
                                  >
                                    {copiedIndex === i ? '✓ Copied!' : '📋 Copy message'}
                                  </button>
                                </div>
                                <p className="text-white/90 text-[11.5px] leading-relaxed whitespace-pre-line">{fullIntroMessage(action, messageContact)}</p>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Why this made the list</div>
                            <div className="space-y-1 mb-3">
                              {Object.entries(action.signals || {}).map(([k, v]) => (
                                <div key={k} className="flex justify-between text-xs">
                                  <span className="text-gray-400">{k}</span>
                                  <span className="text-navy font-semibold">{v}</span>
                                </div>
                              ))}
                            </div>
                            {action.moveForward?.length > 0 && (
                              <>
                                <div className="text-[9.5px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Ways to move this forward</div>
                                <div className="space-y-1.5 mb-3">
                                  {action.moveForward.map((m, mi) => (
                                    <div key={mi} className="bg-page-bg rounded-lg px-3 py-2 text-xs text-gray-600">{m}</div>
                                  ))}
                                </div>
                              </>
                            )}
                          </>
                        )}
                        <button onClick={() => markDone(action)} className="text-xs font-semibold text-gray-400 hover:text-navy">Mark done</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
          </div>

          <button
            onClick={() => refresh({ silent: true })}
            disabled={refreshing}
            className="btn-ghost text-sm mt-3"
          >
            {refreshing ? 'Checking for anything new…' : 'Check for anything new'}
          </button>
          </>
          )}
        </div>
        )
      })()}

      {generated && actions.length === 0 && !loading && (
        <div className="card p-10 text-center mt-6">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="font-bold text-navy mb-1">Nothing urgent today</h3>
          <p className="text-gray-500 text-sm max-w-sm mx-auto">Your pipeline is quiet and Annie's ongoing scan hasn't turned up anything strong enough yet. Check back later, she's still watching in the background.</p>
        </div>
      )}
    </div>
  )
}

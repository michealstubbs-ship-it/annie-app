// Turning a message into the line a recruiter would have typed themselves.
//
// The whole feature turns on this file. "Re: Senior Marketing Manager profile,
// 2 Sep" is a filing reference nobody reads twice. "Bayan confirmed Sunday 1pm
// after Abdullah's clash" is why anyone keeps a CRM at all.
//
// Two rules shape everything below:
//   1. Record what was actually said, including figures. A recruiter's notes
//      routinely carry salary and expectations; stripping them would make the
//      note useless for the one job it has.
//   2. Never invent. If the message says nothing, say what the message was
//      about and stop. A confident wrong note is worse than a dull right one.

import { fetchWithRetry } from './scanShared.js'

export const NOTE_MODEL = 'claude-haiku-4-5-20251001'
export const MAX_BODY_CHARS = 4000
export const MAX_NOTE_CHARS = 220

// Quoted history is the single biggest cost in this call and the biggest
// source of wrong notes: without stripping it, every reply in a twelve-message
// thread gets summarised as though the whole thread just happened.
export function stripQuotedHistory(bodyPlain) {
  const raw = String(bodyPlain || '').replace(/\r\n/g, '\n')
  if (!raw.trim()) return ''

  const lines = raw.split('\n')
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (/^_{5,}$/.test(t) || /^-{5,}\s*(original message|forwarded message)/i.test(t)) break
    if (/^-{2,}\s*forwarded message\s*-{2,}$/i.test(t)) break
    if (/^from:\s*.+<.*@.*>/i.test(t)) break
    if (/^from:\s*.+\s+sent:\s*/i.test(t)) break
    if (/^on .{4,80}\bwrote:\s*$/i.test(t)) break
    if (/^>/.test(t)) continue
    out.push(line)
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_BODY_CHARS)
}

// What we fall back to when there is no API key, the call fails, or the model
// returns nothing usable. The ledger is never blocked on the AI being up.
export function fallbackNote({ direction, subject }) {
  const s = String(subject || '').replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').trim()
  if (!s) return direction === 'out' ? 'Sent an email' : 'Received an email'
  return direction === 'out' ? `Emailed about ${s}` : `Replied about ${s}`
}

export function buildNotePrompt({ direction, counterpartyName, companyName, subject, body }) {
  const who = [counterpartyName, companyName].filter(Boolean).join(' at ') || 'the contact'
  const way = direction === 'out'
    ? `The recruiter sent this to ${who}.`
    : `${who} sent this to the recruiter.`

  return [
    'You write CRM notes for an executive search recruiter.',
    '',
    way,
    `Subject: ${subject || '(none)'}`,
    '',
    'Message:',
    '"""',
    body || '(empty)',
    '"""',
    '',
    'Write ONE line recording what happened, as the recruiter would jot it down.',
    '',
    'Rules:',
    '- Past tense, no greeting, no sign-off, no quote marks around the whole line.',
    '- Under 25 words.',
    '- Keep concrete specifics: names, dates, times, job titles, salary figures,',
    '  numbers and commitments. These are the reason the note exists.',
    '- Record only what the message says. Never add context, never guess intent,',
    '  never speculate about what happens next.',
    '- If the message carries no substance, describe what it was about in a few words.',
    '- Do not start with the contact\'s name; the note already sits on their record.',
    '',
    'Reply with the line only.',
  ].join('\n')
}

function tidy(raw) {
  let s = String(raw || '').trim()
  s = s.split('\n').map(l => l.trim()).filter(Boolean)[0] || ''

  // Peeled in a loop, not in sequence: the model writes both `Note: "..."` and
  // `"Note: ..."`, and a single pass in either order leaves a stray quote.
  for (let i = 0; i < 4; i++) {
    const before = s
    s = s.replace(/^(note|summary|crm note)\s*:\s*/i, '').trim()
    s = s.replace(/^["'`\u201c\u2018]+/, '').replace(/["'`\u201d\u2019]+$/, '').trim()
    if (s === before) break
  }

  if (s.length > MAX_NOTE_CHARS) s = `${s.slice(0, MAX_NOTE_CHARS - 1).trimEnd()}…`
  return s
}

/**
 * Write the note. Never throws — a mailbox sync must not fall over because
 * Anthropic had a bad minute, so every failure path returns the fallback and
 * says which path it took.
 *
 * onUsage is a callback rather than a direct aiUsage import for the same
 * reason personalizePoolHits uses one: importing it here would close a cycle.
 */
export async function writeNote(anthropicKey, message, { onUsage = null, fetchImpl = null } = {}) {
  const direction = message?.direction === 'out' ? 'out' : 'in'
  const subject = message?.subject || ''
  const body = stripQuotedHistory(message?.bodyPlain)
  const fallback = fallbackNote({ direction, subject })

  if (!anthropicKey) return { note: fallback, model: null, source: 'fallback_no_key' }
  if (!body && !subject) return { note: fallback, model: null, source: 'fallback_empty' }

  const prompt = buildNotePrompt({
    direction,
    counterpartyName: message?.counterpartyName || '',
    companyName: message?.companyName || '',
    subject,
    body,
  })

  try {
    const doFetch = fetchImpl || fetchWithRetry
    const resp = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: NOTE_MODEL,
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
    }, 12000, 1)

    if (!resp?.ok) return { note: fallback, model: null, source: 'fallback_http' }

    const data = await resp.json()
    if (typeof onUsage === 'function' && data?.usage) {
      try { onUsage(data.usage) } catch { /* usage accounting never blocks a note */ }
    }

    const text = tidy(data?.content?.[0]?.text)
    if (!text) return { note: fallback, model: null, source: 'fallback_empty_reply' }
    return { note: text, model: NOTE_MODEL, source: 'model' }
  } catch {
    return { note: fallback, model: null, source: 'fallback_error' }
  }
}

/**
 * An out-of-office is not a conversation. It gets its own note so the record
 * shows what happened, and the caller is told not to stamp last_contacted.
 */
export function autoReplyNote({ awayUntil }) {
  if (!awayUntil) return 'Out of office auto-reply'
  const d = new Date(`${awayUntil}T00:00:00Z`)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  if (Number.isNaN(d.getTime())) return 'Out of office auto-reply'
  return `Out of office until ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}

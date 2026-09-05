// The draft, on request. See src/lib/stream/draftApproach.js for why the
// prompt is built around the way-in ladder rather than the signal alone.
//
// Sending is the half that did not exist. The draft already worked; it just
// ended at "Copy", and the recruiter pasted it into Outlook — which is why
// Annie never saw a single reply and could not tell a lead that converted from
// one nobody opened.
//
// The address is always shown and always editable, never sent to a guess. If
// Annie has no confirmed address the field starts empty and Send stays off,
// because a wrong recipient here is a message to a stranger on the recruiter's
// own name, from their own mailbox.
import { useState, useEffect } from 'react'
import { draftApproach } from '../../lib/stream/draftApproach'
import { sendFromAnnie } from '../../lib/email/emailApi'

function subjectFor(item) {
  const company = item?.signal?.company_name || item?.company_name
  return company ? `${company} — hiring` : 'Introduction'
}

export default function DraftPanel({ item, profile, onboarding, emailReady = false, recipient = null }) {
  const [state, setState] = useState('idle') // idle | writing | done | error
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

  const [to, setTo] = useState(recipient?.email || '')
  const [subject, setSubject] = useState(subjectFor(item))
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  // A contact resolved after the draft was written (ContactLookup ran, or the
  // signature on a reply filled the address in) should populate the field
  // rather than leave the recruiter retyping it.
  useEffect(() => {
    if (recipient?.email && !to) setTo(recipient.email)
  }, [recipient?.email]) // eslint-disable-line react-hooks/exhaustive-deps

  async function write() {
    setState('writing')
    setError(null)
    try {
      const res = await draftApproach({ item, profile, onboarding })
      setText(res.text)
      setState(res.text ? 'done' : 'error')
      if (!res.text) setError('Annie came back empty. Try again.')
    } catch (err) {
      setState('error')
      setError(err.message || 'Could not write that draft.')
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Could not copy — select the text and copy it manually.')
    }
  }

  async function send() {
    setSending(true)
    setError(null)
    const res = await sendFromAnnie({ to: to.trim(), subject: subject.trim(), body: text })
    setSending(false)
    if (!res.sent) {
      setError(res.error || 'The message could not be sent.')
      return
    }
    setSent(true)
  }

  if (state === 'idle') {
    return (
      <button
        type="button"
        onClick={write}
        className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-navy hover:bg-page-bg transition-colors"
      >
        Draft an approach
      </button>
    )
  }

  if (state === 'writing') {
    return (
      <button type="button" disabled className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-gray-400">
        Annie is writing…
      </button>
    )
  }

  if (sent) {
    return (
      <div className="w-full mt-1">
        <div className="border border-emerald-200 bg-emerald-50 rounded-lg px-3.5 py-3">
          <p className="text-[13px] font-semibold text-emerald-800">Sent to {to}</p>
          <p className="text-[12px] text-gray-600 mt-0.5">
            It’s in your sent items, and Annie has logged it against the contact. A reply comes
            straight back to your inbox.
          </p>
        </div>
      </div>
    )
  }

  const canSend = emailReady && /.+@.+\..+/.test(to.trim()) && subject.trim() && text.trim()

  return (
    <div className="w-full mt-1">
      {state === 'error' ? (
        <div className="border border-dashed border-gray-200 rounded-lg px-3.5 py-3">
          <p className="text-[13px] text-gray-600">{error}</p>
          <button type="button" onClick={write} className="mt-2 text-[12.5px] font-bold text-navy">Try again</button>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg px-3.5 py-3">
          {emailReady && (
            <div className="pb-2.5 mb-2.5 border-b border-gray-100 space-y-1.5">
              <label className="flex items-center gap-2">
                <span className="text-[10.5px] uppercase tracking-wider text-gray-400 font-bold w-14 shrink-0">To</span>
                <input
                  type="email"
                  value={to}
                  onChange={e => setTo(e.target.value)}
                  placeholder={recipient?.name ? `${recipient.name}'s email address` : 'Their email address'}
                  className="flex-1 min-w-0 text-[13px] text-gray-800 bg-transparent focus:outline-none placeholder:text-gray-300"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="text-[10.5px] uppercase tracking-wider text-gray-400 font-bold w-14 shrink-0">Subject</span>
                <input
                  type="text"
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  className="flex-1 min-w-0 text-[13px] text-gray-800 bg-transparent focus:outline-none"
                />
              </label>
            </div>
          )}

          <textarea
            rows={Math.min(12, Math.max(5, text.split('\n').length + 1))}
            value={text}
            onChange={e => setText(e.target.value)}
            className="w-full text-[13px] leading-relaxed text-gray-800 bg-transparent resize-y focus:outline-none"
          />

          {error && <p className="text-[12px] text-red-600 mt-1">{error}</p>}

          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100 flex-wrap">
            {emailReady && (
              <button
                type="button"
                onClick={send}
                disabled={!canSend || sending}
                className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-navy text-gold hover:bg-navy-light transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            )}
            <button
              type="button"
              onClick={copy}
              className={`text-[12.5px] font-bold px-3 py-1.5 rounded-lg transition-colors ${
                emailReady
                  ? 'bg-white border border-gray-200 text-navy hover:bg-page-bg'
                  : 'bg-navy text-gold hover:bg-navy-light'
              }`}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={write}
              className="text-[12.5px] font-medium px-3 py-1.5 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
            >
              Rewrite
            </button>
            <span className="text-[11px] text-gray-400 ml-auto">
              {emailReady ? 'Sends from your own mailbox' : 'Edit it before you send it'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

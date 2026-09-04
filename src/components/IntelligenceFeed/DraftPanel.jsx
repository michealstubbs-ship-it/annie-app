// The draft, on request. See src/lib/stream/draftApproach.js for why the
// prompt is built around the way-in ladder rather than the signal alone.
import { useState } from 'react'
import { draftApproach } from '../../lib/stream/draftApproach'

export default function DraftPanel({ item, profile, onboarding }) {
  const [state, setState] = useState('idle') // idle | writing | done | error
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)

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

  return (
    <div className="w-full mt-1">
      {state === 'error' ? (
        <div className="border border-dashed border-gray-200 rounded-lg px-3.5 py-3">
          <p className="text-[13px] text-gray-600">{error}</p>
          <button type="button" onClick={write} className="mt-2 text-[12.5px] font-bold text-navy">Try again</button>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg px-3.5 py-3">
          <textarea
            rows={Math.min(12, Math.max(5, text.split('\n').length + 1))}
            value={text}
            onChange={e => setText(e.target.value)}
            className="w-full text-[13px] leading-relaxed text-gray-800 bg-transparent resize-y focus:outline-none"
          />
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={copy}
              className="text-[12.5px] font-bold px-3 py-1.5 rounded-lg bg-navy text-gold hover:bg-navy-light transition-colors"
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
            <span className="text-[11px] text-gray-400 ml-auto">Edit it before you send it</span>
          </div>
        </div>
      )}
    </div>
  )
}

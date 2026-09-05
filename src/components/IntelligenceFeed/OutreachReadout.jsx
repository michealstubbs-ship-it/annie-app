// What happened to the approaches you sent, at the top of the feed.
//
// Deliberately the quietest thing on the page: no chart, no percentage, no
// coloured badge, no progress bar. Every one of those turns a fact into a
// score, and a score invites the reader to feel something about it rather than
// act on it. Two or three sentences in the same voice as the cards below.
//
// It renders nothing at all — no empty state, no placeholder, no "connect your
// email to see this" — whenever there is no approach in the current month. See
// outreachReadout.js for why: the honest version of that empty state is "you
// have not done anything yet", and a row that says that every day is a row
// people learn to skip.
import { useState, useEffect } from 'react'
import { listRecentApproaches } from '../../lib/data/outreachApproaches'
import { outreachReadout } from '../../lib/outreachReadout'

export default function OutreachReadout({ userId }) {
  const [readout, setReadout] = useState(null)

  useEffect(() => {
    if (!userId) return undefined
    let live = true
    listRecentApproaches(userId).then(rows => {
      if (live) setReadout(outreachReadout(rows))
    })
    return () => { live = false }
  }, [userId])

  if (!readout) return null

  return (
    <div className="border border-gray-200 bg-white rounded-xl px-4 py-3 mb-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-400 font-bold">
        Your outreach
      </div>
      <p className="text-[13px] text-gray-700 mt-1 leading-relaxed max-w-[70ch]">
        {readout.sentences.map((sentence, i) => (
          // The first sentence carries the number the reader checks first, so
          // it leads; the rest sit at the same weight because none of them is
          // more important than the others.
          <span key={sentence} className={i === 0 ? 'font-semibold text-navy' : undefined}>
            {sentence}{i < readout.sentences.length - 1 ? ' ' : ''}
          </span>
        ))}
      </p>
    </div>
  )
}

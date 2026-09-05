// The rest of the network, in the order Annie would show it.
//
// Nothing the feed knows about is ever hidden — anything not in today's set is
// deferred to tomorrow, and this is where the deferred are visible. It exists
// so a short list can be read as a fact about the network rather than as
// software holding something back.
//
// Deliberately a list of names and nothing else: no state buttons, no drafting,
// no contact lookup. These are not today's work, and offering the day's actions
// against six hundred rows would rebuild the wall the day's set removes.
export default function QueuePanel({ rows = [] }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 bg-page-bg">
        <h3 className="font-bold text-navy">The whole queue</h3>
        <p className="text-gray-500 text-sm mt-0.5 max-w-[70ch]">
          Everyone your network turned up, in the order Annie would put them in front of you.
          Today&apos;s list is the top of this. Nothing here is dropped — it moves up as the list above is worked through.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-6 text-gray-500 text-sm">Nothing behind today&apos;s list.</p>
      ) : (
        <ol className="divide-y divide-gray-100">
          {rows.map((row, i) => (
            <li key={row.key} className="flex items-baseline gap-3 px-5 py-2.5 text-[13.5px]">
              <span className="text-[11.5px] text-gray-400 tabular-nums w-8 shrink-0">{i + 1}</span>
              <span className="font-semibold text-navy">{row.name}</span>
              <span className="text-[12.5px] text-gray-500 min-w-0 truncate">{row.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

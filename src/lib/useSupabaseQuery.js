import { useState, useEffect, useCallback } from 'react'

// A production-readiness audit (2026-08-22) found every list page
// (Contacts, Candidates, Companies, Jobs, Meetings, Pipeline, Tasks, ...)
// hand-rolling its own near-identical copy of the same three things: a
// `loading` flag, a `useEffect(() => { load() }, [user])` that refetches
// whenever the signed-in user changes, and a try/catch (sometimes present,
// sometimes not) around the actual Supabase call. This is that boilerplate,
// extracted once — it owns the *lifecycle* of a query (loading/error/reload),
// never the query itself. The actual Supabase calls belong in src/lib/data/
// (see contacts.js/candidates.js/companies.js for the pattern this pairs
// with): one file per table, so a schema change touches one place instead
// of every component that happens to read that table.
//
// `fetcher` is called once on mount and again whenever `deps` changes
// (typically `[user]`, matching every page's existing `useEffect(...,
// [user])`) — pass a closure that calls into src/lib/data, e.g.
// `useSupabaseQuery(() => listContacts(user.id), [user])`.
export function useSupabaseQuery(fetcher, deps = [], initialValue = []) {
  const [data, setData] = useState(initialValue)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await fetcher())
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
    // `deps` IS the caller-controlled dependency list, by design (mirrors
    // useEffect's own contract) — exhaustive-deps can't see into it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => { reload() }, [reload])

  return { data, loading, error, reload, setData }
}

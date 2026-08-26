import { supabase } from '../supabase'

// Every raw `bd_tasks` Supabase call (Tasks.jsx), in one place — same
// reasoning as contacts.js/candidates.js/companies.js/jobs.js. Named
// listTasksWithLinks rather than listBdTasks... to match the table's own
// name in code (bd_tasks) while reading naturally at the call site.

// 2026-08-24: bd_tasks is team-scoped — RLS already restricts every row to
// the caller's active team, so no client-side user_id filter on top of it.
// 2026-08-26 audit fix: throws on a Supabase error instead of silently
// falling back to `data || []` — see contacts.js's header comment for the
// full reasoning (same fix, same pattern, applied file-by-file).
export async function listTasksWithLinks(userId) {
  const { data, error } = await supabase
    .from('bd_tasks')
    .select('*, contacts(name, company), candidates(name)')
    .order('due_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data || []
}

export function createTask(row, userId) {
  return supabase.from('bd_tasks').insert({ ...row, user_id: userId })
}

export function updateTask(id, row) {
  return supabase.from('bd_tasks').update(row).eq('id', id)
}

export function deleteTask(id) {
  return supabase.from('bd_tasks').delete().eq('id', id)
}

import { supabase } from '../supabase'

// Every raw `bd_tasks` Supabase call (Tasks.jsx), in one place — same
// reasoning as contacts.js/candidates.js/companies.js/jobs.js. Named
// listTasksWithLinks rather than listBdTasks... to match the table's own
// name in code (bd_tasks) while reading naturally at the call site.

export async function listTasksWithLinks(userId) {
  const { data } = await supabase
    .from('bd_tasks')
    .select('*, contacts(name, company), candidates(name)')
    .eq('user_id', userId)
    .order('due_date', { ascending: true, nullsFirst: false })
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

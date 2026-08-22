// Fire-and-forget: tells Annie's shared company_contacts cache that a real
// customer just confirmed this signal's contact by adding it to their CRM —
// a stronger signal than Apollo's raw guess. See confirm-contact.js for what
// happens with it. Never blocks or breaks the actual addToCrm action if it
// fails; this is a nice-to-have confidence boost, not a required step.
import { supabase } from './supabase'

export async function confirmContact(signal) {
  if (!signal?.contact_name || !signal?.company_name) return
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const token = session?.access_token
    if (!token) return
    await fetch('/.netlify/functions/confirm-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ company: signal.company_name, titleKeywords: signal.title_keywords || [] }),
    })
  } catch {
    // Best-effort only — never let this block or break the real action.
  }
}

// Stable identity for a Today's Actions item — the id of the real record
// it's actually about, never its position or its content, so re-scoring the
// pools doesn't read as "a new item" just because a score shifted slightly.
// keyContext is an optional extra discriminator (e.g. a contact's
// last_contacted timestamp) for the three CRM categories that have no
// natural "done" flag on their underlying record — see resolve.js and
// useTodaysActions.js's markDone for why: it lets a contact that goes
// dormant, gets re-engaged, and later drifts dormant again be treated as a
// genuinely new occurrence rather than permanently suppressed by an old
// "mark done" left in todays_action_state.
//
// Unchanged from the old actionsEngine.js — this was already correct and
// already the one piece of identity logic every category agreed on, so it
// moves here as-is rather than being rewritten.
export function actionKey(action) {
  if (!action) return null
  if (action.signalId) return `signal:${action.signalId}`
  if (action.dealId) return `meeting:deal:${action.dealId}:${action.keyContext || ''}`
  if (action.contactId) return `${action.category}:contact:${action.contactId}:${action.keyContext || ''}`
  return null
}

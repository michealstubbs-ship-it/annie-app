// The one signal-type whitelist for Today's BD Actions — a single constant
// every pool that reads intelligence_signals imports from here, so adding
// or removing a type from Today's Actions is a one-line change in exactly
// one place, never a hunt across multiple pool files.
//
// 2026-08-24: narrowed from [funding, expansion, leadership_change,
// live_job] down to just [leadership_change, live_job], on the reasoning
// that only those two reliably come with an actual name attached. That
// narrowing shipped the SAME DAY verifyContactsAcrossFunctions/
// FUNCTION_TITLE_BUCKETS were built in scanShared.js specifically to give
// funding/expansion signals a real multi-person contact panel (3-4
// verified people across founder/product/engineering/commercial) instead
// of one named contact — so every funding/expansion signal scanned since
// has been fully enriched with that panel and then silently never shown
// anywhere in Today's Actions, because this whitelist still excluded the
// type before the mandatory-contact gate in sourcedPool.js/
// relationshipPool.js ever got a chance to check whether a panel existed.
// On a real account this cut the visible list to near-zero on quiet days
// (leadership_change/live_job are a small minority of what a scan finds)
// while 40+ fully-enriched funding/expansion signals sat unused in the
// Feed. 2026-08-27, confirmed with Michael: restored to all four —
// funding/expansion signals still go through the exact same mandatory-
// contact requirement every other type does (sourcedPool.js's
// isEligibleSourced), just satisfied by the panel instead of a single
// verified name, so nothing contact-less ever surfaces either way.
export const BD_ACTION_SIGNAL_TYPES = ['funding', 'expansion', 'leadership_change', 'live_job']

// The one signal-type whitelist for Today's BD Actions — a single constant
// every pool that reads intelligence_signals imports from here, so adding
// or removing a type from Today's Actions is a one-line change in exactly
// one place, never a hunt across multiple pool files.
//
// 2026-08-24: narrowed from [funding, expansion, leadership_change,
// live_job] down to just [leadership_change, live_job]. Michael's read as a
// working recruiter: these two are the ones that reliably come with an
// actual name attached — a leadership change names the person appointed, a
// live_job is a specific real open role — funding and expansion signals are
// real market intelligence but rarely have one obvious individual behind
// them (that's the entire reason verifyContactsAcrossFunctions in
// scanShared.js exists, as a multi-candidate fallback). Funding and
// expansion signals still exist and still get enriched exactly as before —
// they're just not pulled into Today's Actions any more. They stay fully
// visible in the Intelligence Feed, which reads intelligence_signals
// directly and has no dependency on this constant at all.
export const BD_ACTION_SIGNAL_TYPES = ['leadership_change', 'live_job']

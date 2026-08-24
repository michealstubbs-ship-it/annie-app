// Public API for Today's Actions' data layer. Everything a consumer needs —
// the five pool builders, the ranking function, stable identity, and the
// new state-join replacing the old cache/merge mechanism — without needing
// to know the internal file layout.
export { buildDormantPool, buildMeetingPool, buildRelationshipPool, buildNewClientPool, buildSourcedPool } from './pools/index.js'
export { selectDailyItems } from './selectDailyItems.js'
export { actionKey } from './actionKey.js'
export { resolveTodaysActions, markActionDone } from './resolve.js'
export { BD_ACTION_SIGNAL_TYPES } from './eligibility.js'

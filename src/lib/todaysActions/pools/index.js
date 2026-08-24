// One import point for every pool builder and its eligibility predicate —
// consumers (resolve.js, tests) never need to know these live in five
// separate files.
export { buildDormantPool, isEligibleDormant, scoreDormant } from './dormantPool.js'
export { buildMeetingPool, isEligibleMeeting, scoreMeeting } from './meetingPool.js'
export { buildRelationshipPool, isEligibleRelationship, scoreRelationship } from './relationshipPool.js'
export { buildNewClientPool, isEligibleNewClient, scoreNewClient } from './newClientPool.js'
export { buildSourcedPool, isEligibleSourced, scoreSourced } from './sourcedPool.js'

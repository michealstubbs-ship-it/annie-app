import { MIN_SCORE } from './shared.js'

// No fixed slot count per category, no ceiling on the total. Everything that
// clears the quality bar gets shown. Sorted by urgency first (is someone
// else racing you for this), then value (how good is it), so a
// fast-closing moderate opportunity always beats a high-value one that can
// comfortably wait. Unchanged from the old actionsEngine.js.
export function selectDailyItems(pools) {
  return Object.values(pools)
    .flat()
    .filter(item => item.score >= MIN_SCORE)
    .sort((a, b) => (b.urgency - a.urgency) || (b.score - a.score))
}

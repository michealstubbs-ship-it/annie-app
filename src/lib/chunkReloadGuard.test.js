// 2026-09-04, Michael ("I get the 'something went wrong' message a lot
// between different tabs"): the auto-reload guard used to only ever be SET
// (from ErrorBoundary.jsx's componentDidCatch), never cleared, so it
// degraded from "one silent auto-reload per stale-chunk incident" into "one
// silent auto-reload per browser tab, ever" — every stale-chunk hit after
// the first one (very real that day, given several back-to-back deploys
// while a tab stayed open) fell straight through to the visible "Something
// went wrong" card instead of getting its own chance to self-heal.
//
// This suite runs in vitest's 'node' environment (see vitest.config.js —
// no jsdom here), so there's no real sessionStorage global; a minimal
// in-memory stand-in is stubbed in for each test, same pattern this repo
// already uses for `vi.stubGlobal('fetch', ...)` elsewhere.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CHUNK_RELOAD_GUARD_KEY, hasAlreadyAttemptedChunkReload, markChunkReloadAttempted, clearChunkReloadGuard } from './chunkReloadGuard.js'

function makeFakeSessionStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
}

describe('chunkReloadGuard', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeFakeSessionStorage())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports no prior attempt when the flag was never set', () => {
    expect(hasAlreadyAttemptedChunkReload()).toBe(false)
  })

  it('reports a prior attempt once marked, matching ErrorBoundary\'s own reload-once branch', () => {
    markChunkReloadAttempted()
    expect(hasAlreadyAttemptedChunkReload()).toBe(true)
    expect(sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY)).toBe('1')
  })

  it('the full incident lifecycle: mark -> reports true -> app reboots and clears -> reports false again for a genuinely later incident', () => {
    markChunkReloadAttempted()
    expect(hasAlreadyAttemptedChunkReload()).toBe(true)
    clearChunkReloadGuard() // what main.jsx now does on every successful boot
    expect(hasAlreadyAttemptedChunkReload()).toBe(false)
  })

  it('clearChunkReloadGuard is a no-op, not a throw, when nothing was ever marked', () => {
    expect(() => clearChunkReloadGuard()).not.toThrow()
    expect(hasAlreadyAttemptedChunkReload()).toBe(false)
  })

  it('every function fails silently (and fails OPEN — never reports a false prior attempt) rather than crashing app boot if sessionStorage itself is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('storage disabled') },
      setItem: () => { throw new Error('storage disabled') },
      removeItem: () => { throw new Error('storage disabled') },
    })
    expect(() => markChunkReloadAttempted()).not.toThrow()
    expect(hasAlreadyAttemptedChunkReload()).toBe(false) // fails open: never silently blocks a real reload attempt
    expect(() => clearChunkReloadGuard()).not.toThrow()
  })
})

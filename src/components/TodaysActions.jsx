// 2026-08-24: This exact-filename module used to shadow the real component at
// ./TodaysActions/index.jsx — Node/Vite/Rollup resolve an exact file match
// over a same-named directory's index for the same import specifier, so
// `import TodaysActions from './TodaysActions'` was silently loading THIS
// file instead of the tested rewrite in the TodaysActions/ folder. The
// original code that used to live here has been preserved, unchanged, at
// ./TodaysActions.legacy.jsx for reference — it is no longer imported
// anywhere. This file is now just a re-export stub so that even if a build
// somehow still resolves this exact path, it forwards to the real,
// currently-shipping component rather than the stale one.
export { default } from './TodaysActions/index.jsx'

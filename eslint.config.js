// Added 2026-08-22 — this codebase had NO lint tooling at all before this,
// which is exactly the gap that let one real bug ship: an unchecked
// `.upsert()` error in stripe-webhook.js (see that file's own comments).
// Deliberately not wired into netlify.toml's build command / CI yet — this
// is a genuinely large existing codebase, and turning lint errors into a
// blocking gate on day one would fail the build on pre-existing code nobody
// has triaged, rather than on anything actually introduced going forward.
// Run `npm run lint` by hand for now; once the existing warnings are
// triaged, add `npm run lint` to .github/workflows/ci.yml as its own step.
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.netlify/**'],
  },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { window: 'readonly', document: 'readonly', console: 'readonly', process: 'readonly', fetch: 'readonly', Response: 'readonly', URL: 'readonly', navigator: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', FormData: 'readonly' },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      // react-plugin's jsx-uses-vars marks an import as "used" when it
      // appears in JSX — without it, core no-unused-vars false-positives on
      // every component imported for its JSX usage (e.g. <Login/>), since
      // plain ESLint doesn't understand JSX semantics on its own.
      'react/jsx-uses-vars': 'warn',
      'react/jsx-uses-react': 'warn', // marks `import React` as used — this codebase's JSX doesn't need it in scope (new transform), but no-unused-vars can't know that without this
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The exact class of bug that already shipped once — a Supabase
      // write's { error } destructured and never checked.
      'no-unused-expressions': 'warn',
    },
  },
]

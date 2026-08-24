/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#0d1b3e',
        gold: '#c9a84c',
        'navy-light': '#1a2d5a',
        'page-bg': '#f5f7fc',
        // #c9a84c on white measures ~2.3:1 contrast — well under WCAG AA's
        // 4.5:1 floor for text. Fine for gold-on-navy (badges, the logo
        // wordmark), never fine for gold text ON a light background. Use
        // gold-ink for any link/interactive text sitting on white or
        // page-bg — links, edit actions, "Sign up free" on the login card.
        'gold-ink': '#8a6f1f',
        // Admin operator dashboard (Insights "Overview" tab, 2026-08-24)
        // chart colors — the dataviz skill's validated reference palette,
        // kept separate from navy/gold brand chrome on purpose: navy/gold
        // stay the app's identity, these are reserved for chart series and
        // status so a status color never gets reused as "series 4" and
        // vice versa. series-1/2/3 are the first three categorical slots
        // (validated all-pairs colorblind-safe for exactly a 3-way split
        // like the tier breakdown); status-* are the fixed status palette,
        // never themed, never reused for anything but state.
        'series-1': '#2a78d6',
        'series-2': '#eb6834',
        'series-3': '#1baf7a',
        'status-good': '#0ca30c',
        'status-warning': '#fab219',
        'status-serious': '#ec835a',
        'status-critical': '#d03b3b',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
